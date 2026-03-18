import "./ai-chat-message.css";

import {
	memo,
	useDeferredValue,
	useEffect,
	useRef,
	useState,
	type ComponentPropsWithRef,
	type ReactNode,
	type Ref,
} from "react";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	ArrowUpRight,
	ChevronLeft,
	ChevronRight,
	FilePenLine,
	FileText,
	GitBranch,
	RefreshCw,
	ShieldQuestion,
} from "lucide-react";
import { MySpinner } from "@/components/my-spinner.tsx";
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
import {
	ai_chat_MAIN_MODEL_IDS,
	ai_chat_get_message_text,
	type ai_chat_AiSdk5UiMessage,
	type ai_chat_AiSdk5UiTools,
	type ai_chat_MainModelId,
} from "@/lib/ai-chat.ts";

import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import type { AiChatController } from "@/hooks/ai-chat-hooks.tsx";
import { AiChatComposer, type AiChatComposer_Props } from "@/components/ai-chat/ai-chat-composer.tsx";
import { AiChatMarkdown, type AiChatMarkdown_Props } from "@/components/ai-chat/ai-chat-markdown.tsx";
import { DiffMonospaceBlock } from "@/components/monospace-block/monospace-block-diff.tsx";
import { TextMonospaceBlock } from "@/components/monospace-block/monospace-block-text.tsx";
import { MyLink } from "@/components/my-link.tsx";
import { cn, json_strigify_ensured, path_name_of, sx } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { MyButtonIcon, type MyButton_ClassNames } from "../my-button.tsx";

// #region tool chip
type AiChatMessagePartToolChip_ClassNames = "AiChatMessagePartToolChip";

type AiChatMessagePartToolChip_Props = {
	className?: string | undefined;
	children?: ReactNode;
};

const AiChatMessagePartToolChip = memo(function AiChatMessagePartToolChip(props: AiChatMessagePartToolChip_Props) {
	const { className, children } = props;

	return (
		<span className={cn("AiChatMessagePartToolChip" satisfies AiChatMessagePartToolChip_ClassNames, className)}>
			{children}
		</span>
	);
});
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
	isChatRunning: boolean;
};

const AiChatMessagePartToolStatus = memo(function AiChatMessagePartToolStatus(props: AiChatMessagePartToolStatus_Props) {
	const { state, isChatRunning } = props;

	const isLoading = state === "input-streaming" || state === "input-available";
	const isSuccess = state === "approval-responded" || state === "output-available";
	if ((isLoading && !isChatRunning) || isSuccess) {
		return null;
	}

	return (
		<span
			className={cn(
				"AiChatMessagePartToolStatus" satisfies AiChatMessagePartToolStatus_ClassNames,
				state === "approval-requested" && ("AiChatMessagePartToolChip" satisfies AiChatMessagePartToolChip_ClassNames),
				isLoading && ("AiChatMessagePartToolStatus-state-loading" satisfies AiChatMessagePartToolStatus_ClassNames),
				state === "approval-requested" &&
					("AiChatMessagePartToolStatus-state-approval" satisfies AiChatMessagePartToolStatus_ClassNames),
				(state === "output-error" || state === "output-denied") &&
					("AiChatMessagePartToolStatus-state-error" satisfies AiChatMessagePartToolStatus_ClassNames),
			)}
		>
			{isLoading ? (
				<MySpinner size="14px" aria-label="Running" />
			) : state === "approval-requested" ? (
				<>
					<ShieldQuestion
						className={"AiChatMessagePartToolStatus-icon" satisfies AiChatMessagePartToolStatus_ClassNames}
					/>
					awaiting approval
				</>
			) : state === "output-error" ? (
				"failed"
			) : state === "output-denied" ? (
				"denied"
			) : null}
		</span>
	);
});
// #endregion tool status

// #region part disclosure
type AiChatMessagePartDisclosure_ClassNames = "AiChatMessagePartDisclosure";

type AiChatMessagePartDisclosure_Props = React.ComponentProps<"details"> & {
	className?: string | undefined;
};

const AiChatMessagePartDisclosure = memo(function AiChatMessagePartDisclosure(props: AiChatMessagePartDisclosure_Props) {
	const { className, ...rest } = props;

	return (
		<details
			className={cn("AiChatMessagePartDisclosure" satisfies AiChatMessagePartDisclosure_ClassNames, className)}
			{...rest}
		/>
	);
});
// #endregion part disclosure

// #region part disclosure button
type AiChatMessagePartDisclosureButton_ClassNames =
	| "AiChatMessagePartDisclosureButton"
	| "AiChatMessagePartDisclosureButton-content"
	| "AiChatMessagePartDisclosureButton-label"
	| "AiChatMessagePartDisclosureButton-label-text";

type AiChatMessagePartDisclosureButton_Props = {
	className?: string | undefined;
	title: string;
	text?: string;
	state: AiChatMessagePartToolUiState;
	isChatRunning: boolean;
};

const AiChatMessagePartDisclosureButton = memo(function AiChatMessagePartDisclosureButton(
	props: AiChatMessagePartDisclosureButton_Props,
) {
	const { className, title, text, state, isChatRunning } = props;

	const isLoading = isChatRunning && (state === "input-streaming" || state === "input-available");
	const labelText = `${title}${text ? ":" : ""}`;

	const handleClick = useFn<ComponentPropsWithRef<"summary">["onClick"]>((e) => {
		if (isLoading) {
			e.preventDefault();
		}
	});

	return (
		<summary
			className={cn(
				"AiChatMessagePartDisclosureButton" satisfies AiChatMessagePartDisclosureButton_ClassNames,
				className,
			)}
			aria-busy={isLoading}
			aria-disabled={isLoading}
			onClick={handleClick}
		>
			<div
				className={"AiChatMessagePartDisclosureButton-content" satisfies AiChatMessagePartDisclosureButton_ClassNames}
			>
				<b className={"AiChatMessagePartDisclosureButton-label" satisfies AiChatMessagePartDisclosureButton_ClassNames}>
					<span
						className={
							"AiChatMessagePartDisclosureButton-label-text" satisfies AiChatMessagePartDisclosureButton_ClassNames
						}
					>
						{labelText}
					</span>
				</b>
				<span> {text}</span>
				<AiChatMessagePartToolStatus state={state} isChatRunning={isChatRunning} />
			</div>
		</summary>
	);
});
// #endregion part disclosure button

