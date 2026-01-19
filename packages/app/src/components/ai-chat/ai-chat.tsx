import "./ai-chat.css";

import type { ChangeEvent, ComponentPropsWithRef, FormEvent, KeyboardEvent, MouseEvent, Ref } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
	ComposerAttachmentByIndexProvider,
	MessageAttachmentByIndexProvider,
	MessageByIndexProvider,
	PartByIndexProvider,
	useAssistantApi,
	useAssistantState,
	type ToolCallMessagePartComponent,
	type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { ArrowDown, ArrowUp, Check, Copy, FileText, Paperclip, RefreshCw, Square, X } from "lucide-react";
import remarkGfm from "remark-gfm";

import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyInput, MyInputArea, MyInputBox, MyInputTextAreaControl } from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalHeader,
	MyModalPopover,
	MyModalScrollableArea,
	MyModalTrigger,
} from "@/components/my-modal.tsx";
import { MySpinner } from "@/components/ui/my-spinner.tsx";
import { cn } from "@/lib/utils.ts";

const ai_chat_attachment_preview_max_height = 520;

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

// #region composer attachments
export type AiChatComposerAttachments_ClassNames = "AiChatComposerAttachments" | "AiChatComposerAttachments-item";

export type AiChatComposerAttachments_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
};

function AiChatComposerAttachments(props: AiChatComposerAttachments_Props) {
	const { ref, id, className, ...rest } = props;
	const attachmentCount = useAssistantState(({ composer }) => composer.attachments.length);
	const attachmentIndices = Array.from({ length: attachmentCount }, (_, index) => index);

	if (attachmentCount === 0) {
		return null;
	}

	return (
		<div
			ref={ref}
			id={id}
			className={cn("AiChatComposerAttachments" satisfies AiChatComposerAttachments_ClassNames, className)}
			{...rest}
		>
			{attachmentIndices.map((index) => (
				<ComposerAttachmentByIndexProvider key={index} index={index}>
					<div className={cn("AiChatComposerAttachments-item" satisfies AiChatComposerAttachments_ClassNames)}>
						<AiChatAttachmentTile />
					</div>
				</ComposerAttachmentByIndexProvider>
			))}
		</div>
	);
}
// #endregion composer attachments

// #region composer attachment add button
export type AiChatComposerAttachmentAddButton_ClassNames =
	| "AiChatComposerAttachmentAddButton"
	| "AiChatComposerAttachmentAddButton-input"
	| "AiChatComposerAttachmentAddButton-icon";

export type AiChatComposerAttachmentAddButton_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
};

function AiChatComposerAttachmentAddButton(props: AiChatComposerAttachmentAddButton_Props) {
	const { ref, id, className, ...rest } = props;
	const api = useAssistantApi();
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement | null>(null);
	const accept = useAssistantState(({ composer }) => composer.attachmentAccept);

	const handleSelectFiles = () => {
		inputRef.current?.click();
	};

	const handleFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
		const { files } = event.currentTarget;
		if (!files || files.length === 0) {
			return;
		}

		Array.from(files).forEach((file) => {
			api
				.composer()
				.addAttachment(file)
				.catch((error) => {
					console.error("Failed to add attachment:", error);
				});
		});

		event.currentTarget.value = "";
	};

	return (
		<div
			ref={ref}
			id={id}
			className={cn(
				"AiChatComposerAttachmentAddButton" satisfies AiChatComposerAttachmentAddButton_ClassNames,
				className,
			)}
			{...rest}
		>
			<MyIconButton type="button" variant="ghost" tooltip="Add attachment" onClick={handleSelectFiles}>
				<Paperclip
					className={cn(
						"AiChatComposerAttachmentAddButton-icon" satisfies AiChatComposerAttachmentAddButton_ClassNames,
					)}
				/>
			</MyIconButton>
			<input
				id={inputId}
				ref={inputRef}
				type="file"
				multiple
				accept={accept}
				className={cn("AiChatComposerAttachmentAddButton-input" satisfies AiChatComposerAttachmentAddButton_ClassNames)}
				onChange={handleFilesChange}
			/>
		</div>
	);
}
// #endregion composer attachment add button

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

