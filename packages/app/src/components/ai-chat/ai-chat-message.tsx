import "./ai-chat-message.css";

import type { ComponentPropsWithRef, ReactNode, Ref } from "react";
import { ChevronLeft, ChevronRight, GitBranch, RefreshCw } from "lucide-react";
import {
	isDataUIPart,
	isFileUIPart,
	isReasoningUIPart,
	isTextUIPart,
	isToolOrDynamicToolUIPart,
	type DynamicToolUIPart,
	type ToolUIPart,
} from "ai";
import type { ExtractStrict } from "type-fest";
import { ai_chat_get_message_text, type ai_chat_AiSdk5UiMessage, type ai_chat_AiSdk5UiTools } from "@/lib/ai-chat.ts";

import { CodeBlock } from "@/components/ai-elements/code-block.tsx";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool.tsx";
import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import type { AiChatController } from "@/hooks/ai-chat-hooks.tsx";
import { ai_chat_get_parent_id } from "@/hooks/ai-chat-hooks.tsx";
import { AiChatComposer, type AiChatComposer_Props } from "@/components/ai-chat/ai-chat-composer.tsx";
import { AiChatMarkdown } from "@/components/ai-chat/ai-chat-markdown.tsx";
import { cn, json_strigify_ensured } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";

// #region tool meta header
type AiChatMessageToolMetaHeader_ClassNames = "AiChatMessageToolMetaHeader-chips";

type AiChatMessageToolMetaHeader_Props = {
	metadata: Record<string, unknown>;
};

function AiChatMessageToolMetaHeader(props: AiChatMessageToolMetaHeader_Props) {
	const { metadata } = props;
	return (
		<div className={"AiChatMessageToolMetaHeader-chips" satisfies AiChatMessageToolMetaHeader_ClassNames}>
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
// #endregion tool meta header

// #region tool copy_result_action
type AiChatMessageToolCopyResultAction_ClassNames =
	| "AiChatMessageToolCopyResultAction-button"
	| "AiChatMessageToolCopyResultAction-icon";

type AiChatMessageToolCopyResultAction_Props = {
	text?: string | undefined;
};

function AiChatMessageToolCopyResultAction(props: AiChatMessageToolCopyResultAction_Props) {
	const { text } = props;

	return (
		<CopyIconButton
			variant="ghost"
			tooltipCopy="Copy result"
			text={text}
			className={"AiChatMessageToolCopyResultAction-button" satisfies AiChatMessageToolCopyResultAction_ClassNames}
			iconClassName={"AiChatMessageToolCopyResultAction-icon" satisfies AiChatMessageToolCopyResultAction_ClassNames}
		/>
	);
}
// #endregion tool copy_result_action

// #region tool meta row
type AiChatMessageToolMetaRow_ClassNames = "AiChatMessageToolMetaRow" | "AiChatMessageToolMetaRow-actions";

type AiChatMessageToolMetaRow_Props = {
	metadata: Record<string, unknown>;
	copyText?: string | undefined;
};

function AiChatMessageToolMetaRow(props: AiChatMessageToolMetaRow_Props) {
	const { metadata, copyText } = props;
	return (
		<div className={"AiChatMessageToolMetaRow" satisfies AiChatMessageToolMetaRow_ClassNames}>
			<AiChatMessageToolMetaHeader metadata={metadata} />
			<div className={"AiChatMessageToolMetaRow-actions" satisfies AiChatMessageToolMetaRow_ClassNames}>
				<AiChatMessageToolCopyResultAction text={copyText} />
			</div>
		</div>
	);
}
// #endregion tool meta row

// #region tool read_page
type AiChatMessageToolReadPage_ClassNames = "AiChatMessageToolReadPage";

type AiChatMessageToolReadPage_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-read_page" }>["input"];
	result: ai_chat_AiSdk5UiTools["read_page"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessageToolReadPage(props: AiChatMessageToolReadPage_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<Tool
			defaultOpen={false}
			className={cn("AiChatMessageToolReadPage" satisfies AiChatMessageToolReadPage_ClassNames, className)}
		>
			<ToolHeader type="tool-read_page" state={toolState} />
			<ToolContent>
				<AiChatMessageToolMetaRow metadata={result?.metadata || {}} copyText={result?.output} />
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={errorText}
				/>
			</ToolContent>
		</Tool>
	);
}
// #endregion tool read_page

// #region tool list_pages
type AiChatMessageToolListPages_ClassNames = "AiChatMessageToolListPages";

type AiChatMessageToolListPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-list_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["list_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessageToolListPages(props: AiChatMessageToolListPages_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<Tool
			defaultOpen={false}
			className={cn("AiChatMessageToolListPages" satisfies AiChatMessageToolListPages_ClassNames, className)}
		>
			<ToolHeader type="tool-list_pages" state={toolState} />
			<ToolContent>
				<AiChatMessageToolMetaRow metadata={result?.metadata || {}} copyText={result?.output} />
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={errorText}
				/>
			</ToolContent>
		</Tool>
	);
}
// #endregion tool list_pages

// #region tool glob_pages
type AiChatMessageToolGlobPages_ClassNames = "AiChatMessageToolGlobPages";

type AiChatMessageToolGlobPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-glob_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["glob_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessageToolGlobPages(props: AiChatMessageToolGlobPages_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<Tool
			defaultOpen={false}
			className={cn("AiChatMessageToolGlobPages" satisfies AiChatMessageToolGlobPages_ClassNames, className)}
		>
			<ToolHeader type="tool-glob_pages" state={toolState} />
			<ToolContent>
				<AiChatMessageToolMetaRow metadata={result?.metadata || {}} copyText={result?.output} />
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={errorText}
				/>
			</ToolContent>
		</Tool>
	);
}
// #endregion tool glob_pages

