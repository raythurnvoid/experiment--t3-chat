import "./ai-chat.css";

import type { ComponentPropsWithRef, Ref } from "react";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, Check, ChevronLeft, ChevronRight, Copy, Menu, PanelLeft, Pencil, RefreshCw, X } from "lucide-react";
import type { ai_chat_AiSdkUiMessage } from "@/lib/ai-chat.ts";

import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { AiChatThreads } from "@/components/ai-chat/ai-chat-threads.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { InfiniteScrollSentinel } from "@/components/infinite-scroll-sentinel.tsx";
import { cn, forward_ref } from "@/lib/utils.ts";
import type { AiChatController } from "@/lib/ai-chat/use-ai-chat-controller.tsx";
import { ai_chat_get_parent_id, useAiChatController } from "@/lib/ai-chat/use-ai-chat-controller.tsx";
import { AiChatComposer, type AiChatComposer_Props } from "@/components/ai-chat/ai-chat-composer.tsx";
import { AiChatMarkdown } from "@/components/ai-chat/ai-chat-markdown.tsx";
import { ai_chat_render_tool_part } from "@/components/ai-chat/ai-chat-tool-renderers.tsx";

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

// #region message
export type AiChatMessage_ClassNames =
	| "AiChatMessage"
	| "AiChatMessage-role-user"
	| "AiChatMessage-role-assistant"
	| "AiChatMessage-role-system"
	| "AiChatMessage-content"
	| "AiChatMessage-bubble"
	| "AiChatMessage-bubble-state-editing"
	| "AiChatMessage-text"
	| "AiChatMessage-markdown"
	| "AiChatMessage-actions"
	| "AiChatMessage-action-button"
	| "AiChatMessage-action-icon"
	| "AiChatMessage-branch-controls"
	| "AiChatMessage-branch-label"
	| "AiChatMessage-part"
	| "AiChatMessage-image"
	| "AiChatMessage-file"
	| "AiChatMessage-file-name"
	| "AiChatMessage-source";

type AiChatMessage_BranchMetadata = {
	variantIndex: number;
	variantCount: number;
	variantAnchorIds: string[];
};

type AiChatMessage_ToolActions = {
	addToolOutput: AiChatController["addToolOutput"];
	resumeStream: AiChatController["resumeStream"];
	stop: AiChatController["stop"];
};

const ai_chat_get_copy_text = (message: ai_chat_AiSdkUiMessage) => {
	const textFromParts = message.parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return textFromParts.length > 0 ? textFromParts : null;
};

const ai_chat_find_artifact_id = (message: ai_chat_AiSdkUiMessage) => {
	const parts = message.parts ?? [];
	for (const part of parts) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const partType = (part as { type?: string }).type;
		if (partType !== "data-artifact-id") {
			continue;
		}

		const data = (part as { data?: unknown }).data;
		if (typeof data === "string") {
			return data;
		}

		if (data && typeof data === "object" && "id" in data) {
			const artifactId = (data as { id?: unknown }).id;
			if (typeof artifactId === "string") {
				return artifactId;
			}
		}
	}

	return null;
};

export type AiChatMessage_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;

	message: ai_chat_AiSdkUiMessage;
	selectedThreadId: string | null;
	isRunning: boolean;
	isEditing: boolean;
	messagesChildrenByParentId: ReturnType<typeof useAiChatController>["messagesChildrenByParentId"];
	toolActions: AiChatMessage_ToolActions;
	onEditStart: (args: { messageId: string; parentId: string | null }) => void;
	onEditCancel: () => void;
	onEditSubmit: (args: { value: string }) => void;
	onMessageRegenerate: (args: { threadId: string; messageId: string }) => void;
	onSelectBranchAnchor: (threadId: string, anchorId: string) => void;
};