// #region attachment tile
type AiChatAttachmentTile_ClassNames =
	| "AiChatAttachmentTile"
	| "AiChatAttachmentTile-preview"
	| "AiChatAttachmentTile-avatar"
	| "AiChatAttachmentTile-fallback-icon"
	| "AiChatAttachmentTile-name"
	| "AiChatAttachmentTile-remove"
	| "AiChatAttachmentTile-remove-icon"
	| "AiChatAttachmentTile-spinner"
	| "AiChatAttachmentTile-modal"
	| "AiChatAttachmentTile-modal-header"
	| "AiChatAttachmentTile-modal-title"
	| "AiChatAttachmentTile-modal-image";

function AiChatAttachmentTile() {
	const api = useAssistantApi();
	const type = useAssistantState(({ attachment }) => attachment.type);
	const name = useAssistantState(({ attachment }) => attachment.name);
	const statusType = useAssistantState(({ attachment }) => attachment.status.type);
	const previewSrc = useAttachmentPreviewSrc();
	const isComposer = api.attachment.source === "composer";
	const isImage = type === "image";

	const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		event.preventDefault();
		api
			.attachment()
			.remove()
			.catch((error) => {
				console.error("Failed to remove attachment:", error);
			});
	};

	const preview = (
		<div className={cn("AiChatAttachmentTile-preview" satisfies AiChatAttachmentTile_ClassNames)}>
			<MyAvatar className={cn("AiChatAttachmentTile-avatar" satisfies AiChatAttachmentTile_ClassNames)} size="48px">
				<MyAvatarImage src={previewSrc} alt={name} />
				<MyAvatarFallback>
					<FileText className={cn("AiChatAttachmentTile-fallback-icon" satisfies AiChatAttachmentTile_ClassNames)} />
				</MyAvatarFallback>
			</MyAvatar>
			<div className={cn("AiChatAttachmentTile-name" satisfies AiChatAttachmentTile_ClassNames)}>{name}</div>
			{statusType === "running" && (
				<MySpinner
					className={cn("AiChatAttachmentTile-spinner" satisfies AiChatAttachmentTile_ClassNames)}
					size="16px"
				/>
			)}
		</div>
	);

	return (
		<div className={cn("AiChatAttachmentTile" satisfies AiChatAttachmentTile_ClassNames)}>
			{isImage && previewSrc ? (
				<MyModal>
					<MyModalTrigger>{preview}</MyModalTrigger>
					<MyModalPopover className={cn("AiChatAttachmentTile-modal" satisfies AiChatAttachmentTile_ClassNames)}>
						<MyModalHeader
							className={cn("AiChatAttachmentTile-modal-header" satisfies AiChatAttachmentTile_ClassNames)}
						>
							<div className={cn("AiChatAttachmentTile-modal-title" satisfies AiChatAttachmentTile_ClassNames)}>
								{name}
							</div>
							<MyModalCloseTrigger />
						</MyModalHeader>
						<MyModalScrollableArea>
							<img
								className={cn("AiChatAttachmentTile-modal-image" satisfies AiChatAttachmentTile_ClassNames)}
								src={previewSrc}
								alt={name}
								style={{ maxHeight: `${ai_chat_attachment_preview_max_height}px` }}
							/>
						</MyModalScrollableArea>
					</MyModalPopover>
				</MyModal>
			) : (
				preview
			)}
			{isComposer && (
				<MyIconButton
					variant="ghost"
					tooltip="Remove attachment"
					onClick={handleRemove}
					className={cn("AiChatAttachmentTile-remove" satisfies AiChatAttachmentTile_ClassNames)}
				>
					<X className={cn("AiChatAttachmentTile-remove-icon" satisfies AiChatAttachmentTile_ClassNames)} />
				</MyIconButton>
			)}
		</div>
	);
}
// #endregion attachment tile