// #region tool body
type AiChatMessagePartToolBody_ClassNames = "AiChatMessagePartToolBody";

type AiChatMessagePartToolBody_Props = React.ComponentProps<"div"> & {
	className?: string | undefined;
};

const AiChatMessagePartToolBody = memo(function AiChatMessagePartToolBody(props: AiChatMessagePartToolBody_Props) {
	const { className, ...rest } = props;

	return (
		<div
			className={cn("AiChatMessagePartToolBody" satisfies AiChatMessagePartToolBody_ClassNames, className)}
			{...rest}
		/>
	);
});
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

const AiChatMessagePartToolTextAreaSection = memo(function AiChatMessagePartToolTextAreaSection(
	props: AiChatMessagePartToolTextAreaSection_Props,
) {
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
			<TextMonospaceBlock
				className={
					"AiChatMessagePartToolTextAreaSection-textarea" satisfies AiChatMessagePartToolTextAreaSection_ClassNames
				}
				text={code}
			/>
		</section>
	);
});
// #endregion tool textarea section

// #region tool read_page
type AiChatMessagePartToolReadPage_ClassNames = "AiChatMessagePartToolReadPage" | "AiChatMessagePartToolReadPage-link";

type AiChatMessagePartToolReadPage_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-read_page" }>["input"];
	result: ai_chat_AiSdk5UiTools["read_page"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	isChatRunning: boolean;
	errorText?: string | undefined;
};

const AiChatMessagePartToolReadPage = memo(function AiChatMessagePartToolReadPage(
	props: AiChatMessagePartToolReadPage_Props,
) {
	const { className, args, result, toolState, isChatRunning, errorText } = props;

	return (
		<AiChatMessagePartDisclosure
			className={cn("AiChatMessagePartToolReadPage" satisfies AiChatMessagePartToolReadPage_ClassNames, className)}
		>
			<AiChatMessagePartDisclosureButton
				title="Read page"
				text={args?.path ? path_name_of(args.path) : "/ (Home)"}
				state={toolState}
				isChatRunning={isChatRunning}
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
		</AiChatMessagePartDisclosure>
	);
});
// #endregion tool read_page

// #region tool list_pages
type AiChatMessagePartToolListPages_ClassNames = "AiChatMessagePartToolListPages";

type AiChatMessagePartToolListPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-list_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["list_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	isChatRunning: boolean;
	errorText?: string | undefined;
};

const AiChatMessagePartToolListPages = memo(function AiChatMessagePartToolListPages(
	props: AiChatMessagePartToolListPages_Props,
) {
	const { className, args, result, toolState, isChatRunning, errorText } = props;

	const text = args?.path ? path_name_of(args.path) || "/ (Home) " : undefined;

	return (
		<AiChatMessagePartDisclosure
			className={cn("AiChatMessagePartToolListPages" satisfies AiChatMessagePartToolListPages_ClassNames, className)}
		>
			<AiChatMessagePartDisclosureButton
				title="List pages"
				text={text}
				state={toolState}
				isChatRunning={isChatRunning}
			/>
			<AiChatMessagePartToolBody>
				<AiChatMessagePartToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && (
					<AiChatMessagePartToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />
				)}
			</AiChatMessagePartToolBody>
		</AiChatMessagePartDisclosure>
	);
});
// #endregion tool list_pages

// #region tool glob_pages
type AiChatMessagePartToolGlobPages_ClassNames = "AiChatMessagePartToolGlobPages";

type AiChatMessagePartToolGlobPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-glob_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["glob_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	isChatRunning: boolean;
	errorText?: string | undefined;
};

const AiChatMessagePartToolGlobPages = memo(function AiChatMessagePartToolGlobPages(
	props: AiChatMessagePartToolGlobPages_Props,
) {
	const { className, args, result, toolState, isChatRunning, errorText } = props;

	const text = result?.metadata?.count ? `${result.metadata.count} results` : args?.pattern ? args.pattern : undefined;

	return (
		<AiChatMessagePartDisclosure
			className={cn("AiChatMessagePartToolGlobPages" satisfies AiChatMessagePartToolGlobPages_ClassNames, className)}
		>
			<AiChatMessagePartDisclosureButton
				title="Glob pages"
				text={text}
				state={toolState}
				isChatRunning={isChatRunning}
			/>
			<AiChatMessagePartToolBody>
				<AiChatMessagePartToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && (
					<AiChatMessagePartToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />
				)}
			</AiChatMessagePartToolBody>
		</AiChatMessagePartDisclosure>
	);
});
// #endregion tool glob_pages

// #region tool grep_pages
type AiChatMessagePartToolGrepPages_ClassNames = "AiChatMessagePartToolGrepPages";

type AiChatMessagePartToolGrepPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-grep_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["grep_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	isChatRunning: boolean;
	errorText?: string | undefined;
};

