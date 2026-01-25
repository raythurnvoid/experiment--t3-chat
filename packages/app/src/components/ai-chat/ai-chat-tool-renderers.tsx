/* eslint-disable react-refresh/only-export-components */
import { CopyIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge.tsx";
import { Actions, Action } from "@/components/ai-elements/actions.tsx";
import { CodeBlock } from "@/components/ai-elements/code-block.tsx";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool.tsx";
import type { AiChatController } from "@/lib/ai-chat/use-ai-chat-controller.tsx";
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
} from "@/lib/ai-chat.ts";
import type { CreateArtifactArgs } from "@/types/artifact-schemas.ts";
import { CreateArtifactToolUI } from "@/components/create-artifact-tool-ui.tsx";

type ai_chat_ToolState = "input-streaming" | "input-available" | "output-available" | "output-error";
const ai_chat_tool_states = new Set<ai_chat_ToolState>([
	"input-streaming",
	"input-available",
	"output-available",
	"output-error",
]);

type ai_chat_ToolPart = {
	type: string;
	toolName?: string | undefined;
	toolCallId?: string | undefined;
	state?: ai_chat_ToolState | string | undefined;
	input?: unknown;
	output?: unknown;
	errorText?: string | undefined;
};

type ai_chat_ToolRenderActions = {
	addToolOutput: AiChatController["addToolOutput"];
	resumeStream: AiChatController["resumeStream"];
	stop: AiChatController["stop"];
};

type ai_chat_RenderToolPartOptions = {
	part: ai_chat_ToolPart;
	messageId: string;
	artifactId?: string | undefined;
	actions: ai_chat_ToolRenderActions;
};

const ai_chat_tool_state_from_part = (part: ai_chat_ToolPart): ai_chat_ToolState => {
	if (part.state && ai_chat_tool_states.has(part.state as ai_chat_ToolState)) {
		return part.state as ai_chat_ToolState;
	}

	if (part.errorText) {
		return "output-error";
	}

	if (part.output !== undefined) {
		return "output-available";
	}

	if (part.input !== undefined) {
		return "input-available";
	}

	return "input-streaming";
};

const ai_chat_tool_name_from_part = (part: ai_chat_ToolPart) => {
	if (part.type === "dynamic-tool") {
		return part.toolName ?? null;
	}

	if (part.type.startsWith("tool-")) {
		return part.type.slice("tool-".length);
	}

	return null;
};

const handleCopyOutput = (text?: string) => {
	if (text) {
		navigator.clipboard.writeText(text).catch(console.error);
	}
};

function ToolMetaHeader(props: { metadata: Record<string, unknown> }) {
	const { metadata } = props;
	return (
		<div className="AppAiChat-tool-meta-chips flex flex-wrap gap-1">
			{"title" in metadata && metadata.title ? (
				<Badge variant="secondary" className="text-xs">
					title: {String(metadata.title)}
				</Badge>
			) : null}
			{"count" in metadata && metadata.count !== undefined ? (
				<Badge variant="secondary" className="text-xs">
					count: {String(metadata.count)}
				</Badge>
			) : null}
			{"matches" in metadata && metadata.matches !== undefined ? (
				<Badge variant="secondary" className="text-xs">
					matches: {String(metadata.matches)}
				</Badge>
			) : null}
			{"truncated" in metadata && metadata.truncated !== undefined ? (
				<Badge variant="secondary" className="text-xs">
					truncated: {String(metadata.truncated)}
				</Badge>
			) : null}
			{"preview" in metadata && metadata.preview ? (
				<Badge variant="secondary" className="text-xs">
					preview: {String(metadata.preview).slice(0, 30)}...
				</Badge>
			) : null}
		</div>
	);
}