function AiChatMessage(props: AiChatMessage_Props) {
	const {
		ref,
		id,
		className,
		message,
		selectedThreadId,
		isRunning,
		isEditing,
		messagesChildrenByParentId,
		toolActions,
		onEditStart,
		onEditCancel,
		onEditSubmit,
		onMessageRegenerate,
		onSelectBranchAnchor,
		...rest
	} = props;

	const [isCopied, setIsCopied] = useState(false);

	const displayParts = message.parts.filter((part) => !part.type.startsWith("data-") && part.type !== "step-start");
	const branchMetadata = ((/* iife */) => {
		const siblings = messagesChildrenByParentId.get(ai_chat_get_parent_id(message.metadata?.convexParentId)) ?? [];
		const currentIndex = siblings.indexOf(message);

		return {
			variantIndex: currentIndex,
			variantCount: siblings.length,
			variantAnchorIds: siblings.map((sibling) => sibling.id),
		} satisfies AiChatMessage_BranchMetadata;
	})();

	const artifactId = ai_chat_find_artifact_id(message);

	const text = ai_chat_get_copy_text(message);

	const canEdit = message.role === "user" && !isRunning && Boolean(text);

	const handleCopy = () => {
		const text = ai_chat_get_copy_text(message);
		if (!text) {
			return;
		}

		navigator.clipboard
			.writeText(text)
			.then(() => setIsCopied(true))
			.catch(console.error);
	};

	const handleReload = () => {
		if (!selectedThreadId) {
			return;
		}
		onMessageRegenerate({ threadId: selectedThreadId, messageId: message.id });
	};

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

	useEffect(() => {
		if (!isCopied) {
			return;
		}

		const timeout = setTimeout(() => setIsCopied(false), 2000);
		return () => clearTimeout(timeout);
	}, [isCopied]);

	const showBranchControls = Boolean(branchMetadata && branchMetadata.variantCount > 1);
	const branchLabel = branchMetadata ? `${branchMetadata.variantIndex + 1}/${branchMetadata.variantCount}` : "";

	return (
		<div
			ref={ref}
			id={id}
			data-role={message.role}
			className={cn(
				"AiChatMessage" satisfies AiChatMessage_ClassNames,
				message.role === "user" && ("AiChatMessage-role-user" satisfies AiChatMessage_ClassNames),
				message.role === "assistant" && ("AiChatMessage-role-assistant" satisfies AiChatMessage_ClassNames),
				message.role === "system" && ("AiChatMessage-role-system" satisfies AiChatMessage_ClassNames),
				className,
			)}
			{...rest}
		>
			<div className={cn("AiChatMessage-content" satisfies AiChatMessage_ClassNames)}>
				{isEditing ? (
					<div
						className={cn(
							"AiChatMessage-bubble" satisfies AiChatMessage_ClassNames,
							"AiChatMessage-bubble-state-editing" satisfies AiChatMessage_ClassNames,
						)}
					>
						<AiChatComposer
							key={message.id}
							canCancel={false}
							isRunning={false}
							initialValue={text ?? ""}
							onValueChange={handleEditValueChange}
							onSubmit={handleEditSubmit}
							onCancel={() => {}}
						/>
					</div>
				) : (
					displayParts.length > 0 && (
						<div className={cn("AiChatMessage-bubble" satisfies AiChatMessage_ClassNames)}>
							{displayParts.map((part, index) => (
								<AiChatMessagePart
									key={`${message.id}:${index}`}
									part={part}
									role={message.role}
									message={message}
									artifactId={artifactId}
									toolActions={toolActions}
								/>
							))}
						</div>
					)
				)}
			</div>
			{message.role !== "system" && (
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
					{showBranchControls && (
						<div className={cn("AiChatMessage-branch-controls" satisfies AiChatMessage_ClassNames)}>
							<MyIconButton
								variant="ghost"
								tooltip="Previous variant"
								onClick={handleBranchPrev}
								disabled={isRunning}
								className={cn("AiChatMessage-action-button" satisfies AiChatMessage_ClassNames)}
							>
								<ChevronLeft className={cn("AiChatMessage-action-icon" satisfies AiChatMessage_ClassNames)} />
							</MyIconButton>
							<span className={cn("AiChatMessage-branch-label" satisfies AiChatMessage_ClassNames)}>{branchLabel}</span>
							<MyIconButton
								variant="ghost"
								tooltip="Next variant"
								onClick={handleBranchNext}
								disabled={isRunning}
								className={cn("AiChatMessage-action-button" satisfies AiChatMessage_ClassNames)}
							>
								<ChevronRight className={cn("AiChatMessage-action-icon" satisfies AiChatMessage_ClassNames)} />
							</MyIconButton>
						</div>
					)}
					{message.role === "user" &&
						(isEditing ? (
							<MyIconButton
								variant="ghost"
								tooltip="Cancel edit"
								onClick={handleEditCancel}
								className={cn("AiChatMessage-action-button" satisfies AiChatMessage_ClassNames)}
							>
								<X className={cn("AiChatMessage-action-icon" satisfies AiChatMessage_ClassNames)} />
							</MyIconButton>
						) : (
							<MyIconButton
								variant="ghost"
								tooltip={text ? "Edit message" : "Message cannot be edited"}
								onClick={handleStartEdit}
								disabled={!canEdit}
								className={cn("AiChatMessage-action-button" satisfies AiChatMessage_ClassNames)}
							>
								<Pencil className={cn("AiChatMessage-action-icon" satisfies AiChatMessage_ClassNames)} />
							</MyIconButton>
						))}
					{message.role === "assistant" && (
						<MyIconButton
							variant="ghost"
							tooltip="Regenerate response"
							onClick={handleReload}
							className={cn("AiChatMessage-action-button" satisfies AiChatMessage_ClassNames)}
						>
							<RefreshCw className={cn("AiChatMessage-action-icon" satisfies AiChatMessage_ClassNames)} />
						</MyIconButton>
					)}
				</div>
			)}
		</div>
	);
}
// #endregion message

