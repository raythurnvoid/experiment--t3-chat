import "./ai-chat-message.css";

import type { ComponentPropsWithRef, ReactNode, Ref } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight, FileText, GitBranch, RefreshCw, ShieldQuestion } from "lucide-react";
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
import { AiChatMarkdown, type AiChatMarkdown_Props } from "@/components/ai-chat/ai-chat-markdown.tsx";
import { DiffMonospaceBlock } from "@/components/diff-monospace-block.tsx";
import { MyLink } from "@/components/my-link.tsx";
import { cn, json_strigify_ensured, path_name_of, sx } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { MyButtonIcon } from "../my-button.tsx";

// #region tool chip
type AiChatMessagePartToolChip_ClassNames = "AiChatMessagePartToolChip";

type AiChatMessagePartToolChip_Props = {
	className?: string | undefined;
	children?: ReactNode;
};

function AiChatMessagePartToolChip(props: AiChatMessagePartToolChip_Props) {
	const { className, children } = props;

	return (
		<span className={cn("AiChatMessagePartToolChip" satisfies AiChatMessagePartToolChip_ClassNames, className)}>
			{children}
		</span>
	);
}
// #endregion tool chip

// #region tool status
type AiChatMessagePartToolStatus_ClassNames =
	| "AiChatMessagePartToolStatus"
	| "AiChatMessagePartToolStatus-icon"
	| "AiChatMessagePartToolStatus-state-loading"
	| "AiChatMessagePartToolStatus-state-error"
	| "AiChatMessagePartToolStatus-state-approval";

type AiChatMessagePartToolUiState = ToolUIPart["state"] | "approval-requested" | "approval-responded" | "output-denied";

type AiChatMessagePartToolStatus_Props = {
	state: AiChatMessagePartToolUiState;
};

function AiChatMessagePartToolStatus(props: AiChatMessagePartToolStatus_Props) {
	const { state } = props;

	switch (state) {
		// Loading states: spinner only, no text
		case "input-streaming":
		case "input-available":
			return (
				<span
					className={cn(
						"AiChatMessagePartToolStatus" satisfies AiChatMessagePartToolStatus_ClassNames,
						"AiChatMessagePartToolStatus-state-loading" satisfies AiChatMessagePartToolStatus_ClassNames,
					)}
				>
					<MySpinner size="14px" aria-label="Running" />
				</span>
			);

		// Approval requested: visible indicator since it's actionable
		case "approval-requested":
			return (
				<AiChatMessagePartToolChip
					className={cn(
						"AiChatMessagePartToolStatus" satisfies AiChatMessagePartToolStatus_ClassNames,
						"AiChatMessagePartToolStatus-state-approval" satisfies AiChatMessagePartToolStatus_ClassNames,
					)}
				>
					<ShieldQuestion
						className={"AiChatMessagePartToolStatus-icon" satisfies AiChatMessagePartToolStatus_ClassNames}
					/>
					Awaiting Approval
				</AiChatMessagePartToolChip>
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
						"AiChatMessagePartToolStatus" satisfies AiChatMessagePartToolStatus_ClassNames,
						"AiChatMessagePartToolStatus-state-error" satisfies AiChatMessagePartToolStatus_ClassNames,
					)}
				>
					Failed
				</span>
			);

		case "output-denied":
			return (
				<span
					className={cn(
						"AiChatMessagePartToolStatus" satisfies AiChatMessagePartToolStatus_ClassNames,
						"AiChatMessagePartToolStatus-state-error" satisfies AiChatMessagePartToolStatus_ClassNames,
					)}
				>
					Denied
				</span>
			);
	}
}
// #endregion tool status

// #region tool disclosure
type AiChatMessagePartToolDisclosure_ClassNames = "AiChatMessagePartToolDisclosure";

type AiChatMessagePartToolDisclosure_Props = React.ComponentProps<"details"> & {
	className?: string | undefined;
};

function AiChatMessagePartToolDisclosure(props: AiChatMessagePartToolDisclosure_Props) {
	const { className, ...rest } = props;

	return (
		<details
			className={cn("AiChatMessagePartToolDisclosure" satisfies AiChatMessagePartToolDisclosure_ClassNames, className)}
			{...rest}
		/>
	);
}
// #endregion tool disclosure

