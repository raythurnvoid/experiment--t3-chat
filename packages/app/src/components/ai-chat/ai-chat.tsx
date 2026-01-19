import "./ai-chat.css";

import type { ComponentPropsWithRef, Ref } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	MessageAttachmentByIndexProvider,
	MessageByIndexProvider,
	PartByIndexProvider,
	useAssistantApi,
	useAssistantState,
	type ToolCallMessagePartComponent,
	type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowDown, Check, Copy, RefreshCw } from "lucide-react";
import remarkGfm from "remark-gfm";

import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { cn } from "@/lib/utils.ts";
import { AiChatAttachmentTile, AiChatComposer } from "./ai-chat-composer.tsx";

const ai_chat_message_list_suggestions = [
	{
		title: "What's the weather",
		label: "in San Francisco?",
		action: "What's the weather in San Francisco?",
	},
	{
		title: "Explain React hooks",
		label: "like useState and useEffect",
		action: "Explain React hooks like useState and useEffect",
	},
	{
		title: "Write a SQL query",
		label: "to find top customers",
		action: "Write a SQL query to find top customers",
	},
	{
		title: "Create a meal plan",
		label: "for healthy weight loss",
		action: "Create a meal plan for healthy weight loss",
	},
] as const;

// #region message attachments
export type AiChatMessageAttachments_ClassNames = "AiChatMessageAttachments" | "AiChatMessageAttachments-item";

export type AiChatMessageAttachments_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
};

function AiChatMessageAttachments(props: AiChatMessageAttachments_Props) {
	const { ref, id, className, ...rest } = props;
	const attachmentCount = useAssistantState(({ message }) => message.attachments?.length ?? 0);
	const attachmentIndices = Array.from({ length: attachmentCount }, (_, index) => index);

	if (attachmentCount === 0) {
		return null;
	}

	return (
		<div
			ref={ref}
			id={id}
			className={cn("AiChatMessageAttachments" satisfies AiChatMessageAttachments_ClassNames, className)}
			{...rest}
		>
			{attachmentIndices.map((index) => (
				<MessageAttachmentByIndexProvider key={index} index={index}>
					<div className={cn("AiChatMessageAttachments-item" satisfies AiChatMessageAttachments_ClassNames)}>
						<AiChatAttachmentTile />
					</div>
				</MessageAttachmentByIndexProvider>
			))}
		</div>
	);
}
// #endregion message attachments

// #region message
export type AiChatMessage_ClassNames =
	| "AiChatMessage"
	| "AiChatMessage-role-user"
	| "AiChatMessage-role-assistant"
	| "AiChatMessage-role-system"
	| "AiChatMessage-content"
	| "AiChatMessage-bubble"
	| "AiChatMessage-text"
	| "AiChatMessage-markdown"
	| "AiChatMessage-actions"
	| "AiChatMessage-action-button"
	| "AiChatMessage-action-icon"
	| "AiChatMessage-part"
	| "AiChatMessage-image"
	| "AiChatMessage-file"
	| "AiChatMessage-file-name"
	| "AiChatMessage-source";

export type AiChatMessage_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
};

function AiChatMessage(props: AiChatMessage_Props) {
	const { ref, id, className, ...rest } = props;
	const api = useAssistantApi();
	const role = useAssistantState(({ message }) => message.role);
	const partCount = useAssistantState(({ message }) => message.parts.length);
	const hasAttachments = useAssistantState(({ message }) => (message.attachments?.length ?? 0) > 0);
	const partIndices = useMemo(() => Array.from({ length: partCount }, (_, index) => index), [partCount]);
	const [isCopied, setIsCopied] = useState(false);

	const handleCopy = () => {
		const text = api.message().getCopyText();
		if (!text) {
			return;
		}

		navigator.clipboard
			.writeText(text)
			.then(() => setIsCopied(true))
			.catch(console.error);
	};

	const handleReload = () => {
		api.message().reload();
	};

	useEffect(() => {
		if (!isCopied) {
			return;
		}

		const timeout = setTimeout(() => setIsCopied(false), 2000);
		return () => clearTimeout(timeout);
	}, [isCopied]);

	return (
		<div
			ref={ref}
			id={id}
			data-role={role}
			className={cn(
				"AiChatMessage" satisfies AiChatMessage_ClassNames,
				role === "user" && ("AiChatMessage-role-user" satisfies AiChatMessage_ClassNames),
				role === "assistant" && ("AiChatMessage-role-assistant" satisfies AiChatMessage_ClassNames),
				role === "system" && ("AiChatMessage-role-system" satisfies AiChatMessage_ClassNames),
				className,
			)}
			{...rest}
		>
			{role === "user" && hasAttachments && <AiChatMessageAttachments />}
			<div className={cn("AiChatMessage-content" satisfies AiChatMessage_ClassNames)}>
				{partCount > 0 && (
					<div className={cn("AiChatMessage-bubble" satisfies AiChatMessage_ClassNames)}>
						{partIndices.map((index) => (
							<AiChatMessagePart key={index} index={index} role={role} />
						))}
					</div>
				)}
			</div>
			{role === "assistant" && (
				<div className={cn("AiChatMessage-actions" satisfies AiChatMessage_ClassNames)}>
					<MyIconButton
						variant="ghost"
						tooltip={isCopied ? "Copied" : "Copy message"}
						onClick={handleCopy}
						className={cn("AiChatMessage-action-button" satisfies AiChatMessage_ClassNames)}
					>
						{isCopied ? (
							<Check className={cn("AiChatMessage-action-icon" satisfies AiChatMessage_ClassNames)} />
						) : (
							<Copy className={cn("AiChatMessage-action-icon" satisfies AiChatMessage_ClassNames)} />
						)}
					</MyIconButton>
					<MyIconButton
						variant="ghost"
						tooltip="Regenerate response"
						onClick={handleReload}
						className={cn("AiChatMessage-action-button" satisfies AiChatMessage_ClassNames)}
					>
						<RefreshCw className={cn("AiChatMessage-action-icon" satisfies AiChatMessage_ClassNames)} />
					</MyIconButton>
				</div>
			)}
		</div>
	);
}
// #endregion message