// #region message part
type AiChatMessagePart_Props = {
	role: "assistant" | "user" | "system";
	part: ai_chat_AiSdkUiMessage["parts"][number];
	message: ai_chat_AiSdkUiMessage;
	artifactId: string | null;
	toolActions: AiChatMessage_ToolActions;
};

function AiChatMessagePart(props: AiChatMessagePart_Props) {
	const { role, part, message, artifactId, toolActions } = props;

	return (
		<AiChatMessagePartInner
			role={role}
			part={part}
			message={message}
			artifactId={artifactId}
			toolActions={toolActions}
		/>
	);
}
// #endregion message part

// #region message part inner
type AiChatMessagePartInner_Props = {
	role: "assistant" | "user" | "system";
	part: ai_chat_AiSdkUiMessage["parts"][number];
	message: ai_chat_AiSdkUiMessage;
	artifactId: string | null;
	toolActions: AiChatMessage_ToolActions;
};

function AiChatMessagePartInner(props: AiChatMessagePartInner_Props) {
	const { role, part, message, artifactId, toolActions } = props;
	const partType = (part as { type?: string }).type;

	if (partType === "dynamic-tool" || (typeof partType === "string" && partType.startsWith("tool-"))) {
		const rendered = ai_chat_render_tool_part({
			part: part as {
				type: string;
				toolName?: string;
				toolCallId?: string;
				state?: string;
				input?: unknown;
				output?: unknown;
			},
			messageId: message.id,
			artifactId: artifactId ?? undefined,
			actions: {
				addToolOutput: toolActions.addToolOutput,
				resumeStream: toolActions.resumeStream,
				stop: toolActions.stop,
			},
		});

		if (!rendered) {
			return null;
		}

		return <div className={cn("AiChatMessage-part" satisfies AiChatMessage_ClassNames)}>{rendered}</div>;
	}

	if (partType === "text") {
		const textPart = part as { text: string };
		if (role === "assistant") {
			return (
				<AiChatMarkdown text={textPart.text} className={"AiChatMessage-markdown" satisfies AiChatMessage_ClassNames} />
			);
		}

		return <p className={cn("AiChatMessage-text" satisfies AiChatMessage_ClassNames)}>{textPart.text}</p>;
	}

	if (partType === "reasoning") {
		const reasoningPart = part as { text: string };
		return <p className={cn("AiChatMessage-text" satisfies AiChatMessage_ClassNames)}>{reasoningPart.text}</p>;
	}

	if (typeof partType === "string" && partType.startsWith("data-")) {
		return null;
	}

	if (partType === "image") {
		const imagePart = part as unknown as { image: string; filename?: string };
		return (
			<img
				className={cn("AiChatMessage-image" satisfies AiChatMessage_ClassNames)}
				src={imagePart.image}
				alt={imagePart.filename ?? "Image attachment"}
			/>
		);
	}

	if (partType === "file") {
		const filePart = part as { filename?: string };
		return (
			<div className={cn("AiChatMessage-file" satisfies AiChatMessage_ClassNames)}>
				<span className={cn("AiChatMessage-file-name" satisfies AiChatMessage_ClassNames)}>
					{filePart.filename ?? "File attachment"}
				</span>
			</div>
		);
	}

	if (partType === "source-url") {
		const sourcePart = part as { url: string; title?: string };
		return (
			<a
				className={cn("AiChatMessage-source" satisfies AiChatMessage_ClassNames)}
				href={sourcePart.url}
				target="_blank"
				rel="noreferrer"
			>
				{sourcePart.title ?? sourcePart.url}
			</a>
		);
	}

	if (partType === "source") {
		const legacySourcePart = part as { url: string; title?: string };
		return (
			<a
				className={cn("AiChatMessage-source" satisfies AiChatMessage_ClassNames)}
				href={legacySourcePart.url}
				target="_blank"
				rel="noreferrer"
			>
				{legacySourcePart.title ?? legacySourcePart.url}
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

	selectedThreadId: string | null;
	activeBranchMessages: ReturnType<typeof useAiChatController>["activeBranchMessages"];
	messagesChildrenByParentId: ReturnType<typeof useAiChatController>["messagesChildrenByParentId"];
	isRunning: boolean;
	editingMessageId: string | null;
	toolActions: AiChatMessage_ToolActions;
	onEditStart: AiChatMessage_Props["onEditStart"];
	onEditCancel: AiChatMessage_Props["onEditCancel"];
	onEditSubmit: AiChatMessage_Props["onEditSubmit"];
	onClickSuggestion: (action: string) => void;
	onMessageRegenerate: AiChatMessage_Props["onMessageRegenerate"];
	onSelectBranchAnchor: AiChatMessage_Props["onSelectBranchAnchor"];
};

function AiChatMessageList(props: AiChatMessageList_Props) {
	const {
		ref,
		id,
		className,
		selectedThreadId,
		activeBranchMessages,
		messagesChildrenByParentId,
		isRunning,
		editingMessageId,
		toolActions,
		onEditStart,
		onEditCancel,
		onEditSubmit,
		onClickSuggestion,
		onMessageRegenerate,
		onSelectBranchAnchor,
		...rest
	} = props;

	const messageCount = activeBranchMessages.length;

	const handleSuggestionClick = (action: string) => {
		onClickSuggestion(action);
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
				activeBranchMessages.map((message) => (
					<AiChatMessage
						key={message.id}
						message={message}
						selectedThreadId={selectedThreadId}
						isRunning={isRunning}
						isEditing={editingMessageId === message.id}
						messagesChildrenByParentId={messagesChildrenByParentId}
						toolActions={toolActions}
						onEditStart={onEditStart}
						onEditCancel={onEditCancel}
						onEditSubmit={onEditSubmit}
						onMessageRegenerate={onMessageRegenerate}
						onSelectBranchAnchor={onSelectBranchAnchor}
					/>
				))
			)}
		</div>
	);
}
// #endregion message list