const AiChatMessagePartToolGrepPages = memo(function AiChatMessagePartToolGrepPages(
	props: AiChatMessagePartToolGrepPages_Props,
) {
	const { className, args, result, toolState, isChatRunning, errorText } = props;

	const text = result?.metadata?.matches
		? `${result.metadata.matches} results`
		: args?.pattern
			? args.pattern
			: undefined;

	return (
		<AiChatMessagePartDisclosure
			className={cn("AiChatMessagePartToolGrepPages" satisfies AiChatMessagePartToolGrepPages_ClassNames, className)}
		>
			<AiChatMessagePartDisclosureButton
				title="Grep pages"
				text={text}
				state={toolState}
				isChatRunning={isChatRunning}
			/>
			<AiChatMessagePartToolBody>
				<AiChatMessagePartToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && (
					<AiChatMessagePartToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />
				)}
			</AiChatMessagePartToolBody>
		</AiChatMessagePartDisclosure>
	);
});
// #endregion tool grep_pages

// #region tool text_search_pages
type AiChatMessagePartToolTextSearchPages_ClassNames = "AiChatMessagePartToolTextSearchPages";

type AiChatMessagePartToolTextSearchPages_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-text_search_pages" }>["input"];
	result: ai_chat_AiSdk5UiTools["text_search_pages"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	isChatRunning: boolean;
	errorText?: string | undefined;
};

const AiChatMessagePartToolTextSearchPages = memo(function AiChatMessagePartToolTextSearchPages(
	props: AiChatMessagePartToolTextSearchPages_Props,
) {
	const { className, args, result, toolState, isChatRunning, errorText } = props;

	const text = result?.metadata?.matches ? `${result.metadata.matches} results` : args?.query ? args.query : undefined;

	return (
		<AiChatMessagePartDisclosure
			className={cn(
				"AiChatMessagePartToolTextSearchPages" satisfies AiChatMessagePartToolTextSearchPages_ClassNames,
				className,
			)}
		>
			<AiChatMessagePartDisclosureButton
				title={"Search pages"}
				text={text}
				state={toolState}
				isChatRunning={isChatRunning}
			/>
			<AiChatMessagePartToolBody>
				<AiChatMessagePartToolTextAreaSection label="Parameters" code={JSON.stringify(args ?? {}, null, "\t")} />
				{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
				{result?.output && (
					<AiChatMessagePartToolTextAreaSection label="Result" code={result.output} maxHeight="16lh" />
				)}
			</AiChatMessagePartToolBody>
		</AiChatMessagePartDisclosure>
	);
});
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
	isChatRunning: boolean;
	errorText?: string | undefined;
};

const AiChatMessagePartToolWritePage = memo(function AiChatMessagePartToolWritePage(
	props: AiChatMessagePartToolWritePage_Props,
) {
	const { className, args, result, toolState, isChatRunning, errorText } = props;

	const deferredContent = useDeferredValue(args?.content);

	const title = result?.metadata?.path
		? `Write page: ${path_name_of(result.metadata.path)}`
		: args?.path
			? `Write page: ${path_name_of(args.path)}`
			: "Write page";

	const pageId = result?.metadata?.pageId;
	const output = result?.metadata?.diff ?? result?.output;

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
						{title}
					</span>
					<span
						className={
							"AiChatMessagePartToolWritePage-header-actions" satisfies AiChatMessagePartToolWritePage_ClassNames
						}
					>
						<AiChatMessagePartToolStatus state={toolState} isChatRunning={isChatRunning} />
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
					className={cn(
						"AiChatMessagePartToolWritePage-header" satisfies AiChatMessagePartToolWritePage_ClassNames,
						"MyButton" satisfies MyButton_ClassNames,
						"MyButton-variant-ghost-accent" satisfies MyButton_ClassNames,
						"MyButton-state-disabled" satisfies MyButton_ClassNames,
					)}
				>
					<MyButtonIcon
						className={
							"AiChatMessagePartToolWritePage-header-file-icon" satisfies AiChatMessagePartToolWritePage_ClassNames
						}
					>
						<FilePenLine />
					</MyButtonIcon>
					<span
						className={
							"AiChatMessagePartToolWritePage-header-title" satisfies AiChatMessagePartToolWritePage_ClassNames
						}
					>
						{title}
					</span>
					<span
						className={
							"AiChatMessagePartToolWritePage-header-actions" satisfies AiChatMessagePartToolWritePage_ClassNames
						}
					>
						<AiChatMessagePartToolStatus state={toolState} isChatRunning={isChatRunning} />
					</span>
				</div>
			)}

			{errorText && <AiChatMessagePartToolTextAreaSection label="Error" code={errorText} state="error" />}
			{output ? (
				<DiffMonospaceBlock
					className={"AiChatMessagePartToolWritePage-diff" satisfies AiChatMessagePartToolWritePage_ClassNames}
					diffText={output}
					stickToBottom={
						toolState === "input-streaming" || toolState === "input-available" || toolState === "output-available"
					}
					maxHeight="16lh"
				/>
			) : (
				<TextMonospaceBlock
					className={"AiChatMessagePartToolWritePage-diff" satisfies AiChatMessagePartToolWritePage_ClassNames}
					text={deferredContent}
					stickToBottom={toolState === "input-streaming" || toolState === "input-available"}
					maxHeight="16lh"
				/>
			)}
		</div>
	);
});
// #endregion tool write_page

// #region tool edit_page
type AiChatMessagePartToolEditPage_ClassNames = "AiChatMessagePartToolEditPage" | "AiChatMessagePartToolEditPage-link";

type AiChatMessagePartToolEditPage_Props = {
	className?: string | undefined;
	args: ExtractStrict<ToolUIPart<ai_chat_AiSdk5UiTools>, { type: "tool-edit_page" }>["input"];
	result: ai_chat_AiSdk5UiTools["edit_page"]["output"] | undefined;
	toolState: ToolUIPart["state"];
	isChatRunning: boolean;
	errorText?: string | undefined;
};