// #region message part
type AiChatMessagePart_Props = {
	index: number;
	role: "assistant" | "user" | "system";
};

function AiChatMessagePart(props: AiChatMessagePart_Props) {
	const { index, role } = props;

	return (
		<PartByIndexProvider index={index}>
			<AiChatMessagePartInner role={role} />
		</PartByIndexProvider>
	);
}
// #endregion message part

// #region message part inner
type AiChatMessagePartInner_Props = {
	role: "assistant" | "user" | "system";
};

function AiChatMessagePartInner(props: AiChatMessagePartInner_Props) {
	const { role } = props;
	const api = useAssistantApi();
	const part = useAssistantState(({ part }) => part);
	const toolRender = useAssistantState(({ tools, part: scopedPart }) => {
		if (scopedPart.type !== "tool-call") {
			return null;
		}

		const render = tools.tools[scopedPart.toolName];
		if (Array.isArray(render)) {
			return render[0];
		}

		return render;
	}) as ToolCallMessagePartComponent<unknown, unknown> | null;

	if (part.type === "tool-call") {
		if (!toolRender) {
			return null;
		}

		const ToolRender = toolRender;
		const addResult = (result: unknown) => {
			api.part().addToolResult(result);
		};

		const resume = (payload: unknown) => {
			api.part().resumeToolCall(payload);
		};

		return (
			<div className={cn("AiChatMessage-part" satisfies AiChatMessage_ClassNames)}>
				<ToolRender {...(part as ToolCallMessagePartProps<unknown, unknown>)} addResult={addResult} resume={resume} />
			</div>
		);
	}

	if (part.type === "text") {
		if (role === "assistant") {
			return (
				<MarkdownTextPrimitive
					remarkPlugins={[remarkGfm]}
					className={"AiChatMessage-markdown" satisfies AiChatMessage_ClassNames}
				/>
			);
		}

		return <p className={cn("AiChatMessage-text" satisfies AiChatMessage_ClassNames)}>{part.text}</p>;
	}

	if (part.type === "image") {
		return (
			<img
				className={cn("AiChatMessage-image" satisfies AiChatMessage_ClassNames)}
				src={part.image}
				alt={part.filename ?? "Image attachment"}
			/>
		);
	}

	if (part.type === "file") {
		return (
			<div className={cn("AiChatMessage-file" satisfies AiChatMessage_ClassNames)}>
				<span className={cn("AiChatMessage-file-name" satisfies AiChatMessage_ClassNames)}>
					{part.filename ?? "File attachment"}
				</span>
			</div>
		);
	}

	if (part.type === "source") {
		return (
			<a
				className={cn("AiChatMessage-source" satisfies AiChatMessage_ClassNames)}
				href={part.url}
				target="_blank"
				rel="noreferrer"
			>
				{part.title ?? part.url}
			</a>
		);
	}

	return null;
}
// #endregion message part inner

// #region message list
export type AiChatMessageList_ClassNames =
	| "AiChatMessageList"
	| "AiChatMessageList-empty"
	| "AiChatMessageList-empty-title"
	| "AiChatMessageList-empty-subtitle"
	| "AiChatMessageList-suggestions"
	| "AiChatMessageList-suggestion"
	| "AiChatMessageList-suggestion-title"
	| "AiChatMessageList-suggestion-label";