// #region thread
type AiChatThread_ClassNames =
	| "AiChatThread"
	| "AiChatThread-scroll-area"
	| "AiChatThread-scroll-area-inner"
	| "AiChatThread-scroll-to-bottom"
	| "AiChatThread-scroll-to-bottom-icon"
	| "AiChatThread-composer";

type AiChatThread_Props = {
	controller: AiChatController;
};

function AiChatThread(props: AiChatThread_Props) {
	const { controller } = props;

	const [isAtBottom, setIsAtBottom] = useState(true);
	const messageCount = controller.activeBranchMessages.length;
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
	const [editingState, setEditingState] = useState<{
		messageId: string;
		parentId: string | null;
	} | null>(null);

	const handleScrollToBottom = () => {
		const node = scrollRef.current;
		if (!node) {
			return;
		}

		node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
	};

	const handleIsAtBottomIntersection = (args: { entry: IntersectionObserverEntry; observer: IntersectionObserver }) => {
		setIsAtBottom(args.entry.isIntersecting);
	};

	useEffect(() => {
		const node = scrollRef.current;
		if (!node) {
			return;
		}

		if (isAtBottom) {
			node.scrollTop = node.scrollHeight;
		}
	}, [messageCount, isAtBottom]);

	const selectedThreadId = controller.selectedThreadId;
	const initialComposerValue = controller.session?.draftComposerText ?? "";

	const handleComposerValueChange: AiChatComposer_Props["onValueChange"] = (value) => {
		if (!selectedThreadId) {
			return;
		}
		controller.setComposerValue(selectedThreadId, value);
	};

	const handleComposerSubmit: AiChatComposer_Props["onSubmit"] = (value) => {
		if (!value.trim()) {
			return;
		}

		if (selectedThreadId) {
			controller.sendUserText(selectedThreadId, value);
		} else {
			controller.startNewChat(value);
		}
	};

	const handleComposerCancel: AiChatComposer_Props["onCancel"] = () => {
		controller.stop();
	};

	const handleClickSuggestion: AiChatMessageList_Props["onClickSuggestion"] = (action) => {
		if (!action.trim()) {
			return;
		}

		if (selectedThreadId) {
			controller.sendUserText(selectedThreadId, action);
		} else {
			controller.startNewChat(action);
		}
	};

	const handleMessageRegenerate: AiChatMessageList_Props["onMessageRegenerate"] = (args) => {
		if (!selectedThreadId || args.threadId !== selectedThreadId) {
			return;
		}

		controller.regenerate(args.threadId, args.messageId);
	};

	const handleEditStart: AiChatMessageList_Props["onEditStart"] = (args) => {
		if (!selectedThreadId) {
			return;
		}
		if (controller.isRunning) {
			return;
		}
		controller.selectBranchAnchor(selectedThreadId, args.parentId);
		setEditingState({
			messageId: args.messageId,
			parentId: args.parentId,
		});
	};

	const handleEditCancel: AiChatMessageList_Props["onEditCancel"] = () => {
		setEditingState(null);
	};

	const handleEditSubmit: AiChatMessageList_Props["onEditSubmit"] = (args) => {
		if (!selectedThreadId) {
			return;
		}
		const editing = editingState;
		if (!editing) {
			return;
		}
		const value = args.value.trim();
		if (!value) {
			return;
		}

		controller.sendUserText(selectedThreadId, value, { parentId: editing.parentId });
		setEditingState(null);
	};

	return (
		<div className={cn("AiChatThread" satisfies AiChatThread_ClassNames)}>
			<div
				ref={(node) => forward_ref(node, scrollRef, setScrollRoot)}
				className={cn("AiChatThread-scroll-area" satisfies AiChatThread_ClassNames)}
			>
				<div className={cn("AiChatThread-scroll-area-inner" satisfies AiChatThread_ClassNames)}>
					<AiChatMessageList
						selectedThreadId={selectedThreadId}
						activeBranchMessages={controller.activeBranchMessages}
						messagesChildrenByParentId={controller.messagesChildrenByParentId}
						isRunning={controller.isRunning}
						editingMessageId={editingState?.messageId ?? null}
						onEditStart={handleEditStart}
						onEditCancel={handleEditCancel}
						onEditSubmit={handleEditSubmit}
						toolActions={{
							addToolOutput: controller.addToolOutput,
							resumeStream: controller.resumeStream,
							stop: controller.stop,
						}}
						onClickSuggestion={handleClickSuggestion}
						onMessageRegenerate={handleMessageRegenerate}
						onSelectBranchAnchor={controller.selectBranchAnchor}
					/>
					<InfiniteScrollSentinel
						root={scrollRoot}
						// Treat "at bottom" as within ~80px of the end.
						rootMargin="0px 0px 80px 0px"
						onIntersection={handleIsAtBottomIntersection}
					/>
				</div>
				{!isAtBottom && (
					<div className={cn("AiChatThread-scroll-to-bottom" satisfies AiChatThread_ClassNames)}>
						<MyIconButton variant="outline" tooltip="Scroll to bottom" onClick={handleScrollToBottom}>
							<ArrowDown className={cn("AiChatThread-scroll-to-bottom-icon" satisfies AiChatThread_ClassNames)} />
						</MyIconButton>
					</div>
				)}
			</div>
			<div className={cn("AiChatThread-composer" satisfies AiChatThread_ClassNames)}>
				<AiChatComposer
					key={selectedThreadId ?? "new"}
					canCancel={controller.isRunning}
					isRunning={controller.isRunning}
					initialValue={initialComposerValue}
					onValueChange={handleComposerValueChange}
					onSubmit={handleComposerSubmit}
					onCancel={handleComposerCancel}
				/>
			</div>
		</div>
	);
}
// #endregion thread