// #region tool disclosure button
type AiChatMessagePartToolDisclosureButton_ClassNames =
	| "AiChatMessagePartToolDisclosureButton"
	| "AiChatMessagePartToolDisclosureButton-content"
	| "AiChatMessagePartToolDisclosureButton-label";

type AiChatMessagePartToolDisclosureButton_Props = {
	title: string;
	text?: string;
	state: AiChatMessagePartToolUiState;
	className?: string | undefined;
};

function AiChatMessagePartToolDisclosureButton(props: AiChatMessagePartToolDisclosureButton_Props) {
	const { className, title, text, state } = props;

	const isLoading = state === "input-streaming" || state === "input-available";

	const handleClick: ComponentPropsWithRef<"summary">["onClick"] = (e) => {
		if (isLoading) {
			e.preventDefault();
		}
	};

	return (
		<summary
			className={cn(
				"AiChatMessagePartToolDisclosureButton" satisfies AiChatMessagePartToolDisclosureButton_ClassNames,
				className,
			)}
			aria-busy={isLoading}
			aria-disabled={isLoading}
			onClick={handleClick}
		>
			<div
				className={
					"AiChatMessagePartToolDisclosureButton-content" satisfies AiChatMessagePartToolDisclosureButton_ClassNames
				}
			>
				<b>
					{title}
					{text && `:`}
				</b>
				<span> {text}</span>
				<AiChatMessagePartToolStatus state={state} />
			</div>
		</summary>
	);
}
// #endregion tool disclosure button

// #region tool body
type AiChatMessagePartToolBody_ClassNames = "AiChatMessagePartToolBody";

type AiChatMessagePartToolBody_Props = React.ComponentProps<"div"> & {
	className?: string | undefined;
};

function AiChatMessagePartToolBody(props: AiChatMessagePartToolBody_Props) {
	const { className, ...rest } = props;

	return (
		<div
			className={cn("AiChatMessagePartToolBody" satisfies AiChatMessagePartToolBody_ClassNames, className)}
			{...rest}
		/>
	);
}
// #endregion tool body

// #region tool textarea section
type AiChatMessagePartToolTextAreaSection_ClassNames =
	| "AiChatMessagePartToolTextAreaSection"
	| "AiChatMessagePartToolTextAreaSection-heading"
	| "AiChatMessagePartToolTextAreaSection-textarea"
	| "AiChatMessagePartToolTextAreaSection-state-error";

type AiChatMessagePartToolTextAreaSection_CssVars = {
	"--AiChatMessagePartToolTextAreaSection-max-height": string;
};

const AiChatMessagePartToolTextAreaSection_CssVars_DEFAULTS: AiChatMessagePartToolTextAreaSection_CssVars = {
	"--AiChatMessagePartToolTextAreaSection-max-height": "8lh",
} as const;

type AiChatMessagePartToolTextAreaSection_Props = {
	className?: string | undefined;
	label: string;
	code: string;
	maxHeight?: string | undefined;
	state?: "error" | undefined;
};

function AiChatMessagePartToolTextAreaSection(props: AiChatMessagePartToolTextAreaSection_Props) {
	const { className, label, code, maxHeight, state } = props;

	return (
		<section
			className={cn(
				"AiChatMessagePartToolTextAreaSection" satisfies AiChatMessagePartToolTextAreaSection_ClassNames,
				"app-font-monospace" satisfies AppClassName,
				state === "error" &&
					("AiChatMessagePartToolTextAreaSection-state-error" satisfies AiChatMessagePartToolTextAreaSection_ClassNames),
				className,
			)}
			style={sx({
				...AiChatMessagePartToolTextAreaSection_CssVars_DEFAULTS,
				"--AiChatMessagePartToolTextAreaSection-max-height":
					maxHeight ??
					AiChatMessagePartToolTextAreaSection_CssVars_DEFAULTS["--AiChatMessagePartToolTextAreaSection-max-height"],
			} satisfies AiChatMessagePartToolTextAreaSection_CssVars)}
		>
			<h6
				className={
					"AiChatMessagePartToolTextAreaSection-heading" satisfies AiChatMessagePartToolTextAreaSection_ClassNames
				}
			>
				{label}
			</h6>
			<textarea
				className={
					"AiChatMessagePartToolTextAreaSection-textarea" satisfies AiChatMessagePartToolTextAreaSection_ClassNames
				}
				value={code}
				readOnly
			/>
		</section>
	);
}
// #endregion tool textarea section