// #region tool grep_pages
type AiChatMessageToolGrepPages_ClassNames = "AiChatMessageToolGrepPages";

type AiChatMessageToolGrepPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-grep_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["grep_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessageToolGrepPages(props: AiChatMessageToolGrepPages_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<Tool
			defaultOpen={false}
			className={cn("AiChatMessageToolGrepPages" satisfies AiChatMessageToolGrepPages_ClassNames, className)}
		>
			<ToolHeader type="tool-grep_pages" state={toolState} />
			<ToolContent>
				<AiChatMessageToolMetaRow metadata={result?.metadata || {}} copyText={result?.output} />
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={errorText}
				/>
			</ToolContent>
		</Tool>
	);
}
// #endregion tool grep_pages

// #region tool text_search_pages
type AiChatMessageToolTextSearchPages_ClassNames = "AiChatMessageToolTextSearchPages";

type AiChatMessageToolTextSearchPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-text_search_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["text_search_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessageToolTextSearchPages(props: AiChatMessageToolTextSearchPages_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<Tool
			defaultOpen={false}
			className={cn(
				"AiChatMessageToolTextSearchPages" satisfies AiChatMessageToolTextSearchPages_ClassNames,
				className,
			)}
		>
			<ToolHeader type="tool-text_search_pages" state={toolState} />
			<ToolContent>
				<AiChatMessageToolMetaRow metadata={result?.metadata || {}} copyText={result?.output} />
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={result?.output ? <CodeBlock code={result.output} language="text" /> : null}
					errorText={errorText}
				/>
			</ToolContent>
		</Tool>
	);
}
// #endregion tool text_search_pages

// #region tool write_page
type AiChatMessageToolWritePage_ClassNames = "AiChatMessageToolWritePage";

type AiChatMessageToolWritePage_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-write_page" }>["input"];
	result: ai_chat_AiSdk5UiTools["write_page"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessageToolWritePage(props: AiChatMessageToolWritePage_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<Tool
			defaultOpen={false}
			className={cn("AiChatMessageToolWritePage" satisfies AiChatMessageToolWritePage_ClassNames, className)}
		>
			<ToolHeader type="tool-write_page" state={toolState} />
			<ToolContent>
				<AiChatMessageToolMetaRow metadata={result?.metadata || {}} copyText={result?.output} />
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={
						result?.metadata?.diff ? (
							<CodeBlock code={result.metadata.diff} language="diff" />
						) : result?.output ? (
							<CodeBlock code={result.output} language="text" />
						) : null
					}
					errorText={errorText}
				/>
			</ToolContent>
		</Tool>
	);
}
// #endregion tool write_page

// #region tool edit_page
type AiChatMessageToolEditPage_ClassNames = "AiChatMessageToolEditPage";