const AiChatMessagePartToolEditPage = memo(function AiChatMessagePartToolEditPage(
	props: AiChatMessagePartToolEditPage_Props,
) {
	const { className, args, result, toolState, isChatRunning, errorText } = props;

	const text = result?.metadata?.path
		? path_name_of(result.metadata.path)
		: args?.path
			? path_name_of(args.path)
			: undefined;

	const resultCode = result?.metadata?.diff ?? result?.output;

	return (
		<AiChatMessagePartDisclosure
			className={cn("AiChatMessagePartToolEditPage" satisfies AiChatMessagePartToolEditPage_ClassNames, className)}
		>
			<AiChatMessagePartDisclosureButton
				title="Edit page"
				text={text}
				state={toolState}
				isChatRunning={isChatRunning}
			/>
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
		</AiChatMessagePartDisclosure>
	);
});
// #endregion tool edit_page

// #region tool unknown
type AiChatMessagePartToolUnknown_ClassNames = "AiChatMessagePartToolUnknown" | "AiChatMessagePartToolUnknown-meta";

type AiChatMessagePartToolUnknown_Props = {
	className?: string | undefined;
	part: ToolUIPart<ai_chat_AiSdk5UiTools> | DynamicToolUIPart;
	isChatRunning: boolean;
};

const AiChatMessagePartToolUnknown = memo(function AiChatMessagePartToolUnknown(
	props: AiChatMessagePartToolUnknown_Props,
) {
	const { className, part, isChatRunning } = props;

	const toolName = part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);
	const output = part.state === "output-available" ? part.output : undefined;
	const errorText = part.state === "output-error" ? part.errorText : undefined;
	const outputCode =
		output === undefined ? undefined : typeof output === "string" ? output : json_strigify_ensured(output);

	return (
		<AiChatMessagePartDisclosure
			className={cn("AiChatMessagePartToolUnknown" satisfies AiChatMessagePartToolUnknown_ClassNames, className)}
		>
			<AiChatMessagePartDisclosureButton title={`tool-${toolName}`} state={part.state} isChatRunning={isChatRunning} />
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
		</AiChatMessagePartDisclosure>
	);
});
// #endregion tool unknown

// #region markdown assistant
type AiChatMessagePartMarkdownAssistant_ClassNames = "AiChatMessagePartMarkdownAgent";

type AiChatMessagePartMarkdownAssistant_Props = AiChatMarkdown_Props;

const AiChatMessagePartMarkdownAgent = memo(function AiChatMessagePartMarkdownAgent(
	props: AiChatMessagePartMarkdownAssistant_Props,
) {
	const { className, markdown, ...rest } = props;

	const deferredMarkdown = useDeferredValue(markdown);

	return (
		<AiChatMarkdown
			className={cn(
				"AiChatMessagePartMarkdownAgent" satisfies AiChatMessagePartMarkdownAssistant_ClassNames,
				className,
			)}
			markdown={deferredMarkdown}
			{...rest}
		/>
	);
});
// #endregion markdown assistant

// #region markdown user
type AiChatMessagePartMarkdownUser_ClassNames = "AiChatMessagePartMarkdownUser";

type AiChatMessagePartMarkdownUser_Props = {
	markdown: string;
};

const AiChatMessagePartMarkdownUser = memo(function AiChatMessagePartMarkdownUser(
	props: AiChatMessagePartMarkdownUser_Props,
) {
	const { markdown, ...rest } = props;

	const deferredMarkdown = useDeferredValue(markdown);

	return (
		<AiChatMarkdown
			className={"AiChatMessagePartMarkdownUser" satisfies AiChatMessagePartMarkdownUser_ClassNames}
			markdown={deferredMarkdown}
			replaceNewLineToBr={true}
			{...rest}
		/>
	);
});
// #endregion markdown user

// #region part thinking
type AiChatMessagePartThinking_ClassNames =
	| "AiChatMessagePartThinking"
	| "AiChatMessagePartThinking-streaming"
	| "AiChatMessagePartThinking-text-only"
	| "AiChatMessagePartThinking-text-only-content"
	| "AiChatMessagePartThinking-body"
	| "AiChatMessagePartThinking-body-placeholder";

type AiChatMessagePartThinking_Props = {
	className?: string | undefined;
	text: string;
	isStreaming: boolean;
	defaultOpen?: boolean | undefined;
};

