import "./app-ai-chat.css";
import {
	ActionBarPrimitive,
	BranchPickerPrimitive,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
	makeAssistantToolUI,
	useMessage,
} from "@assistant-ui/react";
import React from "react";
import type { ToolCallContentPartProps } from "@assistant-ui/react";
import {
	ArrowDownIcon,
	CheckIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	CopyIcon,
	PencilIcon,
	RefreshCwIcon,
	SendHorizontalIcon,
	FileText,
	AlertCircle,
	Loader2,
} from "lucide-react";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from "./ai-elements/tool.tsx";
import { Actions, Action } from "./ai-elements/actions.tsx";
import { CodeBlock } from "./ai-elements/code-block.tsx";
import { parseCreateArtifactArgs, type CreateArtifactArgs } from "../types/artifact-schemas.ts";

// Component props interface
export interface AppAiChat_Props {
	className?: string;
}

// Tool argument and result types
interface ReadPageArgs {
	path: string;
	offset?: number;
	limit?: number;
}

interface ReadPageResult {
	title: string;
	output: string;
	metadata: {
		preview: string;
	};
}

interface ListPagesArgs {
	path?: string;
	ignore?: string[];
	maxDepth?: number;
	limit?: number;
}

interface ListPagesResult {
	title: string;
	metadata: {
		count: number;
		truncated: boolean;
	};
	output: string;
}

interface GlobPagesArgs {
	pattern: string;
	path?: string;
	limit?: number;
}

interface GlobPagesResult {
	title: string;
	metadata: {
		count: number;
		truncated: boolean;
	};
	output: string;
}

interface GrepPagesArgs {
	pattern: string;
	path?: string;
	include?: string;
	maxDepth?: number;
	limit?: number;
}

interface GrepPagesResult {
	title: string;
	metadata: {
		matches: number;
		truncated: boolean;
	};
	output: string;
}

interface TextSearchArgs {
	query: string;
	limit?: number;
}

interface TextSearchResult {
	title: string;
	metadata: {
		matches: number;
	};
	output: string;
}

// TooltipIconButton component (inlined)
interface TooltipIconButtonProps extends React.ComponentPropsWithoutRef<typeof Button> {
	tooltip: string;
	side?: "top" | "bottom" | "left" | "right";
}

function TooltipIconButton(props: TooltipIconButtonProps) {
	const { children, tooltip, side = "bottom", className, ...rest } = props;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button variant="ghost" size="icon" {...rest} className={cn("aui-button-icon", className)}>
					{children}
					<span className="aui-sr-only">{tooltip}</span>
				</Button>
			</TooltipTrigger>
			<TooltipContent side={side}>{tooltip}</TooltipContent>
		</Tooltip>
	);
}

// MarkdownText component (simplified inline version)
function MarkdownText() {
	return <MessagePrimitive.Parts />;
}

// Helper functions for tool UIs
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

// Metadata header component
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