// #region tool read_page
type AiChatMessagePartToolReadPage_ClassNames = "AiChatMessagePartToolReadPage" | "AiChatMessagePartToolReadPage-link";

type AiChatMessagePartToolReadPage_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-read_page" }>["input"];
	result: ai_chat_AiSdk5UiTools["read_page"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessagePartToolReadPage(props: AiChatMessagePartToolReadPage_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<AiChatMessagePartToolDisclosure
			className={cn("AiChatMessagePartToolReadPage" satisfies AiChatMessagePartToolReadPage_ClassNames, className)}
		>
			<AiChatMessagePartToolDisclosureButton
				title="Read Page"
				text={args?.path ? path_name_of(args.path) : undefined}
				state={toolState}
			/>
			<AiChatMessagePartToolBody>
				{result?.metadata?.pageId && (
					<MyLink
						className={"AiChatMessagePartToolReadPage-link" satisfies AiChatMessagePartToolReadPage_ClassNames}
						to="/pages"
						search={{ pageId: result.metadata.pageId }}
						variant="button-ghost-accent"
					>
						Open page
						<MyButtonIcon>
							<ArrowUpRight />
						</MyButtonIcon>
					</MyLink>
				)}
				<AiChatMessagePartToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && (
					<AiChatMessagePartToolTextAreaSection label="Content" code={result.output} maxHeight="16lh" />
				)}
			</AiChatMessagePartToolBody>
		</AiChatMessagePartToolDisclosure>
	);
}
// #endregion tool read_page

// #region tool list_pages
type AiChatMessagePartToolListPages_ClassNames = "AiChatMessagePartToolListPages";

type AiChatMessagePartToolListPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-list_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["list_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessagePartToolListPages(props: AiChatMessagePartToolListPages_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<AiChatMessagePartToolDisclosure
			className={cn("AiChatMessagePartToolListPages" satisfies AiChatMessagePartToolListPages_ClassNames, className)}
		>
			<AiChatMessagePartToolDisclosureButton
				title="List Pages"
				text={args?.path ? path_name_of(args.path) || "/ (Home) " : undefined}
				state={toolState}
			/>
			<AiChatMessagePartToolBody>
				<AiChatMessagePartToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && (
					<AiChatMessagePartToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />
				)}
			</AiChatMessagePartToolBody>
		</AiChatMessagePartToolDisclosure>
	);
}
// #endregion tool list_pages

// #region tool glob_pages
type AiChatMessagePartToolGlobPages_ClassNames = "AiChatMessagePartToolGlobPages";

type AiChatMessagePartToolGlobPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-glob_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["glob_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessagePartToolGlobPages(props: AiChatMessagePartToolGlobPages_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<AiChatMessagePartToolDisclosure
			className={cn("AiChatMessagePartToolGlobPages" satisfies AiChatMessagePartToolGlobPages_ClassNames, className)}
		>
			<AiChatMessagePartToolDisclosureButton title="tool-glob_pages" state={toolState} />
			<AiChatMessagePartToolBody>
				<AiChatMessagePartToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && (
					<AiChatMessagePartToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />
				)}
			</AiChatMessagePartToolBody>
		</AiChatMessagePartToolDisclosure>
	);
}
// #endregion tool glob_pages

// #region tool grep_pages
type AiChatMessagePartToolGrepPages_ClassNames = "AiChatMessagePartToolGrepPages";

type AiChatMessagePartToolGrepPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-grep_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["grep_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessagePartToolGrepPages(props: AiChatMessagePartToolGrepPages_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<AiChatMessagePartToolDisclosure
			className={cn("AiChatMessagePartToolGrepPages" satisfies AiChatMessagePartToolGrepPages_ClassNames, className)}
		>
			<AiChatMessagePartToolDisclosureButton title="tool-grep_pages" state={toolState} />
			<AiChatMessagePartToolBody>
				<AiChatMessagePartToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && (
					<AiChatMessagePartToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />
				)}
			</AiChatMessagePartToolBody>
		</AiChatMessagePartToolDisclosure>
	);
}
// #endregion tool grep_pages

// #region tool text_search_pages
type AiChatMessagePartToolTextSearchPages_ClassNames = "AiChatMessagePartToolTextSearchPages";

type AiChatMessagePartToolTextSearchPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-text_search_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["text_search_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessagePartToolTextSearchPages(props: AiChatMessagePartToolTextSearchPages_Props) {
	const { className, args, result, toolState, errorText } = props;

	return (
		<AiChatMessagePartToolDisclosure
			className={cn(
				"AiChatMessagePartToolTextSearchPages" satisfies AiChatMessagePartToolTextSearchPages_ClassNames,
				className,
			)}
		>
			<AiChatMessagePartToolDisclosureButton title="tool-text_search_pages" state={toolState} />
			<AiChatMessagePartToolBody>
				<AiChatMessagePartToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && (
					<AiChatMessagePartToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />
				)}
			</AiChatMessagePartToolBody>
		</AiChatMessagePartToolDisclosure>
	);
}
// #endregion tool text_search_pages

// #region tool write_page
type AiChatMessagePartToolWritePage_ClassNames =
	| "AiChatMessagePartToolWritePage"
	| "AiChatMessagePartToolWritePage-header"
	| "AiChatMessagePartToolWritePage-header-title"
	| "AiChatMessagePartToolWritePage-header-file-icon"
	| "AiChatMessagePartToolWritePage-header-actions"
	| "AiChatMessagePartToolWritePage-header-icon"
	| "AiChatMessagePartToolWritePage-diff";