const AiChatMessagePartThinking = memo(function AiChatMessagePartThinking(props: AiChatMessagePartThinking_Props) {
	const { className, text, isStreaming, defaultOpen } = props;

	const deferredText = useDeferredValue(text);
	const [isOpen, setIsOpen] = useState(defaultOpen ?? isStreaming);
	const wasStreamingRef = useRef(isStreaming);
	const textTrimmed = deferredText.trim();

	useEffect(() => {
		if (isStreaming && !wasStreamingRef.current) {
			setIsOpen(true);
		}

		wasStreamingRef.current = isStreaming;
	}, [isStreaming]);

	const handleToggle = useFn<ComponentPropsWithRef<"details">["onToggle"]>((event) => {
		setIsOpen(event.currentTarget.open);
	});

	const hasText = textTrimmed.length > 0;

	return hasText ? (
		<AiChatMessagePartDisclosure
			className={cn(
				"AiChatMessagePartThinking" satisfies AiChatMessagePartThinking_ClassNames,
				isStreaming && ("AiChatMessagePartThinking-streaming" satisfies AiChatMessagePartThinking_ClassNames),
				className,
			)}
			open={isOpen}
			onToggle={handleToggle}
		>
			<AiChatMessagePartDisclosureButton
				title="Thinking"
				state={isStreaming ? "input-streaming" : "output-available"}
				isChatRunning={isStreaming}
			/>
			<AiChatMessagePartToolBody
				className={"AiChatMessagePartThinking-body" satisfies AiChatMessagePartThinking_ClassNames}
			>
				<AiChatMarkdown markdown={deferredText} />
			</AiChatMessagePartToolBody>
		</AiChatMessagePartDisclosure>
	) : (
		<div
			className={cn(
				"AiChatMessagePartThinking" satisfies AiChatMessagePartThinking_ClassNames,
				isStreaming && ("AiChatMessagePartThinking-streaming" satisfies AiChatMessagePartThinking_ClassNames),
				className,
			)}
		>
			<div
				className={"AiChatMessagePartThinking-text-only" satisfies AiChatMessagePartThinking_ClassNames}
				aria-busy={isStreaming}
				aria-disabled="true"
			>
				<div className={"AiChatMessagePartThinking-text-only-content" satisfies AiChatMessagePartThinking_ClassNames}>
					<b>{isStreaming ? "Thinking" : "Thought"}</b>
					<span
						aria-hidden
						className={"AiChatMessagePartThinking-body-placeholder" satisfies AiChatMessagePartThinking_ClassNames}
					/>
				</div>
			</div>
		</div>
	);
});
// #endregion part thinking

// #region part image
type AiChatMessagePartImage_ClassNames = "AiChatMessagePartImage";

type AiChatMessagePartImage_Props = {
	url: string;
	filename: string | undefined;
};

const AiChatMessagePartImage = memo(function AiChatMessagePartImage(props: AiChatMessagePartImage_Props) {
	const { url, filename } = props;
	return (
		<img
			className={"AiChatMessagePartImage" satisfies AiChatMessagePartImage_ClassNames}
			src={url}
			alt={filename ?? "Image attachment"}
		/>
	);
});
// #endregion part image

// #region part file
type AiChatMessagePartFile_ClassNames = "AiChatMessagePartFile";

type AiChatMessagePartFile_Props = {
	filename: string | undefined;
};

const AiChatMessagePartFile = memo(function AiChatMessagePartFile(props: AiChatMessagePartFile_Props) {
	const { filename } = props;
	return (
		<span className={"AiChatMessagePartFile" satisfies AiChatMessagePartFile_ClassNames}>
			{filename ?? "File attachment"}
		</span>
	);
});
// #endregion part file

// #region part source url
type AiChatMessagePartSourceUrl_ClassNames = "AiChatMessagePartSourceUrl";

type AiChatMessagePartSourceUrl_Props = {
	url: string;
	title: string | undefined;
};

const AiChatMessagePartSourceUrl = memo(function AiChatMessagePartSourceUrl(props: AiChatMessagePartSourceUrl_Props) {
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
});
// #endregion part source url

// #region part source document
type AiChatMessagePartSourceDocument_ClassNames = "AiChatMessagePartSourceDocument";

type AiChatMessagePartSourceDocument_Props = {
	title: string | undefined;
	filename: string | undefined;
	sourceId: string;
	mediaType: string;
};

const AiChatMessagePartSourceDocument = memo(function AiChatMessagePartSourceDocument(
	props: AiChatMessagePartSourceDocument_Props,
) {
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
});
// #endregion part source document

// #region part
type AiChatMessagePart_ClassNames =
	| "AiChatMessagePart"
	| "AiChatMessagePart-tool"
	| "AiChatMessagePart-markdown-assistant"
	| "AiChatMessagePart-markdown-user"
	| "AiChatMessagePart-image"
	| "AiChatMessagePart-file"
	| "AiChatMessagePart-source";

type AiChatMessagePart_Props = {
	role: "assistant" | "user" | "system";
	part: ai_chat_AiSdk5UiMessage["parts"][number];
	message: ai_chat_AiSdk5UiMessage;
	isChatRunning: boolean;
	onToolOutput: AiChatController["addToolOutput"];
	onToolResumeStream: AiChatController["resumeStream"];
	onToolStop: AiChatController["stop"];
};