type AiChatMessageToolEditPage_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-edit_page" }>["input"];
	result: ai_chat_AiSdk5UiTools["edit_page"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessageToolEditPage(props: AiChatMessageToolEditPage_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<Tool
			defaultOpen={false}
			className={cn("AiChatMessageToolEditPage" satisfies AiChatMessageToolEditPage_ClassNames, className)}
		>
			<ToolHeader type="tool-edit_page" state={toolState} />
			<ToolContent>
				<AiChatMessageToolMetaRow metadata={result?.metadata || {}} copyText={result?.output} />
				<ToolInput input={args ?? {}} />
				<ToolOutput
					output={
						result?.metadata?.diff ? (
							<CodeBlock code={result.metadata.diff} language="diff" />
						) : result?.output ? (
							<CodeBlock code={result.output} language="text" />
						) : null
					}
					errorText={errorText}
				/>
			</ToolContent>
		</Tool>
	);
}
// #endregion tool edit_page

// #region tool unknown
type AiChatMessageToolUnknown_ClassNames = "AiChatMessageToolUnknown" | "AiChatMessageToolUnknown-meta";

type AiChatMessageToolUnknown_Props = {
	className?: string | undefined;
	part: ToolUIPart<ai_chat_AiSdk5UiTools> | DynamicToolUIPart;
};

function AiChatMessageToolUnknown(props: AiChatMessageToolUnknown_Props) {
	const { className, part } = props;

	const toolName = part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);
	const output = part.state === "output-available" ? part.output : undefined;
	const errorText = part.state === "output-error" ? part.errorText : undefined;
	const outputNode =
		output === undefined ? null : typeof output === "string" ? (
			<CodeBlock code={output} language="text" />
		) : (
			<CodeBlock code={json_strigify_ensured(output)} language="json" />
		);

	return (
		<Tool
			defaultOpen={false}
			className={cn("AiChatMessageToolUnknown" satisfies AiChatMessageToolUnknown_ClassNames, className)}
		>
			<ToolHeader type={`tool-${toolName}`} state={part.state} />
			<ToolContent>
				<div
					className={cn(
						"AiChatMessageToolUnknown-meta" satisfies AiChatMessageToolUnknown_ClassNames,
						"flex flex-wrap gap-1 px-4 pt-3",
					)}
				>
					<Badge variant="secondary" className="text-xs">
						type: {part.type}
					</Badge>
					<Badge variant="secondary" className="text-xs">
						toolCallId: {part.toolCallId}
					</Badge>
					<Badge variant="secondary" className="text-xs">
						state: {part.state}
					</Badge>
				</div>
				<ToolInput input={part.input ?? {}} />
				<ToolOutput output={outputNode} errorText={errorText} />
			</ToolContent>
		</Tool>
	);
}
// #endregion tool unknown

// #region part
type AiChatMessagePart_ClassNames =
	| "AiChatMessagePart"
	| "AiChatMessagePart-markdown"
	| "AiChatMessagePart-image"
	| "AiChatMessagePart-file"
	| "AiChatMessagePart-file-name"
	| "AiChatMessagePart-source";

type AiChatMessagePart_Props = {
	role: "assistant" | "user" | "system";
	part: ai_chat_AiSdk5UiMessage["parts"][number];
	message: ai_chat_AiSdk5UiMessage;
	onToolOutput: AiChatController["addToolOutput"];
	onToolResumeStream: AiChatController["resumeStream"];
	onToolStop: AiChatController["stop"];
};

