import "./app-ai-chat.css";
import { makeAssistantToolUI, useMessage, useMessagePartRuntime, useThreadListItemRuntime } from "@assistant-ui/react";
import type { ToolCallContentPartProps } from "@assistant-ui/react";
import { CopyIcon, FileText, AlertCircle, Loader2 } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { Badge } from "./ui/badge.tsx";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "./ai-elements/tool.tsx";
import { Actions, Action } from "./ai-elements/actions.tsx";
import { CodeBlock } from "./ai-elements/code-block.tsx";
import { parseCreateArtifactArgs, type CreateArtifactArgs } from "../types/artifact-schemas.ts";
import { Thread } from "@/components/assistant-ui/thread.tsx";
import { useEffect } from "react";
import { global_event_ai_chat_open_canvas, global_event_ai_chat_open_canvas_by_path } from "../lib/global-events.tsx";
import type {
	ai_tool_create_read_page_ToolInput,
	ai_tool_create_read_page_ToolOutput,
	ai_tool_create_list_pages_ToolInput,
	ai_tool_create_list_pages_ToolOutput,
	ai_tool_create_glob_pages_ToolInput,
	ai_tool_create_glob_pages_ToolOutput,
	ai_tool_create_grep_pages_ToolInput,
	ai_tool_create_grep_pages_ToolOutput,
	ai_tool_create_text_search_pages_ToolInput,
	ai_tool_create_text_search_pages_ToolOutput,
	ai_tool_create_write_page_ToolInput,
	ai_tool_create_write_page_ToolOutput,
	ai_tool_create_edit_page_ToolInput,
	ai_tool_create_edit_page_ToolOutput,
} from "../lib/ai-chat.ts";

function mapStatusToToolState(status: {
	type: string;
}): "input-streaming" | "input-available" | "output-available" | "output-error" {
	switch (status.type) {
		case "running":
			return "input-available";
		case "complete":
			return "output-available";
		default:
			return "input-streaming";
	}
}

const handleCopyOutput = (text?: string) => {
	if (text) {
		navigator.clipboard.writeText(text).catch(console.error);
	}
};

function ToolMetaHeader(props: { metadata: Record<string, any> }) {
	const { metadata } = props;
	return (
		<div className="AppAiChat-tool-meta-chips flex flex-wrap gap-1">
			{metadata.title && (
				<Badge variant="secondary" className="text-xs">
					title: {metadata.title}
				</Badge>
			)}
			{metadata.count !== undefined && (
				<Badge variant="secondary" className="text-xs">
					count: {metadata.count}
				</Badge>
			)}
			{metadata.matches !== undefined && (
				<Badge variant="secondary" className="text-xs">
					matches: {metadata.matches}
				</Badge>
			)}
			{metadata.truncated !== undefined && (
				<Badge variant="secondary" className="text-xs">
					truncated: {String(metadata.truncated)}
				</Badge>
			)}
			{metadata.preview && (
				<Badge variant="secondary" className="text-xs">
					preview: {metadata.preview.slice(0, 30)}...
				</Badge>
			)}
		</div>
	);
}

function CreateArtifactToolUiComponent(props: ToolCallContentPartProps<CreateArtifactArgs, void>) {
	const { args, status } = props;
	// Safely parse arguments using Zod
	const argsParseResult = parseCreateArtifactArgs(args);
	const message = useMessage();
	const artifactId = (message.metadata.unstable_data?.[0] as any)?.id;

	// Show loading state while tool is executing
	if (status.type === "running") {
		return (
			<div className="AppAiChat-create-artifact-loading flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
				<Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />
				<div className="flex flex-col">
					<span className="text-sm text-blue-800 dark:text-blue-200">Generating artifact content...</span>
					{argsParseResult.success && (
						<span className="text-xs text-blue-600 dark:text-blue-400">
							{argsParseResult.data.title || "Untitled Document"}
						</span>
					)}
				</div>
			</div>
		);
	}

	// Show error state if parsing failed
	if (status.type === "complete" && argsParseResult.error) {
		return (
			<div className="AppAiChat-create-artifact-error flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950">
				<AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
				<span className="text-sm text-red-800 dark:text-red-200">
					Invalid artifact arguments: {argsParseResult.error.message}
				</span>
			</div>
		);
	}

	// Show success state (no external actions)
	if (status.type === "complete" && argsParseResult.success) {
		return (
			<div className="AppAiChat-create-artifact-success flex items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950">
				<div className="flex items-center gap-2">
					<FileText className="h-4 w-4 text-green-600 dark:text-green-400" />
					<div className="flex flex-col">
						<span className="text-sm font-medium text-green-800 dark:text-green-200">
							Created: {argsParseResult.data.title || "Document"}
						</span>
						{artifactId && <span className="text-xs text-green-600 dark:text-green-400">ID: {artifactId}</span>}
					</div>
				</div>
			</div>
		);
	}

	// Default processing state
	return (
		<div className="AppAiChat-create-artifact-processing flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900">
			<FileText className="h-4 w-4 text-gray-600 dark:text-gray-400" />
			<span className="text-sm text-gray-700 dark:text-gray-300">Processing artifact...</span>
		</div>
	);
}