const AiChatMessagePart = memo(function AiChatMessagePart(props: AiChatMessagePart_Props) {
	const { role, part } = props;

	const partClass = ((/* iife */) => {
		if (isToolOrDynamicToolUIPart(part)) return "AiChatMessagePart-tool" satisfies AiChatMessagePart_ClassNames;
		if (isTextUIPart(part) && role === "assistant")
			return "AiChatMessagePart-markdown-assistant" satisfies AiChatMessagePart_ClassNames;
		if (isTextUIPart(part) && role === "user")
			return "AiChatMessagePart-markdown-user" satisfies AiChatMessagePart_ClassNames;
		if (isFileUIPart(part))
			return part.mediaType.startsWith("image/")
				? ("AiChatMessagePart-image" satisfies AiChatMessagePart_ClassNames)
				: ("AiChatMessagePart-file" satisfies AiChatMessagePart_ClassNames);
		if (part.type === "source-url" || part.type === "source-document")
			return "AiChatMessagePart-source" satisfies AiChatMessagePart_ClassNames;
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
});

const AiChatMessagePartInner = memo(function AiChatMessagePartInner(props: AiChatMessagePart_Props) {
	const { role, part, isChatRunning } = props;

	if (isToolOrDynamicToolUIPart(part)) {
		if (part.type === "dynamic-tool") {
			return <AiChatMessagePartToolUnknown part={part} isChatRunning={isChatRunning} />;
		}

		switch (part.type) {
			case "tool-read_page": {
				return (
					<AiChatMessagePartToolReadPage
						args={part.input}
						result={part.output}
						toolState={part.state}
						isChatRunning={isChatRunning}
						errorText={part.errorText}
					/>
				);
			}
			case "tool-list_pages": {
				return (
					<AiChatMessagePartToolListPages
						args={part.input}
						result={part.output}
						toolState={part.state}
						isChatRunning={isChatRunning}
						errorText={part.errorText}
					/>
				);
			}
			case "tool-glob_pages": {
				return (
					<AiChatMessagePartToolGlobPages
						args={part.input}
						result={part.output}
						toolState={part.state}
						isChatRunning={isChatRunning}
						errorText={part.errorText}
					/>
				);
			}
			case "tool-grep_pages": {
				return (
					<AiChatMessagePartToolGrepPages
						args={part.input}
						result={part.output}
						toolState={part.state}
						isChatRunning={isChatRunning}
						errorText={part.errorText}
					/>
				);
			}
			case "tool-text_search_pages": {
				return (
					<AiChatMessagePartToolTextSearchPages
						args={part.input}
						result={part.output}
						toolState={part.state}
						isChatRunning={isChatRunning}
						errorText={part.errorText}
					/>
				);
			}
			case "tool-write_page": {
				return (
					<AiChatMessagePartToolWritePage
						args={part.input}
						result={part.output}
						toolState={part.state}
						isChatRunning={isChatRunning}
						errorText={part.errorText}
					/>
				);
			}
			case "tool-edit_page": {
				return (
					<AiChatMessagePartToolEditPage
						args={part.input}
						result={part.output}
						toolState={part.state}
						isChatRunning={isChatRunning}
						errorText={part.errorText}
					/>
				);
			}
			default:
				return <AiChatMessagePartToolUnknown part={part} isChatRunning={isChatRunning} />;
		}
	}

	if (isTextUIPart(part)) {
		return role === "assistant" ? (
			<AiChatMessagePartMarkdownAgent markdown={part.text} />
		) : (
			<AiChatMessagePartMarkdownUser markdown={part.text} />
		);
	}

	if (isReasoningUIPart(part)) {
		return <AiChatMessagePartThinking text={part.text} isStreaming={isChatRunning} defaultOpen={isChatRunning} />;
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
});
// #endregion part

// #region container
type AiChatMessageContainer_ClassNames = "AiChatMessageContainer";

type AiChatMessageContainer_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	children: ReactNode;
};

const AiChatMessageContainer = memo(function AiChatMessageContainer(props: AiChatMessageContainer_Props) {
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
});
// #endregion container

// #region content
type AiChatMessageContent_DisplayItem =
	| {
			type: "part";
			part: ai_chat_AiSdk5UiMessage["parts"][number];
	  }
	| {
			type: "thinking";
			text: string;
			isStreaming: boolean;
	  };

type AiChatMessageContent_ClassNames = "AiChatMessageContent";

type AiChatMessageContent_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	message: ai_chat_AiSdk5UiMessage;
	isChatRunning: boolean;
	onToolOutput: AiChatMessagePart_Props["onToolOutput"];
	onToolResumeStream: AiChatMessagePart_Props["onToolResumeStream"];
	onToolStop: AiChatMessagePart_Props["onToolStop"];
	children?: ReactNode;
};

function ai_chat_message_content_get_display_items(
	message: ai_chat_AiSdk5UiMessage,
	parts: ai_chat_AiSdk5UiMessage["parts"],
	isChatRunning: boolean,
) {
	if (message.role !== "assistant") {
		return parts.map((part) => ({ type: "part", part }) satisfies AiChatMessageContent_DisplayItem);
	}

	const displayItems: AiChatMessageContent_DisplayItem[] = [];

	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (!isReasoningUIPart(part)) {
			displayItems.push({ type: "part", part } satisfies AiChatMessageContent_DisplayItem);
			continue;
		}

		const reasoningTexts = [part.text];
		let endIndex = index;

		while (endIndex + 1 < parts.length) {
			const nextPart = parts[endIndex + 1];
			if (!isReasoningUIPart(nextPart)) {
				break;
			}

			endIndex += 1;
			reasoningTexts.push(nextPart.text);
		}

		displayItems.push({
			type: "thinking",
			text: reasoningTexts.join("\n\n"),
			isStreaming: isChatRunning && endIndex === parts.length - 1,
		} satisfies AiChatMessageContent_DisplayItem);

		index = endIndex;
	}

	return displayItems;
}

const AiChatMessageContent = memo(function AiChatMessageContent(props: AiChatMessageContent_Props) {
	const {
		ref,
		id,
		className,
		message,
		isChatRunning,
		onToolOutput,
		onToolResumeStream,
		onToolStop,
		children,
		...rest
	} = props;

	const deferredAssistantParts = useDeferredValue(message.parts);

	const parts = message.role === "assistant" ? deferredAssistantParts : message.parts;
	const displayItems = children
		? []
		: ai_chat_message_content_get_display_items(
				message,
				parts.filter((part) => !part.type.startsWith("data-") && part.type !== "step-start"),
				isChatRunning,
			);

	return (
		<div
			ref={ref}
			id={id}
			className={cn("AiChatMessageContent" satisfies AiChatMessageContent_ClassNames, className)}
			{...rest}
		>
			{children ??
				displayItems.map((item, index) => {
					// Keep index keys so persisted assistant messages do not remount while
					// their streamed parts settle into the final stored structure.
					if (item.type === "thinking") {
						return (
							<AiChatMessagePartThinking
								key={index}
								text={item.text}
								isStreaming={item.isStreaming}
								defaultOpen={item.isStreaming}
							/>
						);
					}

					return (
						<AiChatMessagePart
							key={index}
							role={message.role}
							part={item.part}
							message={message}
							isChatRunning={isChatRunning}
							onToolOutput={onToolOutput}
							onToolResumeStream={onToolResumeStream}
							onToolStop={onToolStop}
						/>
					);
				})}
		</div>
	);
});
// #endregion content

