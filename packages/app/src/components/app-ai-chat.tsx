import "./app-ai-chat.css";
import { makeAssistantToolUI, useMessage, useMessagePartRuntime } from "@assistant-ui/react";
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
import { global_event_ai_chat_open_canvas } from "../lib/global-events.tsx";
import { useLiveRef } from "../hooks/utils-hooks.ts";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api.js";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../lib/ai-chat.ts";

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

type ReadPageToolUi_Args = {
	path: string;
	offset?: number;
	limit?: number;
};

type ReadPageToolUi_Result = {
	title: string;
	output: string;
	metadata: {
		preview: string;
	};
};

function ReadPageToolUiComponent(props: ToolCallContentPartProps<ReadPageToolUi_Args, ReadPageToolUi_Result>) {
	const { args, result, status } = props;
	const toolState = mapStatusToToolState(status);

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
				<ToolInput input={args} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={(result as any)?.errorText}
				/>
			</ToolContent>
		</Tool>
	);
}

const ReadPageToolUI = makeAssistantToolUI<ReadPageToolUi_Args, ReadPageToolUi_Result>({
	toolName: "read_page",
	render: ReadPageToolUiComponent,
});

type ListPagesToolUi_Args = {
	path?: string;
	ignore?: string[];
	maxDepth?: number;
	limit?: number;
};

type ListPagesToolUi_Result = {
	title: string;
	metadata: {
		count: number;
		truncated: boolean;
	};
	output: string;
};

function ListPagesToolUiComponent(props: ToolCallContentPartProps<ListPagesToolUi_Args, ListPagesToolUi_Result>) {
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
					errorText={(result as any)?.errorText}
				/>
			</ToolContent>
		</Tool>
	);
}

const ListPagesToolUi = makeAssistantToolUI<ListPagesToolUi_Args, ListPagesToolUi_Result>({
	toolName: "list_pages",
	render: ListPagesToolUiComponent,
});

type GlobPagesToolUi_Args = {
	pattern: string;
	path?: string;
	limit?: number;
};

type GlobPagesToolUi_Result = {
	title: string;
	metadata: {
		count: number;
		truncated: boolean;
	};
	output: string;
};

function GlobPagesToolUiComponent(props: ToolCallContentPartProps<GlobPagesToolUi_Args, GlobPagesToolUi_Result>) {
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
					errorText={(result as any)?.errorText}
				/>
			</ToolContent>
		</Tool>
	);
}

const GlobPagesToolUi = makeAssistantToolUI<GlobPagesToolUi_Args, GlobPagesToolUi_Result>({
	toolName: "glob_pages",
	render: GlobPagesToolUiComponent,
});

type GrepPagesToolUi_Args = {
	pattern: string;
	path?: string;
	include?: string;
	maxDepth?: number;
	limit?: number;
};

type GrepPagesToolUi_Result = {
	title: string;
	metadata: {
		matches: number;
		truncated: boolean;
	};
	output: string;
};

function GrepPagesToolUiComponent(props: ToolCallContentPartProps<GrepPagesToolUi_Args, GrepPagesToolUi_Result>) {
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
					errorText={(result as any)?.errorText}
				/>
			</ToolContent>
		</Tool>
	);
}

const GrepPagesToolUi = makeAssistantToolUI<GrepPagesToolUi_Args, GrepPagesToolUi_Result>({
	toolName: "grep_pages",
	render: GrepPagesToolUiComponent,
});

type TextSearchToolUi_Args = {
	query: string;
	limit?: number;
};

type TextSearchToolUi_Result = {
	title: string;
	metadata: {
		matches: number;
	};
	output: string;
};

function TextSearchPagesToolUiComponent(
	props: ToolCallContentPartProps<TextSearchToolUi_Args, TextSearchToolUi_Result>,
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
					errorText={(result as any)?.errorText}
				/>
			</ToolContent>
		</Tool>
	);
}

const TextSearchPagesToolUi = makeAssistantToolUI<TextSearchToolUi_Args, TextSearchToolUi_Result>({
	toolName: "text_search_pages",
	render: TextSearchPagesToolUiComponent,
});

type WritePageToolUi_Args = {
	path: string;
	content: string;
	overwrite?: boolean;
	confirm?: boolean;
};

type WritePageToolUi_Result = {
	title: string;
	output: string;
	metadata: {
		exists: boolean;
		applied: boolean;
		preview?: string;
		diff?: string;
		page_id: string;
	};
};

function WritePageToolUiComponent(props: ToolCallContentPartProps<WritePageToolUi_Args, WritePageToolUi_Result>) {
	const { args, result, status } = props;

	const toolState = mapStatusToToolState(status);
	const partRuntime = useMessagePartRuntime();
	const updateAndBroadcast = useMutation(api.ai_docs_temp.update_page_and_broadcast);

	const handleToolComplete = useLiveRef(async () => {
		if (!result) return;

		const pageId = result.metadata.page_id;
		if (!pageId) {
			console.warn("write_page: page id missing in tool result for path", args.path);
			return;
		}

		if (result.metadata.applied === true) {
			// Newly created file: write & broadcast like before, then open canvas
			try {
				await updateAndBroadcast({
					workspace_id: ai_chat_HARDCODED_ORG_ID,
					project_id: ai_chat_HARDCODED_PROJECT_ID,
					page_id: pageId,
					text_content: args.content,
				});
			} catch (e) {
				console.error("Failed to broadcast page creation/update:", e);
			}
			global_event_ai_chat_open_canvas.dispatch({ pageId });
			return;
		}

		// Existing page preview: open diff mode, seed modified with proposed content
		global_event_ai_chat_open_canvas.dispatch({ pageId, mode: "diff", modifiedSeed: args.content });
	});

	useEffect(() => {
		const cleanup = partRuntime.subscribe(async () => {
			const state = partRuntime.getState();
			if (state.type === "tool-call" && state.status.type === "complete") {
				await handleToolComplete.current();
			}
		});

		return cleanup;
	}, [partRuntime, handleToolComplete]);

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
				<ToolInput input={args} />
				<ToolOutput
					output={
						result?.metadata?.diff ? (
							<CodeBlock code={result.metadata.diff} language="diff" />
						) : result?.output ? (
							<CodeBlock code={result.output} language="text" />
						) : null
					}
					errorText={(result as any)?.errorText}
				/>
			</ToolContent>
		</Tool>
	);
}

const WritePageToolUi = makeAssistantToolUI<WritePageToolUi_Args, WritePageToolUi_Result>({
	toolName: "write_page",
	render: WritePageToolUiComponent,
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
		</div>
	);
}
