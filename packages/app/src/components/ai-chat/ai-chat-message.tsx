import "./ai-chat-message.css";

import type { ComponentProps, ComponentPropsWithRef, ReactNode, Ref } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, GitBranch, RefreshCw, ShieldQuestion, XCircle } from "lucide-react";
import { MySpinner } from "@/components/ui/my-spinner.tsx";
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

import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import type { AiChatController } from "@/hooks/ai-chat-hooks.tsx";
import { ai_chat_get_parent_id } from "@/hooks/ai-chat-hooks.tsx";
import { AiChatComposer, type AiChatComposer_Props } from "@/components/ai-chat/ai-chat-composer.tsx";
import { AiChatMarkdown } from "@/components/ai-chat/ai-chat-markdown.tsx";
import { cn, json_strigify_ensured, path_name_of, sx } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";

// #region tool chip
type AiChatMessageToolChip_ClassNames = "AiChatMessageToolChip";

type AiChatMessageToolChip_Props = {
	className?: string | undefined;
	children?: ReactNode;
};

function AiChatMessageToolChip(props: AiChatMessageToolChip_Props) {
	const { className, children } = props;

	return (
		<span className={cn("AiChatMessageToolChip" satisfies AiChatMessageToolChip_ClassNames, className)}>
			{children}
		</span>
	);
}
// #endregion tool chip

// #region tool status
type AiChatMessageToolStatus_ClassNames =
	| "AiChatMessageToolStatus"
	| "AiChatMessageToolStatus-icon"
	| "AiChatMessageToolStatus-state-loading"
	| "AiChatMessageToolStatus-state-error"
	| "AiChatMessageToolStatus-state-approval";

type AiChatMessageToolUiState = ToolUIPart["state"] | "approval-requested" | "approval-responded" | "output-denied";

type AiChatMessageToolStatus_Props = {
	state: AiChatMessageToolUiState;
};

function AiChatMessageToolStatus(props: AiChatMessageToolStatus_Props) {
	const { state } = props;

	switch (state) {
		// Loading states: spinner only, no text
		case "input-streaming":
		case "input-available":
			return (
				<span
					className={cn(
						"AiChatMessageToolStatus" satisfies AiChatMessageToolStatus_ClassNames,
						"AiChatMessageToolStatus-state-loading" satisfies AiChatMessageToolStatus_ClassNames,
					)}
				>
					<MySpinner size="14px" aria-label="Running" />
				</span>
			);

		// Approval requested: visible indicator since it's actionable
		case "approval-requested":
			return (
				<AiChatMessageToolChip
					className={cn(
						"AiChatMessageToolStatus" satisfies AiChatMessageToolStatus_ClassNames,
						"AiChatMessageToolStatus-state-approval" satisfies AiChatMessageToolStatus_ClassNames,
					)}
				>
					<ShieldQuestion className={"AiChatMessageToolStatus-icon" satisfies AiChatMessageToolStatus_ClassNames} />
					Awaiting Approval
				</AiChatMessageToolChip>
			);

		// Success states: show nothing
		case "approval-responded":
		case "output-available":
			return null;

		// Error states: red icon + label
		case "output-error":
			return (
				<span
					className={cn(
						"AiChatMessageToolStatus" satisfies AiChatMessageToolStatus_ClassNames,
						"AiChatMessageToolStatus-state-error" satisfies AiChatMessageToolStatus_ClassNames,
					)}
				>
					Failed
				</span>
			);

		case "output-denied":
			return (
				<span
					className={cn(
						"AiChatMessageToolStatus" satisfies AiChatMessageToolStatus_ClassNames,
						"AiChatMessageToolStatus-state-error" satisfies AiChatMessageToolStatus_ClassNames,
					)}
				>
					Denied
				</span>
			);
	}
}
// #endregion tool status

// #region tool disclosure
type AiChatMessageToolDisclosure_ClassNames = "AiChatMessageToolDisclosure";

type AiChatMessageToolDisclosure_Props = React.ComponentProps<"details"> & {
	className?: string | undefined;
};

