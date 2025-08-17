import "./app-ai-chat.css";
import { makeAssistantToolUI, useMessage } from "@assistant-ui/react";
import type { ToolCallContentPartProps } from "@assistant-ui/react";
import { CopyIcon, FileText, AlertCircle, Loader2 } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { Badge } from "./ui/badge.tsx";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "./ai-elements/tool.tsx";
import { Actions, Action } from "./ai-elements/actions.tsx";
import { CodeBlock } from "./ai-elements/code-block.tsx";
import { parseCreateArtifactArgs, type CreateArtifactArgs } from "../types/artifact-schemas.ts";
import { Thread } from "@/components/assistant-ui/thread.tsx";

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
		navigator.clipboard.writeText(text).catch(() => {});
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

function CreateArtifactToolComponent(props: ToolCallContentPartProps<CreateArtifactArgs, void>) {
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

const CreateArtifactToolUI = makeAssistantToolUI<CreateArtifactArgs, void>({
	toolName: "create_artifact",
	render: CreateArtifactToolComponent,
});

type ReadPageArgs = {
	path: string;
	offset?: number;
	limit?: number;
};

type ReadPageResult = {
	title: string;
	output: string;
	metadata: {
		preview: string;
	};
};

function ReadPageToolComponent(props: ToolCallContentPartProps<ReadPageArgs, ReadPageResult>) {
	const { args, result, status } = props;
	const toolState = mapStatusToToolState(status);

	return (
		<Tool defaultOpen={false} className="AppAiChat-read-page-tool">
			<ToolHeader type="tool-read_page" state={toolState as any} />
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

const ReadPageToolUI = makeAssistantToolUI<ReadPageArgs, ReadPageResult>({
	toolName: "read_page",
	render: ReadPageToolComponent,
});

type ListPagesArgs = {
	path?: string;
	ignore?: string[];
	maxDepth?: number;
	limit?: number;
};

type ListPagesResult = {
	title: string;
	metadata: {
		count: number;
		truncated: boolean;
	};
	output: string;
};

function ListPagesToolComponent(props: ToolCallContentPartProps<ListPagesArgs, ListPagesResult>) {
	const { args, result, status } = props;
	const toolState = mapStatusToToolState(status);

	return (
		<Tool defaultOpen={false} className="AppAiChat-list-pages-tool">
			<ToolHeader type="tool-list_pages" state={toolState as any} />
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

const ListPagesToolUI = makeAssistantToolUI<ListPagesArgs, ListPagesResult>({
	toolName: "list_pages",
	render: ListPagesToolComponent,
});

type GlobPagesArgs = {
	pattern: string;
	path?: string;
	limit?: number;
};

type GlobPagesResult = {
	title: string;
	metadata: {
		count: number;
		truncated: boolean;
	};
	output: string;
};

function GlobPagesToolComponent(props: ToolCallContentPartProps<GlobPagesArgs, GlobPagesResult>) {
	const { args, result, status } = props;
	const toolState = mapStatusToToolState(status);

	return (
		<Tool defaultOpen={false} className="AppAiChat-glob-pages-tool">
			<ToolHeader type="tool-glob_pages" state={toolState as any} />
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

const GlobPagesToolUI = makeAssistantToolUI<GlobPagesArgs, GlobPagesResult>({
	toolName: "glob_pages",
	render: GlobPagesToolComponent,
});

type GrepPagesArgs = {
	pattern: string;
	path?: string;
	include?: string;
	maxDepth?: number;
	limit?: number;
};

type GrepPagesResult = {
	title: string;
	metadata: {
		matches: number;
		truncated: boolean;
	};
	output: string;
};

function GrepPagesToolComponent(props: ToolCallContentPartProps<GrepPagesArgs, GrepPagesResult>) {
	const { args, result, status } = props;
	const toolState = mapStatusToToolState(status);

	return (
		<Tool defaultOpen={false} className="AppAiChat-grep-pages-tool">
			<ToolHeader type="tool-grep_pages" state={toolState as any} />
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

const GrepPagesToolUI = makeAssistantToolUI<GrepPagesArgs, GrepPagesResult>({
	toolName: "grep_pages",
	render: GrepPagesToolComponent,
});

type TextSearchArgs = {
	query: string;
	limit?: number;
};

type TextSearchResult = {
	title: string;
	metadata: {
		matches: number;
	};
	output: string;
};

function TextSearchPagesToolComponent(props: ToolCallContentPartProps<TextSearchArgs, TextSearchResult>) {
	const { args, result, status } = props;
	const toolState = mapStatusToToolState(status);

	return (
		<Tool defaultOpen={false} className="AppAiChat-text-search-pages-tool">
			<ToolHeader type="tool-text_search_pages" state={toolState as any} />
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

const TextSearchPagesToolUI = makeAssistantToolUI<TextSearchArgs, TextSearchResult>({
	toolName: "text_search_pages",
	render: TextSearchPagesToolComponent,
});

export interface AppAiChat_Props {
	className?: string;
}

export function AppAiChat(props: AppAiChat_Props) {
	const { className } = props;

	return (
		<div className={cn("AppAiChat", className)}>
			<Thread />
			<CreateArtifactToolUI />
			<ReadPageToolUI />
			<ListPagesToolUI />
			<GlobPagesToolUI />
			<GrepPagesToolUI />
			<TextSearchPagesToolUI />
		</div>
	);
}