function AiChatMessagePart(props: AiChatMessagePart_Props) {
	const { role, part } = props;

	if (isToolOrDynamicToolUIPart(part)) {
		if (part.type === "dynamic-tool") {
			return (
				<AiChatMessageToolUnknown part={part} className={"AiChatMessagePart" satisfies AiChatMessagePart_ClassNames} />
			);
		}

		switch (part.type) {
			case "tool-read_page": {
				const result = part.state === "output-available" ? part.output : undefined;
				const errorText = part.state === "output-error" ? part.errorText : undefined;
				return (
					<AiChatMessageToolReadPage
						className={"AiChatMessagePart" satisfies AiChatMessagePart_ClassNames}
						args={part.input}
						result={result as ai_chat_AiSdk5UiTools["read_page"]["output"] | undefined}
						toolState={part.state}
						errorText={errorText}
					/>
				);
			}
			case "tool-list_pages": {
				const result = part.state === "output-available" ? part.output : undefined;
				const errorText = part.state === "output-error" ? part.errorText : undefined;
				return (
					<AiChatMessageToolListPages
						className={"AiChatMessagePart" satisfies AiChatMessagePart_ClassNames}
						args={part.input}
						result={result as ai_chat_AiSdk5UiTools["list_pages"]["output"] | undefined}
						toolState={part.state}
						errorText={errorText}
					/>
				);
			}
			case "tool-glob_pages": {
				const result = part.state === "output-available" ? part.output : undefined;
				const errorText = part.state === "output-error" ? part.errorText : undefined;
				return (
					<AiChatMessageToolGlobPages
						className={"AiChatMessagePart" satisfies AiChatMessagePart_ClassNames}
						args={part.input}
						result={result as ai_chat_AiSdk5UiTools["glob_pages"]["output"] | undefined}
						toolState={part.state}
						errorText={errorText}
					/>
				);
			}
			case "tool-grep_pages": {
				const result = part.state === "output-available" ? part.output : undefined;
				const errorText = part.state === "output-error" ? part.errorText : undefined;
				return (
					<AiChatMessageToolGrepPages
						className={"AiChatMessagePart" satisfies AiChatMessagePart_ClassNames}
						args={part.input}
						result={result as ai_chat_AiSdk5UiTools["grep_pages"]["output"] | undefined}
						toolState={part.state}
						errorText={errorText}
					/>
				);
			}
			case "tool-text_search_pages": {
				const result = part.state === "output-available" ? part.output : undefined;
				const errorText = part.state === "output-error" ? part.errorText : undefined;
				return (
					<AiChatMessageToolTextSearchPages
						className={"AiChatMessagePart" satisfies AiChatMessagePart_ClassNames}
						args={part.input}
						result={result as ai_chat_AiSdk5UiTools["text_search_pages"]["output"] | undefined}
						toolState={part.state}
						errorText={errorText}
					/>
				);
			}
			case "tool-write_page": {
				const result = part.state === "output-available" ? part.output : undefined;
				const errorText = part.state === "output-error" ? part.errorText : undefined;
				return (
					<AiChatMessageToolWritePage
						className={"AiChatMessagePart" satisfies AiChatMessagePart_ClassNames}
						args={part.input}
						result={result as ai_chat_AiSdk5UiTools["write_page"]["output"] | undefined}
						toolState={part.state}
						errorText={errorText}
					/>
				);
			}
			case "tool-edit_page": {
				const result = part.state === "output-available" ? part.output : undefined;
				const errorText = part.state === "output-error" ? part.errorText : undefined;
				return (
					<AiChatMessageToolEditPage
						className={"AiChatMessagePart" satisfies AiChatMessagePart_ClassNames}
						args={part.input}
						result={result as ai_chat_AiSdk5UiTools["edit_page"]["output"] | undefined}
						toolState={part.state}
						errorText={errorText}
					/>
				);
			}
			default:
				return (
					<AiChatMessageToolUnknown
						part={part}
						className={"AiChatMessagePart" satisfies AiChatMessagePart_ClassNames}
					/>
				);
		}
	}

	if (isTextUIPart(part)) {
		if (role === "assistant") {
			return (
				<AiChatMarkdown
					text={part.text}
					className={"AiChatMessagePart-markdown" satisfies AiChatMessagePart_ClassNames}
				/>
			);
		}

		return <p>{part.text}</p>;
	}

	if (isReasoningUIPart(part)) {
		return <p>{part.text}</p>;
	}

	if (isDataUIPart(part)) {
		return null;
	}

	if (isFileUIPart(part)) {
		if (part.mediaType.startsWith("image/")) {
			return (
				<img
					className={"AiChatMessagePart-image" satisfies AiChatMessagePart_ClassNames}
					src={part.url}
					alt={part.filename ?? "Image attachment"}
				/>
			);
		}

		return (
			<div className={"AiChatMessagePart-file" satisfies AiChatMessagePart_ClassNames}>
				<span className={"AiChatMessagePart-file-name" satisfies AiChatMessagePart_ClassNames}>
					{part.filename ?? "File attachment"}
				</span>
			</div>
		);
	}

	if (part.type === "source-url") {
		return (
			<a
				className={"AiChatMessagePart-source" satisfies AiChatMessagePart_ClassNames}
				href={part.url}
				target="_blank"
				rel="noreferrer"
			>
				{part.title ?? part.url}
			</a>
		);
	}

	if (part.type === "source-document") {
		const title = part.title || part.filename || part.sourceId;
		return (
			<span
				className={"AiChatMessagePart-source" satisfies AiChatMessagePart_ClassNames}
				title={`${part.mediaType}${part.filename ? ` • ${part.filename}` : ""}`}
			>
				{title}
			</span>
		);
	}

	return null;
}