function AiChatMessageToolDisclosure(props: AiChatMessageToolDisclosure_Props) {
	const { className, ...rest } = props;

	return (
		<details
			className={cn("AiChatMessageToolDisclosure" satisfies AiChatMessageToolDisclosure_ClassNames, className)}
			{...rest}
		/>
	);
}
// #endregion tool disclosure

// #region tool disclosure button
type AiChatMessageToolDisclosureButton_ClassNames =
	| "AiChatMessageToolDisclosureButton"
	| "AiChatMessageToolDisclosureButton-content"
	| "AiChatMessageToolDisclosureButton-label";

type AiChatMessageToolDisclosureButton_Props = {
	title: string;
	text?: string;
	state: AiChatMessageToolUiState;
	className?: string | undefined;
};

function AiChatMessageToolDisclosureButton(props: AiChatMessageToolDisclosureButton_Props) {
	const { className, title, text, state } = props;

	const isLoading = state === "input-streaming" || state === "input-available";

	const handleClick: ComponentProps<"summary">["onClick"] = (e) => {
		if (isLoading) {
			e.preventDefault();
		}
	};

	return (
		<summary
			className={cn(
				"AiChatMessageToolDisclosureButton" satisfies AiChatMessageToolDisclosureButton_ClassNames,
				className,
			)}
			aria-busy={isLoading}
			aria-disabled={isLoading}
			onClick={handleClick}
		>
			<div
				className={"AiChatMessageToolDisclosureButton-content" satisfies AiChatMessageToolDisclosureButton_ClassNames}
			>
				<b>
					{title}
					{text && `:`}
				</b>
				<span> {text}</span>
				<AiChatMessageToolStatus state={state} />
			</div>
		</summary>
	);
}
// #endregion tool disclosure button

// #region tool body
type AiChatMessageToolBody_ClassNames = "AiChatMessageToolBody";

type AiChatMessageToolBody_Props = React.ComponentProps<"div"> & {
	className?: string | undefined;
};

function AiChatMessageToolBody(props: AiChatMessageToolBody_Props) {
	const { className, ...rest } = props;

	return (
		<div className={cn("AiChatMessageToolBody" satisfies AiChatMessageToolBody_ClassNames, className)} {...rest} />
	);
}
// #endregion tool body

// #region tool textarea section
type AiChatMessageToolTextAreaSection_ClassNames =
	| "AiChatMessageToolTextAreaSection"
	| "AiChatMessageToolTextAreaSection-heading"
	| "AiChatMessageToolTextAreaSection-textarea"
	| "AiChatMessageToolTextAreaSection-state-error";

type AiChatMessageToolTextAreaSection_CssVars = {
	"--AiChatMessageToolTextAreaSection-max-height": string;
};

const AiChatMessageToolTextAreaSection_CssVars_DEFAULTS: AiChatMessageToolTextAreaSection_CssVars = {
	"--AiChatMessageToolTextAreaSection-max-height": "8lh",
} as const;

type AiChatMessageToolTextAreaSection_Props = {
	className?: string | undefined;
	label: string;
	code: string;
	maxHeight?: string | undefined;
	state?: "error" | undefined;
};