const CreateArtifactToolUi = makeAssistantToolUI<CreateArtifactArgs, void>({
	toolName: "create_artifact",
	render: CreateArtifactToolUiComponent,
});

function ReadPageToolUiComponent(
	props: ToolCallContentPartProps<ai_tool_create_read_page_ToolInput, ai_tool_create_read_page_ToolOutput>,
) {
	const { args, result, status } = props;
	const toolState = mapStatusToToolState(status);

	const handleOpenCanvas = () => {
		global_event_ai_chat_open_canvas_by_path.dispatch({ path: args.path });
	};

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
						<Action tooltip="Open canvas" label="Open canvas" onClick={handleOpenCanvas}>
							<FileText className="size-4" />
						</Action>
					</Actions>
				</div>
				<ToolInput input={args} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={(result as any)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

const ReadPageToolUI = makeAssistantToolUI({
	toolName: "read_page",
	render: ReadPageToolUiComponent,
});

function ListPagesToolUiComponent(
	props: ToolCallContentPartProps<ai_tool_create_list_pages_ToolInput, ai_tool_create_list_pages_ToolOutput>,
) {
	const { args, result, status } = props;
	const toolState = mapStatusToToolState(status);

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
				<ToolInput input={args} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={(result as any)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

const ListPagesToolUi = makeAssistantToolUI({
	toolName: "list_pages",
	render: ListPagesToolUiComponent,
});

function GlobPagesToolUiComponent(
	props: ToolCallContentPartProps<ai_tool_create_glob_pages_ToolInput, ai_tool_create_glob_pages_ToolOutput>,
) {
	const { args, result, status } = props;
	const toolState = mapStatusToToolState(status);

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
				<ToolInput input={args} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={(result as any)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

const GlobPagesToolUi = makeAssistantToolUI({
	toolName: "glob_pages",
	render: GlobPagesToolUiComponent,
});

function GrepPagesToolUiComponent(
	props: ToolCallContentPartProps<ai_tool_create_grep_pages_ToolInput, ai_tool_create_grep_pages_ToolOutput>,
) {
	const { args, result, status } = props;
	const toolState = mapStatusToToolState(status);

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
				<ToolInput input={args} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={(result as any)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

const GrepPagesToolUi = makeAssistantToolUI({
	toolName: "grep_pages",
	render: GrepPagesToolUiComponent,
});

function TextSearchPagesToolUiComponent(
	props: ToolCallContentPartProps<
		ai_tool_create_text_search_pages_ToolInput,
		ai_tool_create_text_search_pages_ToolOutput
	>,
) {
	const { args, result, status } = props;
	const toolState = mapStatusToToolState(status);

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
				<ToolInput input={args} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={(result as any)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

const TextSearchPagesToolUi = makeAssistantToolUI({
	toolName: "text_search_pages",
	render: TextSearchPagesToolUiComponent,
});

function WritePageToolUiComponent(
	props: ToolCallContentPartProps<ai_tool_create_write_page_ToolInput, ai_tool_create_write_page_ToolOutput>,
) {
	const { args, result, status } = props;
	const threadListItemRuntime = useThreadListItemRuntime();
	const partRuntime = useMessagePartRuntime();

	// Handle tool complete
	useEffect(() => {
		let handled = false;

		if (status.type !== "complete") {
			const cleanup = partRuntime.subscribe(() => {
				if (handled) return;
				const state = partRuntime.getState();
				if (state.type === "tool-call" && state.status.type === "complete" && !(state.result as any)?.error) {
					handled = true;

					if (!state.result) return;
					const threadId = threadListItemRuntime.getState().remoteId;
					if (!threadId) return;

					const result = state.result as ai_tool_create_write_page_ToolOutput;
					const args = state.args as ai_tool_create_write_page_ToolInput;

					const pageId = result.metadata.pageId;
					if (!pageId) {
						console.warn("write_page: page id missing in tool result for path", args.path);
						return;
					}

					// Existing page preview: open diff mode, seed modified with proposed content
					global_event_ai_chat_open_canvas.dispatch({ pageId, mode: "diff", modifiedContent: args.content, threadId });
				}
			});

			return cleanup;
		}
	}, [status]);

	const handleOpenCanvas = () => {
		global_event_ai_chat_open_canvas_by_path.dispatch({ path: args.path });
	};

	return (
		<Tool defaultOpen={false} className="AppAiChat-write-page-tool">
			<ToolHeader type="tool-write_page" state={mapStatusToToolState(status)} />
			<ToolContent>
				<div className="AppAiChat-tool-meta-row flex items-center justify-between px-4 pt-3">
					<ToolMetaHeader metadata={result?.metadata || {}} />
					<Actions className="AppAiChat-tool-actions">
						<Action tooltip="Copy result" label="Copy result" onClick={() => handleCopyOutput(result?.output)}>
							<CopyIcon className="size-4" />
						</Action>
						<Action tooltip="Open canvas" label="Open canvas" onClick={handleOpenCanvas}>
							<FileText className="size-4" />
						</Action>
					</Actions>
				</div>
				<ToolInput input={args} />
				<ToolOutput
					output={
						result?.metadata?.diff ? (
							<CodeBlock code={result.metadata.diff} language="diff" />
						) : result?.output ? (
							<CodeBlock code={result.output} language="text" />
						) : null
					}
					errorText={(result as any)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

const WritePageToolUi = makeAssistantToolUI({
	toolName: "write_page",
	render: WritePageToolUiComponent,
});

function EditPageToolUiComponent(
	props: ToolCallContentPartProps<ai_tool_create_edit_page_ToolInput, ai_tool_create_edit_page_ToolOutput>,
) {
	const { args, result, status } = props;
	const threadListItemRuntime = useThreadListItemRuntime();
	const partRuntime = useMessagePartRuntime();

	useEffect(() => {
		let handled = false;
		if (status.type !== "complete") {
			const cleanup = partRuntime.subscribe(() => {
				if (handled) return;
				const state = partRuntime.getState();
				if (state.type === "tool-call" && state.status.type === "complete" && !(state.result as any)?.error) {
					handled = true;
					if (!state.result) return;
					const threadId = threadListItemRuntime.getState().remoteId;
					if (!threadId) return;
					const result = state.result as ai_tool_create_edit_page_ToolOutput;
					const pageId = result.metadata.pageId;
					if (!pageId) return;
					global_event_ai_chat_open_canvas.dispatch({
						pageId,
						mode: "diff",
						threadId,
						modifiedContent: result.metadata.modifiedContent,
					});
				}
			});
			return cleanup;
		}
	}, [status]);

	const handleOpenCanvas = () => {
		global_event_ai_chat_open_canvas_by_path.dispatch({ path: args.path });
	};

	return (
		<Tool defaultOpen={false} className="AppAiChat-edit-page-tool">
			<ToolHeader type="tool-edit_page" state={mapStatusToToolState(status)} />
			<ToolContent>
				<div className="AppAiChat-tool-meta-row flex items-center justify-between px-4 pt-3">
					<ToolMetaHeader metadata={result?.metadata || {}} />
					<Actions className="AppAiChat-tool-actions">
						<Action tooltip="Copy result" label="Copy result" onClick={() => handleCopyOutput(result?.output)}>
							<CopyIcon className="size-4" />
						</Action>
						<Action tooltip="Open canvas" label="Open canvas" onClick={handleOpenCanvas}>
							<FileText className="size-4" />
						</Action>
					</Actions>
				</div>
				<ToolInput input={args} />
				<ToolOutput
					output={
						result?.metadata?.diff ? (
							<CodeBlock code={result.metadata.diff} language="diff" />
						) : result?.output ? (
							<CodeBlock code={result.output} language="text" />
						) : null
					}
					errorText={(result as any)?.error}
				/>
			</ToolContent>
		</Tool>
	);
}

const EditPageToolUi = makeAssistantToolUI({
	toolName: "edit_page",
	render: EditPageToolUiComponent,
});

export interface AppAiChat_Props {
	className?: string;
}

export function AppAiChat(props: AppAiChat_Props) {
	const { className } = props;

	return (
		<div className={cn("AppAiChat", className)}>
			<Thread />
			<CreateArtifactToolUi />
			<ReadPageToolUI />
			<ListPagesToolUi />
			<GlobPagesToolUi />
			<GrepPagesToolUi />
			<TextSearchPagesToolUi />
			<WritePageToolUi />
			<EditPageToolUi />
		</div>
	);
}