// #endregion part

// #region parts liss
type AiChatMessagePartsList_Props = {
	message: ai_chat_AiSdk5UiMessage;
	onToolOutput: AiChatMessagePart_Props["onToolOutput"];
	onToolResumeStream: AiChatMessagePart_Props["onToolResumeStream"];
	onToolStop: AiChatMessagePart_Props["onToolStop"];
};

function AiChatMessagePartsList(props: AiChatMessagePartsList_Props) {
	const { message, onToolOutput, onToolResumeStream, onToolStop } = props;

	const displayParts = message.parts.filter((part) => !part.type.startsWith("data-") && part.type !== "step-start");

	return (
		<div>
			{displayParts.map((part, index) => (
				<AiChatMessagePart
					// index is better in this case because the parts follow a static order
					// and this will prevent them from being unmounted when the message is
					// persisted after stream
					key={index}
					part={part}
					role={message.role}
					message={message}
					onToolOutput={onToolOutput}
					onToolResumeStream={onToolResumeStream}
					onToolStop={onToolStop}
				/>
			))}
		</div>
	);
}
// #endregion parts list

// #region container
type AiChatMessageContainer_ClassNames = "AiChatMessageContainer";

type AiChatMessageContainer_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	children: ReactNode;
};

function AiChatMessageContainer(props: AiChatMessageContainer_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("AiChatMessageContainer" satisfies AiChatMessageContainer_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
}
// #endregion container

// #region content
type AiChatMessageContent_ClassNames = "AiChatMessageContent";

type AiChatMessageContent_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	children: ReactNode;
};

function AiChatMessageContent(props: AiChatMessageContent_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn(
				"AiChatMessageContent" satisfies AiChatMessageContent_ClassNames,
				"app-doc" satisfies AppClassName,
				className,
			)}
			{...rest}
		>
			{children}
		</div>
	);
}
// #endregion content

// #region bubble
type AiChatMessageBubble_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	children: ReactNode;
};

type AiChatMessageBubble_ClassNames = "AiChatMessageBubble";

function AiChatMessageBubble(props: AiChatMessageBubble_Props) {
	const { ref, id, className, children, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("AiChatMessageBubble" satisfies AiChatMessageBubble_ClassNames, className)}
			{...rest}
		>
			{children}
		</div>
	);
}
// #endregion bubble

// #region user message-
export type AiChatMessageUser_ClassNames =
	| "AiChatMessageUser"
	| "AiChatMessageUser-bubble"
	| "AiChatMessageUser-bubble-state-editing"
	| "AiChatMessageUser-edit-button"
	| "AiChatMessageUser-content-composer"
	| "AiChatMessageUser-actions"
	| "AiChatMessageUser-action-button"
	| "AiChatMessageUser-action-icon"
	| "AiChatMessageUser-branch-controls"
	| "AiChatMessageUser-branch-label";

type AiChatMessageUser_Props = AiChatMessage_Props;