function AiChatMessageToolTextAreaSection(props: AiChatMessageToolTextAreaSection_Props) {
	const { className, label, code, maxHeight, state } = props;

	return (
		<section
			className={cn(
				"AiChatMessageToolTextAreaSection" satisfies AiChatMessageToolTextAreaSection_ClassNames,
				"app-font-monospace" satisfies AppClassName,
				state === "error" &&
					("AiChatMessageToolTextAreaSection-state-error" satisfies AiChatMessageToolTextAreaSection_ClassNames),
				className,
			)}
			style={sx({
				...AiChatMessageToolTextAreaSection_CssVars_DEFAULTS,
				"--AiChatMessageToolTextAreaSection-max-height":
					maxHeight ??
					AiChatMessageToolTextAreaSection_CssVars_DEFAULTS["--AiChatMessageToolTextAreaSection-max-height"],
			} satisfies AiChatMessageToolTextAreaSection_CssVars)}
		>
			<h6 className={"AiChatMessageToolTextAreaSection-heading" satisfies AiChatMessageToolTextAreaSection_ClassNames}>
				{label}
			</h6>
			<textarea
				className={"AiChatMessageToolTextAreaSection-textarea" satisfies AiChatMessageToolTextAreaSection_ClassNames}
				value={code}
				readOnly
			/>
		</section>
	);
}
// #endregion tool textarea section

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
				<AiChatMessageToolChip>title: {String(metadata.title)}</AiChatMessageToolChip>
			) : null}
			{"count" in metadata && metadata.count !== undefined ? (
				<AiChatMessageToolChip>count: {String(metadata.count)}</AiChatMessageToolChip>
			) : null}
			{"matches" in metadata && metadata.matches !== undefined ? (
				<AiChatMessageToolChip>matches: {String(metadata.matches)}</AiChatMessageToolChip>
			) : null}
			{"truncated" in metadata && metadata.truncated !== undefined ? (
				<AiChatMessageToolChip>truncated: {String(metadata.truncated)}</AiChatMessageToolChip>
			) : null}
			{"preview" in metadata && metadata.preview ? (
				<AiChatMessageToolChip>preview: {String(metadata.preview).slice(0, 30)}...</AiChatMessageToolChip>
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
		<AiChatMessageToolDisclosure
			className={cn("AiChatMessageToolReadPage" satisfies AiChatMessageToolReadPage_ClassNames, className)}
		>
			<AiChatMessageToolDisclosureButton
				title="Read Page"
				text={args?.path ? path_name_of(args.path) : undefined}
				state={toolState}
			/>
			<AiChatMessageToolBody>
				<AiChatMessageToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessageToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && <AiChatMessageToolTextAreaSection label="Content" code={result.output} maxHeight="16lh" />}
			</AiChatMessageToolBody>
		</AiChatMessageToolDisclosure>
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
		<AiChatMessageToolDisclosure
			className={cn("AiChatMessageToolListPages" satisfies AiChatMessageToolListPages_ClassNames, className)}
		>
			<AiChatMessageToolDisclosureButton
				title="List Pages"
				text={args?.path ? path_name_of(args.path) || "/ (Home) " : undefined}
				state={toolState}
			/>
			<AiChatMessageToolBody>
				<AiChatMessageToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessageToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && <AiChatMessageToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />}
			</AiChatMessageToolBody>
		</AiChatMessageToolDisclosure>
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
		<AiChatMessageToolDisclosure
			className={cn("AiChatMessageToolGlobPages" satisfies AiChatMessageToolGlobPages_ClassNames, className)}
		>
			<AiChatMessageToolDisclosureButton title="tool-glob_pages" state={toolState} />
			<AiChatMessageToolBody>
				<AiChatMessageToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessageToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && <AiChatMessageToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />}
			</AiChatMessageToolBody>
		</AiChatMessageToolDisclosure>
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
		<AiChatMessageToolDisclosure
			className={cn("AiChatMessageToolGrepPages" satisfies AiChatMessageToolGrepPages_ClassNames, className)}
		>
			<AiChatMessageToolDisclosureButton title="tool-grep_pages" state={toolState} />
			<AiChatMessageToolBody>
				<AiChatMessageToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessageToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && <AiChatMessageToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />}
			</AiChatMessageToolBody>
		</AiChatMessageToolDisclosure>
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
		<AiChatMessageToolDisclosure
			className={cn(
				"AiChatMessageToolTextSearchPages" satisfies AiChatMessageToolTextSearchPages_ClassNames,
				className,
			)}
		>
			<AiChatMessageToolDisclosureButton title="tool-text_search_pages" state={toolState} />
			<AiChatMessageToolBody>
				<AiChatMessageToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessageToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && <AiChatMessageToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />}
			</AiChatMessageToolBody>
		</AiChatMessageToolDisclosure>
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

	const resultCode = result?.metadata?.diff ?? result?.output;

	return (
		<AiChatMessageToolDisclosure
			className={cn("AiChatMessageToolWritePage" satisfies AiChatMessageToolWritePage_ClassNames, className)}
		>
			<AiChatMessageToolDisclosureButton title="tool-write_page" state={toolState} />
			<AiChatMessageToolBody>
				<AiChatMessageToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessageToolTextAreaSection label="Error" code={errorText} state="error" />}
				{resultCode && <AiChatMessageToolTextAreaSection label="Result" code={resultCode} maxHeight="16lh" />}
			</AiChatMessageToolBody>
		</AiChatMessageToolDisclosure>
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

	const resultCode = result?.metadata?.diff ?? result?.output;

	return (
		<AiChatMessageToolDisclosure
			className={cn("AiChatMessageToolEditPage" satisfies AiChatMessageToolEditPage_ClassNames, className)}
		>
			<AiChatMessageToolDisclosureButton title="tool-edit_page" state={toolState} />
			<AiChatMessageToolBody>
				<AiChatMessageToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessageToolTextAreaSection label="Error" code={errorText} state="error" />}
				{resultCode && <AiChatMessageToolTextAreaSection label="Result" code={resultCode} maxHeight="16lh" />}
			</AiChatMessageToolBody>
		</AiChatMessageToolDisclosure>
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
	const outputCode =
		output === undefined ? undefined : typeof output === "string" ? output : json_strigify_ensured(output);

	return (
		<AiChatMessageToolDisclosure
			className={cn("AiChatMessageToolUnknown" satisfies AiChatMessageToolUnknown_ClassNames, className)}
		>
			<AiChatMessageToolDisclosureButton title={`tool-${toolName}`} state={part.state} />
			<AiChatMessageToolBody>
				<div className={"AiChatMessageToolUnknown-meta" satisfies AiChatMessageToolUnknown_ClassNames}>
					<AiChatMessageToolChip>type: {part.type}</AiChatMessageToolChip>
					<AiChatMessageToolChip>toolCallId: {part.toolCallId}</AiChatMessageToolChip>
					<AiChatMessageToolChip>state: {part.state}</AiChatMessageToolChip>
				</div>
				<AiChatMessageToolTextAreaSection label="Parameters" code={JSON.stringify(part.input ?? {}, null, "\t")} />
				{errorText && <AiChatMessageToolTextAreaSection label="Error" code={errorText} state="error" />}
				{outputCode !== undefined && (
					<AiChatMessageToolTextAreaSection label="Result" code={outputCode} maxHeight="16lh" />
				)}
			</AiChatMessageToolBody>
		</AiChatMessageToolDisclosure>
	);
}
// #endregion tool unknown