// #region bubble
type AiChatMessageBubble_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	children: ReactNode;
};

type AiChatMessageBubble_ClassNames = "AiChatMessageBubble";

const AiChatMessageBubble = memo(function AiChatMessageBubble(props: AiChatMessageBubble_Props) {
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
});
// #endregion bubble

// #region user message
export type AiChatMessageUser_ClassNames =
	| "AiChatMessageUser"
	| "AiChatMessageUser-bubble"
	| "AiChatMessageUser-bubble-state-editing"
	| "AiChatMessageUser-content-container"
	| "AiChatMessageUser-edit-button"
	| "AiChatMessageUser-edit-button-box"
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
	selectedModelId: ai_chat_MainModelId;
	isRunning: boolean;
	isEditing: boolean;
	messagesChildrenByParentId: AiChatController["messagesChildrenByParentId"];
	onToolOutput: AiChatMessageContent_Props["onToolOutput"];
	onToolResumeStream: AiChatMessageContent_Props["onToolResumeStream"];
	onToolStop: AiChatMessageContent_Props["onToolStop"];
	onSelectedModelIdChange: AiChatComposer_Props["onSelectedModelIdChange"];
	onEditStart: AiChatMessage_Props["onEditStart"];
	onEditCancel: AiChatMessage_Props["onEditCancel"];
	onEditSubmit: AiChatMessage_Props["onEditSubmit"];
	onSelectBranchAnchor: AiChatMessage_Props["onSelectBranchAnchor"];
};