// #region root
type AiChat_ClassNames =
	| "AiChat"
	| "AiChat-ai-sidebar"
	| "AiChat-ai-sidebar-state-open"
	| "AiChat-ai-sidebar-state-closed"
	| "AiChat-main"
	| "AiChat-thread-panel"
	| "AiChat-thread-controls"
	| "AiChat-thread-control-button"
	| "AiChat-thread-control-icon"
	| "AiChat-thread-content";

export type AiChat_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
};

export function AiChat(props: AiChat_Props) {
	const { ref, id, className, ...rest } = props;

	const controller = useAiChatController();
	const [aiChatSidebarOpen, setAiChatSidebarOpen] = useState(true);
	const { toggleSidebar } = MainAppSidebar.useSidebar();

	return (
		<div ref={ref} id={id} className={cn("AiChat" satisfies AiChat_ClassNames, className)} {...rest}>
			{/* AI Chat Sidebar - positioned between main sidebar and content with animation */}
			<div
				className={cn(
					"AiChat-ai-sidebar" satisfies AiChat_ClassNames,
					aiChatSidebarOpen
						? ("AiChat-ai-sidebar-state-open" satisfies AiChat_ClassNames)
						: ("AiChat-ai-sidebar-state-closed" satisfies AiChat_ClassNames),
				)}
			>
				<AiChatThreads
					paginatedThreads={controller.paginatedThreads}
					streamingTitleByThreadId={controller.streamingTitleByThreadId}
					selectedThreadId={controller.selectedThreadId}
					onClose={() => setAiChatSidebarOpen(false)}
					onSelectThread={controller.selectThread}
					onToggleFavouriteThread={controller.setThreadStarred}
					onArchiveThread={controller.archiveThread}
					onNewChat={controller.startNewChat}
				/>
			</div>

			{/* Main Content Area - takes remaining space */}
			<div className={cn("AiChat-main" satisfies AiChat_ClassNames)}>
				<div className={cn("AiChat-thread-panel" satisfies AiChat_ClassNames)}>
					{!aiChatSidebarOpen && (
						<div className={cn("AiChat-thread-controls" satisfies AiChat_ClassNames)}>
							<MyIconButton
								variant="outline"
								tooltip="Open app sidebar"
								onClick={toggleSidebar}
								className={cn("AiChat-thread-control-button" satisfies AiChat_ClassNames)}
							>
								<Menu className={cn("AiChat-thread-control-icon" satisfies AiChat_ClassNames)} />
							</MyIconButton>

							<MyIconButton
								variant="outline"
								tooltip="Open chat threads"
								onClick={() => setAiChatSidebarOpen(true)}
								className={cn("AiChat-thread-control-button" satisfies AiChat_ClassNames)}
							>
								<PanelLeft className={cn("AiChat-thread-control-icon" satisfies AiChat_ClassNames)} />
							</MyIconButton>
						</div>
					)}
					<div className={cn("AiChat-thread-content" satisfies AiChat_ClassNames)}>
						<AiChatThread controller={controller} />
					</div>
				</div>
			</div>
		</div>
	);
}

// #endregion root