// #region part
type AiChatMessagePart_ClassNames =
	| "AiChatMessagePart"
	| "AiChatMessagePart-tool"
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
	return (
		<div className={"AiChatMessagePart" satisfies AiChatMessagePart_ClassNames}>
			<AiChatMessagePartInner {...props} />
		</div>
	);
}

function AiChatMessagePartInner(props: AiChatMessagePart_Props) {
	const { role, part } = props;

	if (isToolOrDynamicToolUIPart(part)) {
		if (part.type === "dynamic-tool") {
			return (
				<AiChatMessageToolUnknown
					part={part}
					className={"AiChatMessagePart-tool" satisfies AiChatMessagePart_ClassNames}
				/>
			);
		}

		switch (part.type) {
			case "tool-read_page": {
				const result = part.state === "output-available" ? part.output : undefined;
				const errorText = part.state === "output-error" ? part.errorText : undefined;
				return (
					<AiChatMessageToolReadPage
						className={"AiChatMessagePart-tool" satisfies AiChatMessagePart_ClassNames}
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
						className={"AiChatMessagePart-tool" satisfies AiChatMessagePart_ClassNames}
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
						className={"AiChatMessagePart-tool" satisfies AiChatMessagePart_ClassNames}
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
						className={"AiChatMessagePart-tool" satisfies AiChatMessagePart_ClassNames}
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
						className={"AiChatMessagePart-tool" satisfies AiChatMessagePart_ClassNames}
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
						className={"AiChatMessagePart-tool" satisfies AiChatMessagePart_ClassNames}
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
						className={"AiChatMessagePart-tool" satisfies AiChatMessagePart_ClassNames}
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
						className={"AiChatMessagePart-tool" satisfies AiChatMessagePart_ClassNames}
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
								variant="ghost-highlightable"
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
								variant="ghost-highlightable"
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