type AiChatMessagePartToolWritePage_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-write_page" }>["input"];
	result: ai_chat_AiSdk5UiTools["write_page"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessagePartToolWritePage(props: AiChatMessagePartToolWritePage_Props) {
	const { className, args, result, toolState, errorText } = props;

	const pageName = result?.metadata.path
		? path_name_of(result.metadata.path)
		: args?.path
			? path_name_of(args.path)
			: "Writing page";
	const pageId = result?.metadata?.pageId;
	const diffText = result?.metadata?.diff ?? result?.output;

	return (
		<div
			className={cn("AiChatMessagePartToolWritePage" satisfies AiChatMessagePartToolWritePage_ClassNames, className)}
		>
			{pageId ? (
				<MyLink
					className={"AiChatMessagePartToolWritePage-header" satisfies AiChatMessagePartToolWritePage_ClassNames}
					to="/pages"
					search={{ pageId, view: "diff_editor" }}
					variant="button-ghost-accent"
				>
					<MyButtonIcon
						className={
							"AiChatMessagePartToolWritePage-header-file-icon" satisfies AiChatMessagePartToolWritePage_ClassNames
						}
					>
						<FileText />
					</MyButtonIcon>
					<span
						className={
							"AiChatMessagePartToolWritePage-header-title" satisfies AiChatMessagePartToolWritePage_ClassNames
						}
					>
						{pageName}
					</span>
					<span
						className={
							"AiChatMessagePartToolWritePage-header-actions" satisfies AiChatMessagePartToolWritePage_ClassNames
						}
					>
						<AiChatMessagePartToolStatus state={toolState} />
						<MyButtonIcon
							className={
								"AiChatMessagePartToolWritePage-header-icon" satisfies AiChatMessagePartToolWritePage_ClassNames
							}
						>
							<ArrowUpRight />
						</MyButtonIcon>
					</span>
				</MyLink>
			) : (
				<div
					className={"AiChatMessagePartToolWritePage-header" satisfies AiChatMessagePartToolWritePage_ClassNames}
					aria-disabled="true"
				>
					<MyButtonIcon
						className={
							"AiChatMessagePartToolWritePage-header-file-icon" satisfies AiChatMessagePartToolWritePage_ClassNames
						}
					>
						<FileText />
					</MyButtonIcon>
					<span
						className={
							"AiChatMessagePartToolWritePage-header-title" satisfies AiChatMessagePartToolWritePage_ClassNames
						}
					>
						{pageName}
					</span>
					<span
						className={
							"AiChatMessagePartToolWritePage-header-actions" satisfies AiChatMessagePartToolWritePage_ClassNames
						}
					>
						<AiChatMessagePartToolStatus state={toolState} />
						<MyButtonIcon
							className={
								"AiChatMessagePartToolWritePage-header-icon" satisfies AiChatMessagePartToolWritePage_ClassNames
							}
						>
							<ArrowUpRight />
						</MyButtonIcon>
					</span>
				</div>
			)}
			{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
			{diffText && (
				<DiffMonospaceBlock
					className={"AiChatMessagePartToolWritePage-diff" satisfies AiChatMessagePartToolWritePage_ClassNames}
					diffText={diffText}
				/>
			)}
		</div>
	);
}
// #endregion tool write_page

// #region tool edit_page
type AiChatMessagePartToolEditPage_ClassNames = "AiChatMessagePartToolEditPage" | "AiChatMessagePartToolEditPage-link";

type AiChatMessagePartToolEditPage_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-edit_page" }>["input"];
	result: ai_chat_AiSdk5UiTools["edit_page"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	errorText?: string | undefined;
};

function AiChatMessagePartToolEditPage(props: AiChatMessagePartToolEditPage_Props) {
	const { className, args, result, toolState, errorText } = props;

	const resultCode = result?.metadata?.diff ?? result?.output;

	return (
		<AiChatMessagePartToolDisclosure
			className={cn("AiChatMessagePartToolEditPage" satisfies AiChatMessagePartToolEditPage_ClassNames, className)}
		>
			<AiChatMessagePartToolDisclosureButton title="tool-edit_page" state={toolState} />
			<AiChatMessagePartToolBody>
				{result?.metadata?.pageId && (
					<MyLink
						className={"AiChatMessagePartToolEditPage-link" satisfies AiChatMessagePartToolEditPage_ClassNames}
						to="/pages"
						search={{ pageId: result.metadata.pageId }}
						variant="button-ghost-accent"
					>
						Open page
						<MyButtonIcon>
							<ArrowUpRight />
						</MyButtonIcon>
					</MyLink>
				)}
				<AiChatMessagePartToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
				{resultCode && <AiChatMessagePartToolTextAreaSection label="Result" code={resultCode} maxHeight="16lh" />}
			</AiChatMessagePartToolBody>
		</AiChatMessagePartToolDisclosure>
	);
}
// #endregion tool edit_page

// #region tool unknown
type AiChatMessagePartToolUnknown_ClassNames = "AiChatMessagePartToolUnknown" | "AiChatMessagePartToolUnknown-meta";

type AiChatMessagePartToolUnknown_Props = {
	className?: string | undefined;
	part: ToolUIPart<ai_chat_AiSdk5UiTools> | DynamicToolUIPart;
};

function AiChatMessagePartToolUnknown(props: AiChatMessagePartToolUnknown_Props) {
	const { className, part } = props;

	const toolName = part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);
	const output = part.state === "output-available" ? part.output : undefined;
	const errorText = part.state === "output-error" ? part.errorText : undefined;
	const outputCode =
		output === undefined ? undefined : typeof output === "string" ? output : json_strigify_ensured(output);

	return (
		<AiChatMessagePartToolDisclosure
			className={cn("AiChatMessagePartToolUnknown" satisfies AiChatMessagePartToolUnknown_ClassNames, className)}
		>
			<AiChatMessagePartToolDisclosureButton title={`tool-${toolName}`} state={part.state} />
			<AiChatMessagePartToolBody>
				<div className={"AiChatMessagePartToolUnknown-meta" satisfies AiChatMessagePartToolUnknown_ClassNames}>
					<AiChatMessagePartToolChip>type: {part.type}</AiChatMessagePartToolChip>
					<AiChatMessagePartToolChip>toolCallId: {part.toolCallId}</AiChatMessagePartToolChip>
					<AiChatMessagePartToolChip>state: {part.state}</AiChatMessagePartToolChip>
				</div>
				<AiChatMessagePartToolTextAreaSection label="Parameters" code={JSON.stringify(part.input ?? {}, null, "\t")} />
				{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
				{outputCode !== undefined && (
					<AiChatMessagePartToolTextAreaSection label="Result" code={outputCode} maxHeight="16lh" />
				)}
			</AiChatMessagePartToolBody>
		</AiChatMessagePartToolDisclosure>
	);
}
// #endregion tool unknown

// #region markdown
type AiChatMessagePartMarkdown_ClassNames = "AiChatMessagePartMarkdown";

type AiChatMessagePartMarkdown_Props = AiChatMarkdown_Props;

function AiChatMessagePartMarkdown(props: AiChatMessagePartMarkdown_Props) {
	const { className, ...rest } = props;

	return (
		<AiChatMarkdown
			className={cn("AiChatMessagePartMarkdown" satisfies AiChatMessagePartMarkdown_ClassNames, className)}
			{...rest}
		/>
	);
}
// #endregion markdown

// #region part text
type AiChatMessagePartText_ClassNames = "AiChatMessagePartText";

type AiChatMessagePartText_Props = {
	text: string;
};

function AiChatMessagePartText(props: AiChatMessagePartText_Props) {
	const { text } = props;
	return <p className={"AiChatMessagePartText" satisfies AiChatMessagePartText_ClassNames}>{text}</p>;
}
// #endregion part text

// #region part reasoning
type AiChatMessagePartReasoning_ClassNames = "AiChatMessagePartReasoning";

type AiChatMessagePartReasoning_Props = {
	text: string;
};

function AiChatMessagePartReasoning(props: AiChatMessagePartReasoning_Props) {
	const { text } = props;
	return <p className={"AiChatMessagePartReasoning" satisfies AiChatMessagePartReasoning_ClassNames}>{text}</p>;
}
// #endregion part reasoning

// #region part image
type AiChatMessagePartImage_ClassNames = "AiChatMessagePartImage";

type AiChatMessagePartImage_Props = {
	url: string;
	filename: string | undefined;
};

function AiChatMessagePartImage(props: AiChatMessagePartImage_Props) {
	const { url, filename } = props;
	return (
		<img
			className={"AiChatMessagePartImage" satisfies AiChatMessagePartImage_ClassNames}
			src={url}
			alt={filename ?? "Image attachment"}
		/>
	);
}
// #endregion part image

// #region part file
type AiChatMessagePartFile_ClassNames = "AiChatMessagePartFile";

type AiChatMessagePartFile_Props = {
	filename: string | undefined;
};

function AiChatMessagePartFile(props: AiChatMessagePartFile_Props) {
	const { filename } = props;
	return (
		<span className={"AiChatMessagePartFile" satisfies AiChatMessagePartFile_ClassNames}>
			{filename ?? "File attachment"}
		</span>
	);
}
// #endregion part file

// #region part source url
type AiChatMessagePartSourceUrl_ClassNames = "AiChatMessagePartSourceUrl";

type AiChatMessagePartSourceUrl_Props = {
	url: string;
	title: string | undefined;
};

function AiChatMessagePartSourceUrl(props: AiChatMessagePartSourceUrl_Props) {
	const { url, title } = props;
	return (
		<a
			className={"AiChatMessagePartSourceUrl" satisfies AiChatMessagePartSourceUrl_ClassNames}
			href={url}
			target="_blank"
			rel="noreferrer"
		>
			{title ?? url}
		</a>
	);
}
// #endregion part source url

// #region part source document
type AiChatMessagePartSourceDocument_ClassNames = "AiChatMessagePartSourceDocument";

type AiChatMessagePartSourceDocument_Props = {
	title: string | undefined;
	filename: string | undefined;
	sourceId: string;
	mediaType: string;
};

function AiChatMessagePartSourceDocument(props: AiChatMessagePartSourceDocument_Props) {
	const { title: titleProp, filename, sourceId, mediaType } = props;
	const title = titleProp || filename || sourceId;
	return (
		<span
			className={"AiChatMessagePartSourceDocument" satisfies AiChatMessagePartSourceDocument_ClassNames}
			title={`${mediaType}${filename ? ` • ${filename}` : ""}`}
		>
			{title}
		</span>
	);
}
// #endregion part source document

// #region part
type AiChatMessagePart_ClassNames =
	| "AiChatMessagePart"
	| "AiChatMessagePart-tool"
	| "AiChatMessagePart-markdown"
	| "AiChatMessagePart-image"
	| "AiChatMessagePart-file"
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

	const partClass = ((/* iife */) => {
		if (isToolOrDynamicToolUIPart(part)) return "AiChatMessagePart-tool" as const;
		if (isTextUIPart(part) && role === "assistant") return "AiChatMessagePart-markdown" as const;
		if (isFileUIPart(part))
			return part.mediaType.startsWith("image/")
				? ("AiChatMessagePart-image" as const)
				: ("AiChatMessagePart-file" as const);
		if (part.type === "source-url" || part.type === "source-document") return "AiChatMessagePart-source" as const;
		return undefined;
	})() satisfies AiChatMessagePart_ClassNames | undefined;

	return (
		<div
			className={cn("AiChatMessagePart" satisfies AiChatMessagePart_ClassNames, partClass)}
			data-part-type={part.type}
		>
			<AiChatMessagePartInner {...props} />
		</div>
	);
}

function AiChatMessagePartInner(props: AiChatMessagePart_Props) {
	const { role, part } = props;

	if (isToolOrDynamicToolUIPart(part)) {
		if (part.type === "dynamic-tool") {
			return <AiChatMessagePartToolUnknown part={part} />;
		}

		switch (part.type) {
			case "tool-read_page": {
				const result = part.state === "output-available" ? part.output : undefined;
				const errorText = part.state === "output-error" ? part.errorText : undefined;
				return (
					<AiChatMessagePartToolReadPage
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
					<AiChatMessagePartToolListPages
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
					<AiChatMessagePartToolGlobPages
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
					<AiChatMessagePartToolGrepPages
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
					<AiChatMessagePartToolTextSearchPages
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
					<AiChatMessagePartToolWritePage
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
					<AiChatMessagePartToolEditPage
						args={part.input}
						result={result as ai_chat_AiSdk5UiTools["edit_page"]["output"] | undefined}
						toolState={part.state}
						errorText={errorText}
					/>
				);
			}
			default:
				return <AiChatMessagePartToolUnknown part={part} />;
		}
	}

	if (isTextUIPart(part)) {
		if (role === "assistant") {
			return <AiChatMessagePartMarkdown text={part.text} />;
		}

		return <AiChatMessagePartText text={part.text} />;
	}

	if (isReasoningUIPart(part)) {
		return <AiChatMessagePartReasoning text={part.text} />;
	}

	if (isDataUIPart(part)) {
		return null;
	}

	if (isFileUIPart(part)) {
		if (part.mediaType.startsWith("image/")) {
			return <AiChatMessagePartImage url={part.url} filename={part.filename} />;
		}

		return <AiChatMessagePartFile filename={part.filename} />;
	}

	if (part.type === "source-url") {
		return <AiChatMessagePartSourceUrl url={part.url} title={part.title} />;
	}

	if (part.type === "source-document") {
		return (
			<AiChatMessagePartSourceDocument
				title={part.title}
				filename={part.filename}
				sourceId={part.sourceId}
				mediaType={part.mediaType}
			/>
		);
	}

	return null;
}
// #endregion part

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
	message: ai_chat_AiSdk5UiMessage;
	onToolOutput: AiChatMessagePart_Props["onToolOutput"];
	onToolResumeStream: AiChatMessagePart_Props["onToolResumeStream"];
	onToolStop: AiChatMessagePart_Props["onToolStop"];
	children?: ReactNode;
};