function AiChatMessageUser(props: AiChatMessageUser_Props) {
	const {
		ref,
		id,
		className,
		message,
		selectedThreadId,
		isRunning,
		isEditing,
		messagesChildrenByParentId,
		onToolOutput,
		onToolResumeStream,
		onToolStop,
		onEditStart,
		onEditCancel,
		onEditSubmit,
		onMessageBranchChat,
		onSelectBranchAnchor,
		...rest
	} = props;

	const branchMetadata = ((/* iife */) => {
		const siblings = messagesChildrenByParentId.get(ai_chat_get_parent_id(message.metadata?.convexParentId)) ?? [];
		const currentIndex = siblings.indexOf(message);

		return {
			variantIndex: currentIndex,
			variantCount: siblings.length,
			variantAnchorIds: siblings.map((sibling) => sibling.id),
		} satisfies AiChatMessage_BranchMetadata;
	})();

	const text = ai_chat_get_message_text(message);

	const canEdit = !isRunning && Boolean(text);

	const showBranchControls = Boolean(branchMetadata && branchMetadata.variantCount > 1);
	const branchLabel = branchMetadata ? `${branchMetadata.variantIndex + 1}/${branchMetadata.variantCount}` : "";
	const showEditButton = !isEditing && Boolean(selectedThreadId) && canEdit;

	const handleStartEdit = () => {
		if (!selectedThreadId || !canEdit) {
			return;
		}

		const parentId = ai_chat_get_parent_id(message.metadata?.convexParentId);

		onEditStart({ messageId: message.id, parentId });
	};

	const handleEditCancel = () => {
		onEditCancel();
	};

	const handleEditSubmit: AiChatComposer_Props["onSubmit"] = (value) => {
		onEditSubmit({ value });
	};
	const handleEditValueChange: AiChatComposer_Props["onValueChange"] = () => {};

	const handleBranchSwitch = (direction: "prev" | "next") => {
		if (isRunning) {
			return;
		}
		if (!branchMetadata || !selectedThreadId) {
			return;
		}

		const navCount = branchMetadata.variantAnchorIds.length;
		if (navCount <= 1) {
			return;
		}

		const nextIndex =
			direction === "prev"
				? (branchMetadata.variantIndex - 1 + navCount) % navCount
				: (branchMetadata.variantIndex + 1) % navCount;
		const nextAnchorId = branchMetadata.variantAnchorIds[nextIndex];
		if (!nextAnchorId) {
			return;
		}

		onSelectBranchAnchor(selectedThreadId, nextAnchorId);
	};

	const handleBranchPrev = () => {
		handleBranchSwitch("prev");
	};

	const handleBranchNext = () => {
		handleBranchSwitch("next");
	};

	return (
		<AiChatMessageContainer
			ref={ref}
			id={id}
			className={cn("AiChatMessageUser" satisfies AiChatMessageUser_ClassNames, className)}
			{...rest}
		>
			<AiChatMessageBubble
				className={cn(
					"AiChatMessageUser-bubble" satisfies AiChatMessageUser_ClassNames,
					isEditing && ("AiChatMessageUser-bubble-state-editing" satisfies AiChatMessageUser_ClassNames),
				)}
			>
				<AiChatMessageContent>
					{isEditing ? (
						<AiChatComposer
							key={message.id}
							className={"AiChatMessageUser-content-composer" satisfies AiChatMessageUser_ClassNames}
							autoFocus
							canCancel={false}
							isRunning={false}
							initialValue={text ?? ""}
							onValueChange={handleEditValueChange}
							onSubmit={handleEditSubmit}
							onCancel={() => {}}
							onInteractedOutside={handleEditCancel}
							onClose={handleEditCancel}
						/>
					) : (
						<AiChatMessagePartsList
							message={message}
							onToolOutput={onToolOutput}
							onToolResumeStream={onToolResumeStream}
							onToolStop={onToolStop}
						/>
					)}
				</AiChatMessageContent>
				{showEditButton && (
					<button
						className={"AiChatMessageUser-edit-button" satisfies AiChatMessageUser_ClassNames}
						type="button"
						{...({ "data-ai-chat-message-id": message.id } satisfies Partial<AiChatMessage_CustomAttributes>)}
						aria-label="Edit message"
						onClick={handleStartEdit}
					/>
				)}
				<div className={"AiChatMessageUser-actions" satisfies AiChatMessageUser_ClassNames} hidden={isEditing}>
					<CopyIconButton
						variant="ghost-highlightable"
						tooltipCopy="Copy message"
						text={text ?? undefined}
						className={"AiChatMessageUser-action-button" satisfies AiChatMessageUser_ClassNames}
						iconClassName={"AiChatMessageUser-action-icon" satisfies AiChatMessageUser_ClassNames}
					/>
					{showBranchControls && (
						<div className={"AiChatMessageUser-branch-controls" satisfies AiChatMessageUser_ClassNames}>
							<MyIconButton
								variant="ghost"
								tooltip="Previous variant"
								onClick={handleBranchPrev}
								disabled={isRunning}
								className={"AiChatMessageUser-action-button" satisfies AiChatMessageUser_ClassNames}
							>
								<ChevronLeft className={"AiChatMessageUser-action-icon" satisfies AiChatMessageUser_ClassNames} />
							</MyIconButton>
							<span className={"AiChatMessageUser-branch-label" satisfies AiChatMessageUser_ClassNames}>
								{branchLabel}
							</span>
							<MyIconButton
								variant="ghost"
								tooltip="Next variant"
								onClick={handleBranchNext}
								disabled={isRunning}
								className={"AiChatMessageUser-action-button" satisfies AiChatMessageUser_ClassNames}
							>
								<ChevronRight className={"AiChatMessageUser-action-icon" satisfies AiChatMessageUser_ClassNames} />
							</MyIconButton>
						</div>
					)}
				</div>
			</AiChatMessageBubble>
		</AiChatMessageContainer>
	);
}
// #endregion user message