// CreateArtifact Tool UI Component
function CreateArtifactToolRender(props: ToolCallContentPartProps<CreateArtifactArgs, void>) {
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

// CreateArtifact Tool UI (show-only, no side effects)
const CreateArtifactToolUI = makeAssistantToolUI<CreateArtifactArgs, void>({
	toolName: "create_artifact",
	render: CreateArtifactToolRender,
});

// ReadPage Tool UI Component
function ReadPageToolRender(props: ToolCallContentPartProps<ReadPageArgs, ReadPageResult>) {
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

// ReadPage Tool UI
const ReadPageToolUI = makeAssistantToolUI<ReadPageArgs, ReadPageResult>({
	toolName: "read_page",
	render: ReadPageToolRender,
});

// ListPages Tool UI Component
function ListPagesToolRender(props: ToolCallContentPartProps<ListPagesArgs, ListPagesResult>) {
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

// ListPages Tool UI
const ListPagesToolUI = makeAssistantToolUI<ListPagesArgs, ListPagesResult>({
	toolName: "list_pages",
	render: ListPagesToolRender,
});

// GlobPages Tool UI Component
function GlobPagesToolRender(props: ToolCallContentPartProps<GlobPagesArgs, GlobPagesResult>) {
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

// GlobPages Tool UI
const GlobPagesToolUI = makeAssistantToolUI<GlobPagesArgs, GlobPagesResult>({
	toolName: "glob_pages",
	render: GlobPagesToolRender,
});

// GrepPages Tool UI Component
function GrepPagesToolRender(props: ToolCallContentPartProps<GrepPagesArgs, GrepPagesResult>) {
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

// GrepPages Tool UI
const GrepPagesToolUI = makeAssistantToolUI<GrepPagesArgs, GrepPagesResult>({
	toolName: "grep_pages",
	render: GrepPagesToolRender,
});

// TextSearchPages Tool UI Component
function TextSearchPagesToolRender(props: ToolCallContentPartProps<TextSearchArgs, TextSearchResult>) {
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

// TextSearchPages Tool UI
const TextSearchPagesToolUI = makeAssistantToolUI<TextSearchArgs, TextSearchResult>({
	toolName: "text_search_pages",
	render: TextSearchPagesToolRender,
});

// Thread component (copied from assistant-ui/thread.tsx)
function Thread() {
	return (
		<ThreadPrimitive.Root
			className={cn(
				"AppAiChat-thread",
				"flex h-full flex-1 flex-col bg-white text-black dark:bg-black dark:text-white",
			)}
		>
			<ThreadPrimitive.Viewport
				autoScroll
				className={cn(
					"AppAiChat-thread-viewport",
					"flex max-h-full min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 pt-8",
				)}
			>
				<ThreadWelcome />

				<ThreadPrimitive.Messages
					components={{
						UserMessage: UserMessage,
						EditComposer: EditComposer,
						AssistantMessage: AssistantMessage,
					}}
				/>

				<ThreadPrimitive.If empty={false}>
					<div className={cn("AppAiChat-thread-spacer", "min-h-8 flex-grow")} />
				</ThreadPrimitive.If>

				<div
					className={cn(
						"AppAiChat-thread-composer-container",
						"sticky bottom-0 mt-3 flex w-full max-w-[var(--thread-max-width)] flex-col items-center justify-end rounded-t-lg bg-white pb-4 dark:bg-black",
					)}
				>
					<ThreadScrollToBottom />
					<Composer />
				</div>
			</ThreadPrimitive.Viewport>
		</ThreadPrimitive.Root>
	);
}

// Thread subcomponents
function ThreadScrollToBottom() {
	return (
		<ThreadPrimitive.ScrollToBottom asChild>
			<TooltipIconButton
				tooltip="Scroll to bottom"
				variant="outline"
				className={cn("AppAiChat-thread-scroll-to-bottom", "absolute -top-8 rounded-full disabled:invisible")}
			>
				<ArrowDownIcon />
			</TooltipIconButton>
		</ThreadPrimitive.ScrollToBottom>
	);
}

function ThreadWelcome() {
	return (
		<ThreadPrimitive.Empty>
			<div className={cn("AppAiChat-thread-welcome", "flex w-full max-w-[var(--thread-max-width)] flex-grow flex-col")}>
				<div
					className={cn(
						"AppAiChat-thread-welcome-content",
						"flex w-full flex-grow flex-col items-center justify-center",
					)}
				>
					<p className={cn("AppAiChat-thread-welcome-title", "mt-4 font-medium")}>How can I help you today?</p>
				</div>
				<ThreadWelcomeSuggestions />
			</div>
		</ThreadPrimitive.Empty>
	);
}

function ThreadWelcomeSuggestions() {
	return (
		<div className={cn("AppAiChat-thread-welcome-suggestions", "mt-3 flex w-full items-stretch justify-center gap-4")}>
			<ThreadPrimitive.Suggestion
				className={cn(
					"AppAiChat-thread-welcome-suggestions-item",
					"flex max-w-sm grow basis-0 flex-col items-center justify-center rounded-lg border p-3 transition-colors ease-in hover:bg-muted/80",
				)}
				prompt="What is the weather in Tokyo?"
				method="replace"
				autoSend
			>
				<span
					className={cn(
						"AppAiChat-thread-welcome-suggestions-text",
						"line-clamp-2 text-sm font-semibold text-ellipsis",
					)}
				>
					What is the weather in Tokyo?
				</span>
			</ThreadPrimitive.Suggestion>
			<ThreadPrimitive.Suggestion
				className={cn(
					"AppAiChat-thread-welcome-suggestions-item",
					"flex max-w-sm grow basis-0 flex-col items-center justify-center rounded-lg border p-3 transition-colors ease-in hover:bg-muted/80",
				)}
				prompt="Explain quantum computing in simple terms"
				method="replace"
				autoSend
			>
				<span
					className={cn(
						"AppAiChat-thread-welcome-suggestions-text",
						"line-clamp-2 text-sm font-semibold text-ellipsis",
					)}
				>
					Explain quantum computing in simple terms
				</span>
			</ThreadPrimitive.Suggestion>
		</div>
	);
}

function Composer() {
	return (
		<ComposerPrimitive.Root
			className={cn(
				"AppAiChat-composer",
				"flex w-full flex-wrap items-end rounded-lg border bg-inherit px-2.5 shadow-sm transition-colors ease-in focus-within:border-ring/20",
			)}
		>
			<ComposerPrimitive.Input
				rows={1}
				autoFocus
				autoComplete={`off-${Date.now()}`}
				placeholder="Write a message..."
				className={cn(
					"AppAiChat-composer-input",
					"max-h-40 flex-grow resize-none border-none bg-transparent px-2 py-4 text-sm outline-none placeholder:text-muted-foreground focus:ring-0 disabled:cursor-not-allowed",
				)}
			/>
			<ComposerAction />
		</ComposerPrimitive.Root>
	);
}

function ComposerAction() {
	return (
		<>
			<ThreadPrimitive.If running={false}>
				<ComposerPrimitive.Send asChild>
					<TooltipIconButton
						tooltip="Send"
						variant="default"
						className={cn("AppAiChat-composer-action-send-button", "my-2.5 size-8 p-2 transition-opacity ease-in")}
					>
						<SendHorizontalIcon />
					</TooltipIconButton>
				</ComposerPrimitive.Send>
			</ThreadPrimitive.If>
			<ThreadPrimitive.If running>
				<ComposerPrimitive.Cancel asChild>
					<TooltipIconButton
						tooltip="Cancel"
						variant="default"
						className={cn("AppAiChat-composer-action-cancel-button", "my-2.5 size-8 p-2 transition-opacity ease-in")}
					>
						<CircleStopIcon />
					</TooltipIconButton>
				</ComposerPrimitive.Cancel>
			</ThreadPrimitive.If>
		</>
	);
}

function UserMessage() {
	return (
		<MessagePrimitive.Root
			className={cn(
				"AppAiChat-user-message",
				"grid w-full max-w-[var(--thread-max-width)] auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 py-4 [&:where(>*)]:col-start-2",
			)}
		>
			<UserActionBar />

			<div
				className={cn(
					"AppAiChat-user-message-content",
					"col-start-2 row-start-2 max-w-[calc(var(--thread-max-width)*0.8)] rounded-3xl bg-muted px-5 py-2.5 break-words text-foreground",
				)}
			>
				<MessagePrimitive.Parts />
			</div>

			<BranchPicker
				className={cn(
					"AppAiChat-user-message-branch-picker",
					"col-span-full col-start-1 row-start-3 -mr-1 justify-end",
				)}
			/>
		</MessagePrimitive.Root>
	);
}

function UserActionBar() {
	return (
		<ActionBarPrimitive.Root
			hideWhenRunning
			autohide="not-last"
			className={cn("AppAiChat-user-action-bar", "col-start-1 row-start-2 mt-2.5 mr-3 flex flex-col items-end")}
		>
			<ActionBarPrimitive.Edit asChild>
				<TooltipIconButton tooltip="Edit" className="AppAiChat-user-action-bar-edit-button">
					<PencilIcon />
				</TooltipIconButton>
			</ActionBarPrimitive.Edit>
		</ActionBarPrimitive.Root>
	);
}

function EditComposer() {
	return (
		<ComposerPrimitive.Root
			className={cn(
				"AppAiChat-edit-composer",
				"my-4 flex w-full max-w-[var(--thread-max-width)] flex-col gap-2 rounded-xl bg-muted",
			)}
		>
			<ComposerPrimitive.Input
				autoComplete={`off-${Date.now()}`}
				className={cn(
					"AppAiChat-edit-composer-input",
					"flex h-8 w-full resize-none bg-transparent p-4 pb-0 text-foreground outline-none",
				)}
			/>

			<div
				className={cn("AppAiChat-edit-composer-actions", "mx-3 mb-3 flex items-center justify-center gap-2 self-end")}
			>
				<ComposerPrimitive.Cancel asChild>
					<Button variant="ghost" className="AppAiChat-edit-composer-cancel-button">
						Cancel
					</Button>
				</ComposerPrimitive.Cancel>
				<ComposerPrimitive.Send asChild>
					<Button className="AppAiChat-edit-composer-send-button">Send</Button>
				</ComposerPrimitive.Send>
			</div>
		</ComposerPrimitive.Root>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root
			className={cn(
				"AppAiChat-assistant-message",
				"relative grid w-full max-w-[var(--thread-max-width)] grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] py-4",
			)}
		>
			<div
				className={cn(
					"AppAiChat-assistant-message-content",
					"col-span-2 col-start-2 row-start-1 my-1.5 max-w-[calc(var(--thread-max-width)*0.8)] leading-7 break-words text-foreground",
				)}
			>
				<MessagePrimitive.Parts components={{ Text: MarkdownText }} />
			</div>

			<AssistantActionBar />

			<BranchPicker className={cn("AppAiChat-assistant-message-branch-picker", "col-start-2 row-start-2 mr-2 -ml-2")} />
		</MessagePrimitive.Root>
	);
}

function AssistantActionBar() {
	return (
		<ActionBarPrimitive.Root
			hideWhenRunning
			autohide="not-last"
			autohideFloat="single-branch"
			className={cn(
				"AppAiChat-assistant-action-bar",
				"col-start-3 row-start-2 -ml-1 flex gap-1 text-muted-foreground data-[floating]:absolute data-[floating]:rounded-md data-[floating]:border data-[floating]:bg-background data-[floating]:p-1 data-[floating]:shadow-sm",
			)}
		>
			<ActionBarPrimitive.Copy asChild>
				<TooltipIconButton tooltip="Copy" className="AppAiChat-assistant-action-bar-copy-button">
					<MessagePrimitive.If copied>
						<CheckIcon />
					</MessagePrimitive.If>
					<MessagePrimitive.If copied={false}>
						<CopyIcon />
					</MessagePrimitive.If>
				</TooltipIconButton>
			</ActionBarPrimitive.Copy>
			<ActionBarPrimitive.Reload asChild>
				<TooltipIconButton tooltip="Refresh" className="AppAiChat-assistant-action-bar-reload-button">
					<RefreshCwIcon />
				</TooltipIconButton>
			</ActionBarPrimitive.Reload>
		</ActionBarPrimitive.Root>
	);
}

function BranchPicker(props: BranchPickerPrimitive.Root.Props) {
	const { className, ...rest } = props;
	return (
		<BranchPickerPrimitive.Root
			hideWhenSingleBranch
			className={cn("AppAiChat-branch-picker", "inline-flex items-center text-xs text-muted-foreground", className)}
			{...rest}
		>
			<BranchPickerPrimitive.Previous asChild>
				<TooltipIconButton tooltip="Previous" className="AppAiChat-branch-picker-previous-button">
					<ChevronLeftIcon />
				</TooltipIconButton>
			</BranchPickerPrimitive.Previous>
			<span className={cn("AppAiChat-branch-picker-counter", "font-medium")}>
				<BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
			</span>
			<BranchPickerPrimitive.Next asChild>
				<TooltipIconButton tooltip="Next" className="AppAiChat-branch-picker-next-button">
					<ChevronRightIcon />
				</TooltipIconButton>
			</BranchPickerPrimitive.Next>
		</BranchPickerPrimitive.Root>
	);
}

function CircleStopIcon() {
	return (
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" width="16" height="16">
			<rect width="10" height="10" x="3" y="3" rx="2" />
		</svg>
	);
}

// Main component
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