export type AiChatMessageList_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
};

function AiChatMessageList(props: AiChatMessageList_Props) {
	const { ref, id, className, ...rest } = props;
	const api = useAssistantApi();
	const messageCount = useAssistantState(({ thread }) => thread.messages.length);
	const messageIndices = useMemo(() => Array.from({ length: messageCount }, (_, index) => index), [messageCount]);

	const handleSuggestionClick = (action: string) => {
		api.composer().setText(action);
		api.composer().send();
	};

	return (
		<div
			ref={ref}
			id={id}
			className={cn("AiChatMessageList" satisfies AiChatMessageList_ClassNames, className)}
			{...rest}
		>
			{messageCount === 0 ? (
				<div className={cn("AiChatMessageList-empty" satisfies AiChatMessageList_ClassNames)}>
					<div className={cn("AiChatMessageList-empty-title" satisfies AiChatMessageList_ClassNames)}>Hello there!</div>
					<div className={cn("AiChatMessageList-empty-subtitle" satisfies AiChatMessageList_ClassNames)}>
						How can I help you today?
					</div>
					<div className={cn("AiChatMessageList-suggestions" satisfies AiChatMessageList_ClassNames)}>
						{ai_chat_message_list_suggestions.map((suggestion) => (
							<MyButton
								key={suggestion.action}
								variant="secondary-subtle"
								className={cn("AiChatMessageList-suggestion" satisfies AiChatMessageList_ClassNames)}
								onClick={() => handleSuggestionClick(suggestion.action)}
							>
								<span className={cn("AiChatMessageList-suggestion-title" satisfies AiChatMessageList_ClassNames)}>
									{suggestion.title}
								</span>
								<span className={cn("AiChatMessageList-suggestion-label" satisfies AiChatMessageList_ClassNames)}>
									{suggestion.label}
								</span>
							</MyButton>
						))}
					</div>
				</div>
			) : (
				messageIndices.map((index) => (
					<MessageByIndexProvider key={index} index={index}>
						<AiChatMessage />
					</MessageByIndexProvider>
				))
			)}
		</div>
	);
}
// #endregion message list

// #region root
export type AiChat_ClassNames =
	| "AiChat"
	| "AiChat-scroll-area"
	| "AiChat-scroll-area-inner"
	| "AiChat-scroll-to-bottom"
	| "AiChat-scroll-to-bottom-icon"
	| "AiChat-composer";

export type AiChat_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
};

export function AiChat(props: AiChat_Props) {
	const { ref, id, className, ...rest } = props;
	const [isAtBottom, setIsAtBottom] = useState(true);
	const messageCount = useAssistantState(({ thread }) => thread.messages.length);
	const scrollRef = useRef<HTMLDivElement | null>(null);

	const updateScrollState = () => {
		const node = scrollRef.current;
		if (!node) {
			return;
		}

		const distanceToBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
		setIsAtBottom(distanceToBottom < 80);
	};

	const handleScrollToBottom = () => {
		const node = scrollRef.current;
		if (!node) {
			return;
		}

		node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
	};

	useEffect(() => {
		const node = scrollRef.current;
		if (!node) {
			return;
		}

		const handleScroll = () => {
			updateScrollState();
		};

		handleScroll();
		node.addEventListener("scroll", handleScroll, { passive: true });
		return () => {
			node.removeEventListener("scroll", handleScroll);
		};
	}, []);

	useEffect(() => {
		const node = scrollRef.current;
		if (!node) {
			return;
		}

		updateScrollState();
		if (isAtBottom) {
			node.scrollTop = node.scrollHeight;
		}
	}, [messageCount, isAtBottom]);

	return (
		<div ref={ref} id={id} className={cn("AiChat" satisfies AiChat_ClassNames, className)} {...rest}>
			<div ref={scrollRef} className={cn("AiChat-scroll-area" satisfies AiChat_ClassNames)}>
				<div className={cn("AiChat-scroll-area-inner" satisfies AiChat_ClassNames)}>
					<AiChatMessageList />
				</div>
				{!isAtBottom && (
					<div className={cn("AiChat-scroll-to-bottom" satisfies AiChat_ClassNames)}>
						<MyIconButton variant="outline" tooltip="Scroll to bottom" onClick={handleScrollToBottom}>
							<ArrowDown className={cn("AiChat-scroll-to-bottom-icon" satisfies AiChat_ClassNames)} />
						</MyIconButton>
					</div>
				)}
			</div>
			<div className={cn("AiChat-composer" satisfies AiChat_ClassNames)}>
				<AiChatComposer />
			</div>
		</div>
	);
}
// #endregion root