// #region agent message-
type AiChatMessageAgent_ClassNames =
	| "AiChatMessageAgent"
	| "AiChatMessageAgent-bubble"
	| "AiChatMessageAgent-actions"
	| "AiChatMessageAgent-action-button"
	| "AiChatMessageAgent-action-icon"
	| "AiChatMessageAgent-branch-controls"
	| "AiChatMessageAgent-branch-label";

type AiChatMessageAgent_Props = AiChatMessage_Props;

function AiChatMessageAgent(props: AiChatMessageAgent_Props) {
	const {
		ref,
		id,
		className,
		message,
		selectedThreadId,
		isRunning,
		isEditing,
		messagesChildrenByParentId,
		onToolOutput,
		onToolResumeStream,
		onToolStop,
		onMessageRegenerate,
		onMessageBranchChat,
		onSelectBranchAnchor,
		...rest
	} = props;

	const branchMetadata = ((/* iife */) => {
		const siblings = messagesChildrenByParentId.get(ai_chat_get_parent_id(message.metadata?.convexParentId)) ?? [];
		const currentIndex = siblings.indexOf(message);

		return {
			variantIndex: currentIndex,
			variantCount: siblings.length,
			variantAnchorIds: siblings.map((sibling) => sibling.id),
		} satisfies AiChatMessage_BranchMetadata;
	})();

	const text = ai_chat_get_message_text(message);

	const handleReload = () => {
		if (!selectedThreadId) {
			return;
		}
		onMessageRegenerate({ threadId: selectedThreadId, messageId: message.id });
	};

	const handleBranchChat = () => {
		if (!selectedThreadId || isRunning) {
			return;
		}
		onMessageBranchChat({ threadId: selectedThreadId, messageId: message.id });
	};

	const handleBranchSwitch = (direction: "prev" | "next") => {
		if (isRunning) {
			return;
		}
		if (!branchMetadata || !selectedThreadId) {
			return;
		}

		const navCount = branchMetadata.variantAnchorIds.length;
		if (navCount <= 1) {
			return;
		}

		const nextIndex =
			direction === "prev"
				? (branchMetadata.variantIndex - 1 + navCount) % navCount
				: (branchMetadata.variantIndex + 1) % navCount;
		const nextAnchorId = branchMetadata.variantAnchorIds[nextIndex];
		if (!nextAnchorId) {
			return;
		}

		onSelectBranchAnchor(selectedThreadId, nextAnchorId);
	};

	const handleBranchPrev = () => {
		handleBranchSwitch("prev");
	};

	const handleBranchNext = () => {
		handleBranchSwitch("next");
	};

	const showBranchControls = Boolean(branchMetadata && branchMetadata.variantCount > 1);
	const branchLabel = branchMetadata ? `${branchMetadata.variantIndex + 1}/${branchMetadata.variantCount}` : "";

	return (
		<AiChatMessageContainer
			ref={ref}
			id={id}
			className={cn("AiChatMessageAgent" satisfies AiChatMessageAgent_ClassNames, className)}
			{...rest}
		>
			<AiChatMessageBubble className={"AiChatMessageAgent-bubble" satisfies AiChatMessageAgent_ClassNames}>
				<AiChatMessageContent>
					<AiChatMessagePartsList
						message={message}
						onToolOutput={onToolOutput}
						onToolResumeStream={onToolResumeStream}
						onToolStop={onToolStop}
					/>
				</AiChatMessageContent>
				<div className={"AiChatMessageAgent-actions" satisfies AiChatMessageAgent_ClassNames} hidden={isEditing}>
					<CopyIconButton
						variant="ghost"
						tooltipCopy="Copy message"
						text={text ?? undefined}
						className={"AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames}
						iconClassName={"AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames}
					/>
					<MyIconButton
						variant="ghost"
						tooltip="Branch chat here"
						onClick={handleBranchChat}
						disabled={!selectedThreadId || isRunning}
						className={"AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames}
					>
						<GitBranch className={"AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames} />
					</MyIconButton>
					{showBranchControls && (
						<div className={"AiChatMessageAgent-branch-controls" satisfies AiChatMessageAgent_ClassNames}>
							<MyIconButton
								variant="ghost"
								tooltip="Previous variant"
								onClick={handleBranchPrev}
								disabled={isRunning}
								className={"AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames}
							>
								<ChevronLeft className={"AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames} />
							</MyIconButton>
							<span className={"AiChatMessageAgent-branch-label" satisfies AiChatMessageAgent_ClassNames}>
								{branchLabel}
							</span>
							<MyIconButton
								variant="ghost"
								tooltip="Next variant"
								onClick={handleBranchNext}
								disabled={isRunning}
								className={"AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames}
							>
								<ChevronRight className={"AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames} />
							</MyIconButton>
						</div>
					)}
					<MyIconButton
						variant="ghost"
						tooltip="Regenerate response"
						onClick={handleReload}
						className={"AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames}
					>
						<RefreshCw className={"AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames} />
					</MyIconButton>
				</div>
			</AiChatMessageBubble>
		</AiChatMessageContainer>
	);
}
// #endregion agent message

// #region system message
type AiChatMessageSystem_ClassNames = "AiChatMessageSystem" | "AiChatMessageSystem-bubble";

type AiChatMessageSystem_Props = AiChatMessage_Props;

function AiChatMessageSystem(props: AiChatMessageSystem_Props) {
	const { ref, id, className, message, onToolOutput, onToolResumeStream, onToolStop, ...rest } = props;

	return (
		<AiChatMessageContainer
			ref={ref}
			id={id}
			className={cn("AiChatMessageSystem" satisfies AiChatMessageSystem_ClassNames, className)}
			{...rest}
		>
			<AiChatMessageBubble className={"AiChatMessageSystem-bubble" satisfies AiChatMessageSystem_ClassNames}>
				<AiChatMessageContent>
					<AiChatMessagePartsList
						message={message}
						onToolOutput={onToolOutput}
						onToolResumeStream={onToolResumeStream}
						onToolStop={onToolStop}
					/>
				</AiChatMessageContent>
			</AiChatMessageBubble>
		</AiChatMessageContainer>
	);
}
// #endregion system message

// #region message
type AiChatMessage_BranchMetadata = {
	variantIndex: number;
	variantCount: number;
	variantAnchorIds: string[];
};

export type AiChatMessage_ClassNames = "AiChatMessage";

export type AiChatMessage_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;

	message: ai_chat_AiSdk5UiMessage;
	selectedThreadId: string | null;
	isRunning: boolean;
	isEditing: boolean;
	messagesChildrenByParentId: AiChatController["messagesChildrenByParentId"];
	onToolOutput: AiChatMessagePartsList_Props["onToolOutput"];
	onToolResumeStream: AiChatMessagePartsList_Props["onToolResumeStream"];
	onToolStop: AiChatMessagePartsList_Props["onToolStop"];
	onEditStart: (args: { messageId: string; parentId: string | null }) => void;
	onEditCancel: () => void;
	onEditSubmit: (args: { value: string }) => void;
	onMessageRegenerate: (args: { threadId: string; messageId: string }) => void;
	onMessageBranchChat: (args: { threadId: string; messageId?: string }) => void;
	onSelectBranchAnchor: (threadId: string, anchorId: string) => void;
};

export type AiChatMessage_CustomAttributes = {
	"data-ai-chat-message-id": string;
	"data-ai-chat-message-role": ai_chat_AiSdk5UiMessage["role"];
};

export function AiChatMessage(props: AiChatMessage_Props) {
	const { className, message } = props;

	if (message.role === "user") {
		return (
			<AiChatMessageUser
				className={cn("AiChatMessage" satisfies AiChatMessage_ClassNames, className)}
				{...({
					"data-ai-chat-message-id": message.id,
					"data-ai-chat-message-role": message.role,
				} satisfies Partial<AiChatMessage_CustomAttributes>)}
				{...props}
			/>
		);
	}

	if (message.role === "assistant") {
		return (
			<AiChatMessageAgent
				className={cn("AiChatMessage" satisfies AiChatMessage_ClassNames, className)}
				{...({
					"data-ai-chat-message-id": message.id,
					"data-ai-chat-message-role": message.role,
				} satisfies Partial<AiChatMessage_CustomAttributes>)}
				{...props}
			/>
		);
	}

	return (
		<AiChatMessageSystem
			className={cn("AiChatMessage" satisfies AiChatMessage_ClassNames, className)}
			{...({
				"data-ai-chat-message-id": message.id,
				"data-ai-chat-message-role": message.role,
			} satisfies Partial<AiChatMessage_CustomAttributes>)}
			{...props}
		/>
	);
}
// #endregion message