// #region attachment preview src
function useAttachmentPreviewSrc() {
	const file = useAssistantState(({ attachment }) => attachment.file);
	const imageContent = useAssistantState(({ attachment }) => {
		const content = attachment.content;
		const imagePart = content?.find((part) => part.type === "image");
		return imagePart?.image;
	});
	const [src, setSrc] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (file) {
			const objectUrl = URL.createObjectURL(file);
			setSrc(objectUrl);
			return () => URL.revokeObjectURL(objectUrl);
		}

		setSrc(imageContent);
		return undefined;
	}, [file, imageContent]);

	return src;
}
// #endregion attachment preview src

// #region composer
export type AiChatComposer_ClassNames =
	| "AiChatComposer"
	| "AiChatComposer-input"
	| "AiChatComposer-area"
	| "AiChatComposer-textarea"
	| "AiChatComposer-actions"
	| "AiChatComposer-send-icon"
	| "AiChatComposer-cancel-icon";

export type AiChatComposer_Props = ComponentPropsWithRef<"form"> & {
	ref?: Ref<HTMLFormElement>;
	id?: string;
	className?: string;
};

function AiChatComposer(props: AiChatComposer_Props) {
	const { ref, id, className, ...rest } = props;
	const api = useAssistantApi();
	const text = useAssistantState(({ composer }) => composer.text);
	const isEmpty = useAssistantState(({ composer }) => composer.isEmpty);
	const canCancel = useAssistantState(({ composer }) => composer.canCancel);
	const isRunning = useAssistantState(({ thread }) => thread.isRunning);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	const canSend = !isRunning && !isEmpty;

	const handleSend = () => {
		if (!canSend) {
			return;
		}

		api.composer().send();
	};

	const handleCancel = () => {
		if (!canCancel) {
			return;
		}

		api.thread().cancelRun();
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key !== "Enter" || event.shiftKey) {
			return;
		}

		event.preventDefault();
		handleSend();
	};

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		handleSend();
	};

	useEffect(() => {
		const node = textareaRef.current;
		if (!node) {
			return;
		}

		node.style.height = "0px";
		node.style.height = `${node.scrollHeight}px`;
	}, [text]);

	return (
		<form
			ref={ref}
			id={id}
			className={cn("AiChatComposer" satisfies AiChatComposer_ClassNames, className)}
			onSubmit={handleSubmit}
			{...rest}
		>
			<MyInput variant="surface" className={cn("AiChatComposer-input" satisfies AiChatComposer_ClassNames)}>
				<MyInputBox />
				<MyInputArea className={cn("AiChatComposer-area" satisfies AiChatComposer_ClassNames)}>
					<AiChatComposerAttachments />
					<MyInputTextAreaControl
						ref={textareaRef}
						className={cn("AiChatComposer-textarea" satisfies AiChatComposer_ClassNames)}
						placeholder="Send a message..."
						rows={1}
						value={text}
						onChange={(event) => api.composer().setText(event.target.value)}
						onKeyDown={handleKeyDown}
					/>
				</MyInputArea>
			</MyInput>
			<div className={cn("AiChatComposer-actions" satisfies AiChatComposer_ClassNames)}>
				<AiChatComposerAttachmentAddButton />
				{isRunning ? (
					<MyIconButton
						type="button"
						variant="outline"
						tooltip="Stop generating"
						onClick={handleCancel}
						disabled={!canCancel}
					>
						<Square className={cn("AiChatComposer-cancel-icon" satisfies AiChatComposer_ClassNames)} />
					</MyIconButton>
				) : (
					<MyIconButton type="submit" variant="default" tooltip="Send message" disabled={!canSend}>
						<ArrowUp className={cn("AiChatComposer-send-icon" satisfies AiChatComposer_ClassNames)} />
					</MyIconButton>
				)}
			</div>
		</form>
	);
}
// #endregion composer

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