function ReadPageToolUi(props: {
	args: ai_chat_tool_create_read_page_ToolInput | undefined;
	result: ai_chat_tool_create_read_page_ToolOutput | undefined;
	toolState: ai_chat_ToolState;
	errorText?: string | undefined;
}) {
	const { args, result, toolState, errorText } = props;
	return (
		<Tool defaultOpen={false} className="AppAiChat-read-page-tool">
			<ToolHeader type="tool-read_page" state={toolState} />
			<ToolContent>
				<div className="AppAiChat-tool-meta-row flex items-center justify-between px-4 pt-3">
					<ToolMetaHeader metadata={result?.metadata || {}} />
					<Actions className="AppAiChat-tool-actions">
						<Action tooltip="Copy result" label="Copy result" onClick={() => handleCopyOutput(result?.output)}>
							<CopyIcon className="size-4" />
						</Action>
					</Actions>
				</div>
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={errorText ?? (result as { error?: string } | undefined)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

function ListPagesToolUi(props: {
	args: ai_chat_tool_create_list_pages_ToolInput | undefined;
	result: ai_chat_tool_create_list_pages_ToolOutput | undefined;
	toolState: ai_chat_ToolState;
	errorText?: string | undefined;
}) {
	const { args, result, toolState, errorText } = props;
	return (
		<Tool defaultOpen={false} className="AppAiChat-list-pages-tool">
			<ToolHeader type="tool-list_pages" state={toolState} />
			<ToolContent>
				<div className="AppAiChat-tool-meta-row flex items-center justify-between px-4 pt-3">
					<ToolMetaHeader metadata={result?.metadata || {}} />
					<Actions className="AppAiChat-tool-actions">
						<Action tooltip="Copy result" label="Copy result" onClick={() => handleCopyOutput(result?.output)}>
							<CopyIcon className="size-4" />
						</Action>
					</Actions>
				</div>
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={errorText ?? (result as { error?: string } | undefined)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

function GlobPagesToolUi(props: {
	args: ai_chat_tool_create_glob_pages_ToolInput | undefined;
	result: ai_chat_tool_create_glob_pages_ToolOutput | undefined;
	toolState: ai_chat_ToolState;
	errorText?: string | undefined;
}) {
	const { args, result, toolState, errorText } = props;
	return (
		<Tool defaultOpen={false} className="AppAiChat-glob-pages-tool">
			<ToolHeader type="tool-glob_pages" state={toolState} />
			<ToolContent>
				<div className="AppAiChat-tool-meta-row flex items-center justify-between px-4 pt-3">
					<ToolMetaHeader metadata={result?.metadata || {}} />
					<Actions className="AppAiChat-tool-actions">
						<Action tooltip="Copy result" label="Copy result" onClick={() => handleCopyOutput(result?.output)}>
							<CopyIcon className="size-4" />
						</Action>
					</Actions>
				</div>
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={errorText ?? (result as { error?: string } | undefined)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

function GrepPagesToolUi(props: {
	args: ai_chat_tool_create_grep_pages_ToolInput | undefined;
	result: ai_chat_tool_create_grep_pages_ToolOutput | undefined;
	toolState: ai_chat_ToolState;
	errorText?: string | undefined;
}) {
	const { args, result, toolState, errorText } = props;
	return (
		<Tool defaultOpen={false} className="AppAiChat-grep-pages-tool">
			<ToolHeader type="tool-grep_pages" state={toolState} />
			<ToolContent>
				<div className="AppAiChat-tool-meta-row flex items-center justify-between px-4 pt-3">
					<ToolMetaHeader metadata={result?.metadata || {}} />
					<Actions className="AppAiChat-tool-actions">
						<Action tooltip="Copy result" label="Copy result" onClick={() => handleCopyOutput(result?.output)}>
							<CopyIcon className="size-4" />
						</Action>
					</Actions>
				</div>
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={errorText ?? (result as { error?: string } | undefined)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

function TextSearchPagesToolUi(props: {
	args: ai_chat_tool_create_text_search_pages_ToolInput | undefined;
	result: ai_chat_tool_create_text_search_pages_ToolOutput | undefined;
	toolState: ai_chat_ToolState;
	errorText?: string | undefined;
}) {
	const { args, result, toolState, errorText } = props;
	return (
		<Tool defaultOpen={false} className="AppAiChat-text-search-pages-tool">
			<ToolHeader type="tool-text_search_pages" state={toolState} />
			<ToolContent>
				<div className="AppAiChat-tool-meta-row flex items-center justify-between px-4 pt-3">
					<ToolMetaHeader metadata={result?.metadata || {}} />
					<Actions className="AppAiChat-tool-actions">
						<Action tooltip="Copy result" label="Copy result" onClick={() => handleCopyOutput(result?.output)}>
							<CopyIcon className="size-4" />
						</Action>
					</Actions>
				</div>
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={errorText ?? (result as { error?: string } | undefined)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

function WritePageToolUi(props: {
	args: ai_chat_tool_create_write_page_ToolInput | undefined;
	result: ai_chat_tool_create_write_page_ToolOutput | undefined;
	toolState: ai_chat_ToolState;
	errorText?: string | undefined;
}) {
	const { args, result, toolState, errorText } = props;
	return (
		<Tool defaultOpen={false} className="AppAiChat-write-page-tool">
			<ToolHeader type="tool-write_page" state={toolState} />
			<ToolContent>
				<div className="AppAiChat-tool-meta-row flex items-center justify-between px-4 pt-3">
					<ToolMetaHeader metadata={result?.metadata || {}} />
					<Actions className="AppAiChat-tool-actions">
						<Action tooltip="Copy result" label="Copy result" onClick={() => handleCopyOutput(result?.output)}>
							<CopyIcon className="size-4" />
						</Action>
					</Actions>
				</div>
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={
						result?.metadata?.diff ? (
							<CodeBlock code={result.metadata.diff} language="diff" />
						) : result?.output ? (
							<CodeBlock code={result.output} language="text" />
						) : null
					}
					errorText={errorText ?? (result as { error?: string } | undefined)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

function EditPageToolUi(props: {
	args: ai_chat_tool_create_edit_page_ToolInput | undefined;
	result: ai_chat_tool_create_edit_page_ToolOutput | undefined;
	toolState: ai_chat_ToolState;
	errorText?: string | undefined;
}) {
	const { args, result, toolState, errorText } = props;
	return (
		<Tool defaultOpen={false} className="AppAiChat-edit-page-tool">
			<ToolHeader type="tool-edit_page" state={toolState} />
			<ToolContent>
				<div className="AppAiChat-tool-meta-row flex items-center justify-between px-4 pt-3">
					<ToolMetaHeader metadata={result?.metadata || {}} />
					<Actions className="AppAiChat-tool-actions">
						<Action tooltip="Copy result" label="Copy result" onClick={() => handleCopyOutput(result?.output)}>
							<CopyIcon className="size-4" />
						</Action>
					</Actions>
				</div>
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={
						result?.metadata?.diff ? (
							<CodeBlock code={result.metadata.diff} language="diff" />
						) : result?.output ? (
							<CodeBlock code={result.output} language="text" />
						) : null
					}
					errorText={errorText ?? (result as { error?: string } | undefined)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

function UnknownToolUi(props: {
	toolName: string;
	args: unknown;
	result: unknown;
	toolState: ai_chat_ToolState;
	errorText?: string | undefined;
}) {
	const { toolName, args, result, toolState, errorText } = props;
	return (
		<Tool defaultOpen={false} className="AppAiChat-unknown-tool">
			<ToolHeader type={`tool-${toolName}`} state={toolState} />
			<ToolContent>
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={result ? <CodeBlock code={JSON.stringify(result, null, 2)} language="json" /> : null}
					errorText={errorText}
				/>
			</ToolContent>
		</Tool>
	);
}

export const ai_chat_render_tool_part = (options: ai_chat_RenderToolPartOptions) => {
	const { part, artifactId } = options;
	const toolName = ai_chat_tool_name_from_part(part);
	if (!toolName) {
		return null;
	}

	const toolState = ai_chat_tool_state_from_part(part);
	const args = part.input;
	const result = part.output;
	const errorText = part.errorText;

	switch (toolName) {
		case "create_artifact":
			return (
				<CreateArtifactToolUI
					args={args as CreateArtifactArgs | undefined}
					toolState={toolState}
					artifactId={artifactId}
					errorText={errorText}
				/>
			);
		case "read_page":
			return (
				<ReadPageToolUi
					args={args as ai_chat_tool_create_read_page_ToolInput | undefined}
					result={result as ai_chat_tool_create_read_page_ToolOutput | undefined}
					toolState={toolState}
					errorText={errorText}
				/>
			);
		case "list_pages":
			return (
				<ListPagesToolUi
					args={args as ai_chat_tool_create_list_pages_ToolInput | undefined}
					result={result as ai_chat_tool_create_list_pages_ToolOutput | undefined}
					toolState={toolState}
					errorText={errorText}
				/>
			);
		case "glob_pages":
			return (
				<GlobPagesToolUi
					args={args as ai_chat_tool_create_glob_pages_ToolInput | undefined}
					result={result as ai_chat_tool_create_glob_pages_ToolOutput | undefined}
					toolState={toolState}
					errorText={errorText}
				/>
			);
		case "grep_pages":
			return (
				<GrepPagesToolUi
					args={args as ai_chat_tool_create_grep_pages_ToolInput | undefined}
					result={result as ai_chat_tool_create_grep_pages_ToolOutput | undefined}
					toolState={toolState}
					errorText={errorText}
				/>
			);
		case "text_search_pages":
			return (
				<TextSearchPagesToolUi
					args={args as ai_chat_tool_create_text_search_pages_ToolInput | undefined}
					result={result as ai_chat_tool_create_text_search_pages_ToolOutput | undefined}
					toolState={toolState}
					errorText={errorText}
				/>
			);
		case "write_page":
			return (
				<WritePageToolUi
					args={args as ai_chat_tool_create_write_page_ToolInput | undefined}
					result={result as ai_chat_tool_create_write_page_ToolOutput | undefined}
					toolState={toolState}
					errorText={errorText}
				/>
			);
		case "edit_page":
			return (
				<EditPageToolUi
					args={args as ai_chat_tool_create_edit_page_ToolInput | undefined}
					result={result as ai_chat_tool_create_edit_page_ToolOutput | undefined}
					toolState={toolState}
					errorText={errorText}
				/>
			);
		default:
			return (
				<UnknownToolUi
					toolName={toolName}
					args={args}
					result={result}
					toolState={toolState}
					errorText={errorText}
				/>
			);
	}
};