const AiChatMessageUser = memo(function AiChatMessageUser(props: AiChatMessageUser_Props) {
	const {
		ref,
		id,
		className,
		message,
		selectedThreadId,
		selectedModelId,
		isRunning,
		isEditing,
		messagesChildrenByParentId,
		onToolOutput,
		onToolResumeStream,
		onToolStop,
		onSelectedModelIdChange,
		onEditStart,
		onEditCancel,
		onEditSubmit,
		onSelectBranchAnchor,
		...rest
	} = props;

	const branchMetadata = ((/* iife */) => {
		const siblings = messagesChildrenByParentId.get(message.metadata?.convexParentId ?? null) ?? [];
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

	const handleStartEdit = useFn(() => {
		if (!selectedThreadId || !canEdit) {
			return;
		}

		const parentId = message.metadata?.convexParentId ?? null;

		onEditStart({ messageId: message.id, parentId });
	});

	const handleEditCancel = useFn(() => {
		onEditCancel();
	});

	const handleEditSubmit = useFn<AiChatComposer_Props["onSubmit"]>((value) => {
		onEditSubmit({ value });
	});
	const handleEditValueChange = useFn<AiChatComposer_Props["onValueChange"]>(() => {});

	const handleBranchSwitch = (direction: "prev" | "next") => {
		if (isRunning) {
			return;
		}
		if (!selectedThreadId) {
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

	const handleBranchPrev = useFn(() => {
		handleBranchSwitch("prev");
	});

	const handleBranchNext = useFn(() => {
		handleBranchSwitch("next");
	});

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
				<div className={"AiChatMessageUser-content-container" satisfies AiChatMessageUser_ClassNames}>
					<AiChatMessageContent
						message={message}
						isChatRunning={isRunning}
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
								modelOptions={ai_chat_MAIN_MODEL_IDS}
								selectedModelId={selectedModelId}
								onValueChange={handleEditValueChange}
								onSelectedModelIdChange={onSelectedModelIdChange}
								onSubmit={handleEditSubmit}
								onInteractedOutside={handleEditCancel}
								onClose={handleEditCancel}
							/>
						) : null}
					</AiChatMessageContent>
				</div>
				{showEditButton && (
					<button
						className={"AiChatMessageUser-edit-button" satisfies AiChatMessageUser_ClassNames}
						type="button"
						{...({ "data-ai-chat-message-id": message.id } satisfies Partial<AiChatMessage_CustomAttributes>)}
						aria-label="Edit message"
						onClick={handleStartEdit}
					>
						<div className={"AiChatMessageUser-edit-button-box" satisfies AiChatMessageUser_ClassNames}></div>
					</button>
				)}
				<div className={"AiChatMessageUser-actions" satisfies AiChatMessageUser_ClassNames} hidden={isEditing}>
					<CopyIconButton
						className={"AiChatMessageUser-action-button" satisfies AiChatMessageUser_ClassNames}
						iconClassName={"AiChatMessageUser-action-icon" satisfies AiChatMessageUser_ClassNames}
						variant="ghost-highlightable"
						tooltipCopy="Copy message"
						text={text ?? undefined}
					/>
					{showBranchControls && (
						<div className={"AiChatMessageUser-branch-controls" satisfies AiChatMessageUser_ClassNames}>
							<MyIconButton
								className={"AiChatMessageUser-action-button" satisfies AiChatMessageUser_ClassNames}
								variant="ghost-highlightable"
								tooltip="Previous variant"
								disabled={isRunning}
								onClick={handleBranchPrev}
							>
								<ChevronLeft className={"AiChatMessageUser-action-icon" satisfies AiChatMessageUser_ClassNames} />
							</MyIconButton>
							<span className={"AiChatMessageUser-branch-label" satisfies AiChatMessageUser_ClassNames}>
								{branchLabel}
							</span>
							<MyIconButton
								className={"AiChatMessageUser-action-button" satisfies AiChatMessageUser_ClassNames}
								variant="ghost-highlightable"
								tooltip="Next variant"
								disabled={isRunning}
								onClick={handleBranchNext}
							>
								<ChevronRight className={"AiChatMessageUser-action-icon" satisfies AiChatMessageUser_ClassNames} />
							</MyIconButton>
						</div>
					)}
				</div>
			</AiChatMessageBubble>
		</AiChatMessageContainer>
	);
});
// #endregion user message

// #region agent message
type AiChatMessageAgent_ClassNames =
	| "AiChatMessageAgent"
	| "AiChatMessageAgent-bubble"
	| "AiChatMessageAgent-error"
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

const AiChatMessageAgent = memo(function AiChatMessageAgent(props: AiChatMessageAgent_Props) {
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
		const siblings = messagesChildrenByParentId.get(message.metadata?.convexParentId ?? null) ?? [];
		const currentIndex = siblings.indexOf(message);

		return {
			variantIndex: currentIndex,
			variantCount: siblings.length,
			variantAnchorIds: siblings.map((sibling) => sibling.id),
		} satisfies AiChatMessage_BranchMetadata;
	})();

	// TODO: Allow copying tool data even when there is no message text.
	const text = ai_chat_get_message_text(message);
	const streamErrorText = message.metadata?.status === "errored" ? "An error occurred during the generation" : null;

	const handleReload = useFn(() => {
		if (!selectedThreadId) {
			return;
		}
		onMessageRegenerate({ threadId: selectedThreadId, messageId: message.id });
	});

	const handleBranchChat = useFn(() => {
		if (!selectedThreadId || isRunning) {
			return;
		}
		onMessageBranchChat({ threadId: selectedThreadId, messageId: message.id });
	});

	const handleBranchSwitch = (direction: "prev" | "next") => {
		if (isRunning) {
			return;
		}
		if (!selectedThreadId) {
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

	const handleBranchPrev = useFn(() => {
		handleBranchSwitch("prev");
	});

	const handleBranchNext = useFn(() => {
		handleBranchSwitch("next");
	});

	const showBranchControls = branchMetadata.variantCount > 1;
	const branchLabel = `${branchMetadata.variantIndex + 1}/${branchMetadata.variantCount}`;

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
					isChatRunning={isRunning}
					onToolOutput={onToolOutput}
					onToolResumeStream={onToolResumeStream}
					onToolStop={onToolStop}
				/>
				{streamErrorText && (
					<div className={"AiChatMessageAgent-error" satisfies AiChatMessageAgent_ClassNames}>{streamErrorText}</div>
				)}
				<div className={"AiChatMessageAgent-actions" satisfies AiChatMessageAgent_ClassNames} hidden={isEditing}>
					<CopyIconButton
						className={"AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames}
						iconClassName={"AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames}
						variant="ghost"
						tooltipCopy="Copy message"
						text={text ?? undefined}
					/>
					<MyIconButton
						className={"AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames}
						variant="ghost"
						tooltip="Branch chat here"
						disabled={!selectedThreadId || isRunning}
						onClick={handleBranchChat}
					>
						<GitBranch className={"AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames} />
					</MyIconButton>
					{showBranchControls && (
						<div className={"AiChatMessageAgent-branch-controls" satisfies AiChatMessageAgent_ClassNames}>
							<MyIconButton
								className={"AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames}
								variant="ghost"
								tooltip="Previous variant"
								disabled={isRunning}
								onClick={handleBranchPrev}
							>
								<ChevronLeft className={"AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames} />
							</MyIconButton>
							<span className={"AiChatMessageAgent-branch-label" satisfies AiChatMessageAgent_ClassNames}>
								{branchLabel}
							</span>
							<MyIconButton
								className={"AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames}
								variant="ghost"
								tooltip="Next variant"
								disabled={isRunning}
								onClick={handleBranchNext}
							>
								<ChevronRight className={"AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames} />
							</MyIconButton>
						</div>
					)}
					<MyIconButton
						className={"AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames}
						variant="ghost"
						tooltip="Regenerate response"
						onClick={handleReload}
					>
						<RefreshCw className={"AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames} />
					</MyIconButton>
				</div>
			</AiChatMessageBubble>
		</AiChatMessageContainer>
	);
});
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

const AiChatMessageSystem = memo(function AiChatMessageSystem(props: AiChatMessageSystem_Props) {
	const { ref, id, className, message, isRunning, onToolOutput, onToolResumeStream, onToolStop, ...rest } = props;

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
					isChatRunning={isRunning}
					onToolOutput={onToolOutput}
					onToolResumeStream={onToolResumeStream}
					onToolStop={onToolStop}
				/>
			</AiChatMessageBubble>
		</AiChatMessageContainer>
	);
});
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
	selectedModelId: ai_chat_MainModelId;
	isRunning: boolean;
	isEditing: boolean;
	messagesChildrenByParentId: AiChatController["messagesChildrenByParentId"];
	onToolOutput: AiChatMessageContent_Props["onToolOutput"];
	onToolResumeStream: AiChatMessageContent_Props["onToolResumeStream"];
	onToolStop: AiChatMessageContent_Props["onToolStop"];
	onSelectedModelIdChange: AiChatComposer_Props["onSelectedModelIdChange"];
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

export const AiChatMessage = memo(function AiChatMessage(props: AiChatMessage_Props) {
	const {
		ref,
		id,
		className,
		message,
		selectedThreadId,
		selectedModelId,
		isRunning,
		isEditing,
		messagesChildrenByParentId,
		onToolOutput,
		onToolResumeStream,
		onToolStop,
		onSelectedModelIdChange,
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
				selectedModelId={selectedModelId}
				isRunning={isRunning}
				isEditing={isEditing}
				messagesChildrenByParentId={messagesChildrenByParentId}
				onSelectedModelIdChange={onSelectedModelIdChange}
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
});
// #endregion message