function AiChatMessageContent(props: AiChatMessageContent_Props) {
	const { ref, id, className, message, onToolOutput, onToolResumeStream, onToolStop, children, ...rest } = props;

	const displayParts = message.parts.filter((part) => !part.type.startsWith("data-") && part.type !== "step-start");

	return (
		<div
			ref={ref}
			id={id}
			className={cn("AiChatMessageContent" satisfies AiChatMessageContent_ClassNames, className)}
			{...rest}
		>
			{children ??
				displayParts.map((part, index) => (
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

// #region user message
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

type AiChatMessageUser_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;

	message: ai_chat_AiSdk5UiMessage;
	selectedThreadId: string | null;
	isRunning: boolean;
	isEditing: boolean;
	messagesChildrenByParentId: AiChatController["messagesChildrenByParentId"];
	onToolOutput: AiChatMessageContent_Props["onToolOutput"];
	onToolResumeStream: AiChatMessageContent_Props["onToolResumeStream"];
	onToolStop: AiChatMessageContent_Props["onToolStop"];
	onEditStart: AiChatMessage_Props["onEditStart"];
	onEditCancel: AiChatMessage_Props["onEditCancel"];
	onEditSubmit: AiChatMessage_Props["onEditSubmit"];
	onSelectBranchAnchor: AiChatMessage_Props["onSelectBranchAnchor"];
};

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
				<AiChatMessageContent
					message={message}
					onToolOutput={onToolOutput}
					onToolResumeStream={onToolResumeStream}
					onToolStop={onToolStop}
				>
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
					) : null}
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

// #region agent message
type AiChatMessageAgent_ClassNames =
	| "AiChatMessageAgent"
	| "AiChatMessageAgent-bubble"
	| "AiChatMessageAgent-actions"
	| "AiChatMessageAgent-action-button"
	| "AiChatMessageAgent-action-icon"
	| "AiChatMessageAgent-branch-controls"
	| "AiChatMessageAgent-branch-label";

type AiChatMessageAgent_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;

	message: ai_chat_AiSdk5UiMessage;
	selectedThreadId: string | null;
	isRunning: boolean;
	isEditing: boolean;
	messagesChildrenByParentId: AiChatController["messagesChildrenByParentId"];
	onToolOutput: AiChatMessageContent_Props["onToolOutput"];
	onToolResumeStream: AiChatMessageContent_Props["onToolResumeStream"];
	onToolStop: AiChatMessageContent_Props["onToolStop"];
	onMessageRegenerate: AiChatMessage_Props["onMessageRegenerate"];
	onMessageBranchChat: AiChatMessage_Props["onMessageBranchChat"];
	onSelectBranchAnchor: AiChatMessage_Props["onSelectBranchAnchor"];
};

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
				<AiChatMessageContent
					message={message}
					onToolOutput={onToolOutput}
					onToolResumeStream={onToolResumeStream}
					onToolStop={onToolStop}
				/>
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

type AiChatMessageSystem_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;

	message: ai_chat_AiSdk5UiMessage;
	selectedThreadId: string | null;
	isRunning: boolean;
	isEditing: boolean;
	messagesChildrenByParentId: AiChatController["messagesChildrenByParentId"];
	onToolOutput: AiChatMessageContent_Props["onToolOutput"];
	onToolResumeStream: AiChatMessageContent_Props["onToolResumeStream"];
	onToolStop: AiChatMessageContent_Props["onToolStop"];
};

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
				<AiChatMessageContent
					message={message}
					onToolOutput={onToolOutput}
					onToolResumeStream={onToolResumeStream}
					onToolStop={onToolStop}
				/>
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
	onToolOutput: AiChatMessageContent_Props["onToolOutput"];
	onToolResumeStream: AiChatMessageContent_Props["onToolResumeStream"];
	onToolStop: AiChatMessageContent_Props["onToolStop"];
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
		onMessageRegenerate,
		onMessageBranchChat,
		onSelectBranchAnchor,
		...rest
	} = props;

	if (message.role === "user") {
		return (
			<AiChatMessageUser
				ref={ref}
				id={id}
				className={cn("AiChatMessage" satisfies AiChatMessage_ClassNames, className)}
				{...({
					"data-ai-chat-message-id": message.id,
					"data-ai-chat-message-role": message.role,
				} satisfies Partial<AiChatMessage_CustomAttributes>)}
				message={message}
				selectedThreadId={selectedThreadId}
				isRunning={isRunning}
				isEditing={isEditing}
				messagesChildrenByParentId={messagesChildrenByParentId}
				onToolOutput={onToolOutput}
				onToolResumeStream={onToolResumeStream}
				onToolStop={onToolStop}
				onEditStart={onEditStart}
				onEditCancel={onEditCancel}
				onEditSubmit={onEditSubmit}
				onSelectBranchAnchor={onSelectBranchAnchor}
				{...rest}
			/>
		);
	}

	if (message.role === "assistant") {
		return (
			<AiChatMessageAgent
				ref={ref}
				id={id}
				className={cn("AiChatMessage" satisfies AiChatMessage_ClassNames, className)}
				{...({
					"data-ai-chat-message-id": message.id,
					"data-ai-chat-message-role": message.role,
				} satisfies Partial<AiChatMessage_CustomAttributes>)}
				message={message}
				selectedThreadId={selectedThreadId}
				isRunning={isRunning}
				isEditing={isEditing}
				messagesChildrenByParentId={messagesChildrenByParentId}
				onToolOutput={onToolOutput}
				onToolResumeStream={onToolResumeStream}
				onToolStop={onToolStop}
				onMessageRegenerate={onMessageRegenerate}
				onMessageBranchChat={onMessageBranchChat}
				onSelectBranchAnchor={onSelectBranchAnchor}
				{...rest}
			/>
		);
	}

	return (
		<AiChatMessageSystem
			ref={ref}
			id={id}
			className={cn("AiChatMessage" satisfies AiChatMessage_ClassNames, className)}
			{...({
				"data-ai-chat-message-id": message.id,
				"data-ai-chat-message-role": message.role,
			} satisfies Partial<AiChatMessage_CustomAttributes>)}
			message={message}
			selectedThreadId={selectedThreadId}
			isRunning={isRunning}
			isEditing={isEditing}
			messagesChildrenByParentId={messagesChildrenByParentId}
			onToolOutput={onToolOutput}
			onToolResumeStream={onToolResumeStream}
			onToolStop={onToolStop}
			{...rest}
		/>
	);
}
// #endregion message
