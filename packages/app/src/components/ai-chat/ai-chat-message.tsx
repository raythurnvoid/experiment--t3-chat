import "./ai-chat-message.css";

import type { ComponentPropsWithRef, ReactNode, Ref } from "react";
import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, GitBranch, RefreshCw } from "lucide-react";
import type { ai_chat_AiSdk5UiMessage } from "@/lib/ai-chat.ts";

import { MyIconButton } from "@/components/my-icon-button.tsx";
import type { AiChatController } from "@/hooks/ai-chat-hooks.tsx";
import { ai_chat_get_parent_id } from "@/hooks/ai-chat-hooks.tsx";
import { AiChatComposer, type AiChatComposer_Props } from "@/components/ai-chat/ai-chat-composer.tsx";
import { AiChatMarkdown } from "@/components/ai-chat/ai-chat-markdown.tsx";
import { ai_chat_render_tool_part } from "@/components/ai-chat/ai-chat-tool-renderers.tsx";
import { cn } from "@/lib/utils.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";

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

type AiChatMessagePartInner_Props = {
	role: "assistant" | "user" | "system";
	part: ai_chat_AiSdk5UiMessage["parts"][number];
	message: ai_chat_AiSdk5UiMessage;
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

		return <div className={cn("AiChatMessagePart" satisfies AiChatMessagePart_ClassNames)}>{rendered}</div>;
	}

	if (partType === "text") {
		const textPart = part as { text: string };
		if (role === "assistant") {
			return (
				<AiChatMarkdown
					text={textPart.text}
					className={"AiChatMessagePart-markdown" satisfies AiChatMessagePart_ClassNames}
				/>
			);
		}

		return <p>{textPart.text}</p>;
	}

	if (partType === "reasoning") {
		const reasoningPart = part as { text: string };
		return <p>{reasoningPart.text}</p>;
	}

	if (typeof partType === "string" && partType.startsWith("data-")) {
		return null;
	}

	if (partType === "image") {
		const imagePart = part as unknown as { image: string; filename?: string };
		return (
			<img
				className={cn("AiChatMessagePart-image" satisfies AiChatMessagePart_ClassNames)}
				src={imagePart.image}
				alt={imagePart.filename ?? "Image attachment"}
			/>
		);
	}

	if (partType === "file") {
		const filePart = part as { filename?: string };
		return (
			<div className={cn("AiChatMessagePart-file" satisfies AiChatMessagePart_ClassNames)}>
				<span className={cn("AiChatMessagePart-file-name" satisfies AiChatMessagePart_ClassNames)}>
					{filePart.filename ?? "File attachment"}
				</span>
			</div>
		);
	}

	if (partType === "source-url") {
		const sourcePart = part as { url: string; title?: string };
		return (
			<a
				className={cn("AiChatMessagePart-source" satisfies AiChatMessagePart_ClassNames)}
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
				className={cn("AiChatMessagePart-source" satisfies AiChatMessagePart_ClassNames)}
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
// #region content

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

function AiChatMessageUser(props: AiChatMessage_Props) {
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
		onMessageBranchChat,
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

	const artifactId = find_artifact_id(message);

	const text = get_copy_text(message);

	const canEdit = !isRunning && Boolean(text);

	const handleCopy = () => {
		const text = get_copy_text(message);
		if (!text) {
			return;
		}

		navigator.clipboard
			.writeText(text)
			.then(() => setIsCopied(true))
			.catch(console.error);
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
	const showEditButton = !isEditing && Boolean(selectedThreadId) && canEdit;

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
						displayParts.map((part, index) => (
							<AiChatMessagePart
								key={`${message.id}:${index}`}
								part={part}
								role={message.role}
								message={message}
								artifactId={artifactId}
								toolActions={toolActions}
							/>
						))
					)}
				</AiChatMessageContent>
				{showEditButton && (
					<button
						className={cn("AiChatMessageUser-edit-button" satisfies AiChatMessageUser_ClassNames)}
						type="button"
						{...({ "data-ai-chat-message-id": message.id } satisfies Partial<AiChatMessage_CustomAttributes>)}
						aria-label="Edit message"
						onClick={handleStartEdit}
					/>
				)}
				<div className={cn("AiChatMessageUser-actions" satisfies AiChatMessageUser_ClassNames)} hidden={isEditing}>
					<MyIconButton
						variant="ghost"
						tooltip={isCopied ? "Copied" : "Copy message"}
						onClick={handleCopy}
						className={cn("AiChatMessageUser-action-button" satisfies AiChatMessageUser_ClassNames)}
					>
						{isCopied ? (
							<Check className={cn("AiChatMessageUser-action-icon" satisfies AiChatMessageUser_ClassNames)} />
						) : (
							<Copy className={cn("AiChatMessageUser-action-icon" satisfies AiChatMessageUser_ClassNames)} />
						)}
					</MyIconButton>
					{showBranchControls && (
						<div className={cn("AiChatMessageUser-branch-controls" satisfies AiChatMessageUser_ClassNames)}>
							<MyIconButton
								variant="ghost"
								tooltip="Previous variant"
								onClick={handleBranchPrev}
								disabled={isRunning}
								className={cn("AiChatMessageUser-action-button" satisfies AiChatMessageUser_ClassNames)}
							>
								<ChevronLeft className={cn("AiChatMessageUser-action-icon" satisfies AiChatMessageUser_ClassNames)} />
							</MyIconButton>
							<span className={cn("AiChatMessageUser-branch-label" satisfies AiChatMessageUser_ClassNames)}>
								{branchLabel}
							</span>
							<MyIconButton
								variant="ghost"
								tooltip="Next variant"
								onClick={handleBranchNext}
								disabled={isRunning}
								className={cn("AiChatMessageUser-action-button" satisfies AiChatMessageUser_ClassNames)}
							>
								<ChevronRight className={cn("AiChatMessageUser-action-icon" satisfies AiChatMessageUser_ClassNames)} />
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

function AiChatMessageAgent(props: AiChatMessage_Props) {
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
		onMessageRegenerate,
		onMessageBranchChat,
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

	const artifactId = find_artifact_id(message);

	const handleCopy = () => {
		const text = get_copy_text(message);
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

	useEffect(() => {
		if (!isCopied) {
			return;
		}

		const timeout = setTimeout(() => setIsCopied(false), 2000);
		return () => clearTimeout(timeout);
	}, [isCopied]);

	const showBranchControls = Boolean(branchMetadata && branchMetadata.variantCount > 1);
	const branchLabel = branchMetadata ? `${branchMetadata.variantIndex + 1}/${branchMetadata.variantCount}` : "";

	const renderedParts = displayParts.map((part, index) => (
		<AiChatMessagePart
			key={`${message.id}:${index}`}
			part={part}
			role={message.role}
			message={message}
			artifactId={artifactId}
			toolActions={toolActions}
		/>
	));

	return (
		<AiChatMessageContainer
			ref={ref}
			id={id}
			className={cn("AiChatMessageAgent" satisfies AiChatMessageAgent_ClassNames, className)}
			{...rest}
		>
			<AiChatMessageBubble className={cn("AiChatMessageAgent-bubble" satisfies AiChatMessageAgent_ClassNames)}>
				<AiChatMessageContent>{renderedParts}</AiChatMessageContent>
				<div className={cn("AiChatMessageAgent-actions" satisfies AiChatMessageAgent_ClassNames)} hidden={isEditing}>
					<MyIconButton
						variant="ghost"
						tooltip={isCopied ? "Copied" : "Copy message"}
						onClick={handleCopy}
						className={cn("AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames)}
					>
						{isCopied ? (
							<Check className={cn("AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames)} />
						) : (
							<Copy className={cn("AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames)} />
						)}
					</MyIconButton>
					<MyIconButton
						variant="ghost"
						tooltip="Branch chat here"
						onClick={handleBranchChat}
						disabled={!selectedThreadId || isRunning}
						className={cn("AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames)}
					>
						<GitBranch className={cn("AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames)} />
					</MyIconButton>
					{showBranchControls && (
						<div className={cn("AiChatMessageAgent-branch-controls" satisfies AiChatMessageAgent_ClassNames)}>
							<MyIconButton
								variant="ghost"
								tooltip="Previous variant"
								onClick={handleBranchPrev}
								disabled={isRunning}
								className={cn("AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames)}
							>
								<ChevronLeft className={cn("AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames)} />
							</MyIconButton>
							<span className={cn("AiChatMessageAgent-branch-label" satisfies AiChatMessageAgent_ClassNames)}>
								{branchLabel}
							</span>
							<MyIconButton
								variant="ghost"
								tooltip="Next variant"
								onClick={handleBranchNext}
								disabled={isRunning}
								className={cn("AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames)}
							>
								<ChevronRight
									className={cn("AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames)}
								/>
							</MyIconButton>
						</div>
					)}
					<MyIconButton
						variant="ghost"
						tooltip="Regenerate response"
						onClick={handleReload}
						className={cn("AiChatMessageAgent-action-button" satisfies AiChatMessageAgent_ClassNames)}
					>
						<RefreshCw className={cn("AiChatMessageAgent-action-icon" satisfies AiChatMessageAgent_ClassNames)} />
					</MyIconButton>
				</div>
			</AiChatMessageBubble>
		</AiChatMessageContainer>
	);
}
// #endregion agent message

// #region system message
type AiChatMessageSystem_ClassNames = "AiChatMessageSystem" | "AiChatMessageSystem-bubble";

function AiChatMessageSystem(props: AiChatMessage_Props) {
	const { ref, id, className, message, isEditing, toolActions, onMessageBranchChat, ...rest } = props;

	void onMessageBranchChat;

	const displayParts = message.parts.filter((part) => !part.type.startsWith("data-") && part.type !== "step-start");
	const artifactId = find_artifact_id(message);

	const renderedParts = displayParts.map((part, index) => (
		<AiChatMessagePart
			key={`${message.id}:${index}`}
			part={part}
			role={message.role}
			message={message}
			artifactId={artifactId}
			toolActions={toolActions}
		/>
	));

	return (
		<AiChatMessageContainer
			ref={ref}
			id={id}
			className={cn("AiChatMessageSystem" satisfies AiChatMessageSystem_ClassNames, className)}
			{...rest}
		>
			<AiChatMessageBubble className={cn("AiChatMessageSystem-bubble" satisfies AiChatMessageSystem_ClassNames)}>
				<AiChatMessageContent>{renderedParts}</AiChatMessageContent>
			</AiChatMessageBubble>
		</AiChatMessageContainer>
	);
}
// #endregion system message

// #region message
function get_copy_text(message: ai_chat_AiSdk5UiMessage) {
	const textFromParts = message.parts
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	return textFromParts.length > 0 ? textFromParts : null;
}

function find_artifact_id(message: ai_chat_AiSdk5UiMessage) {
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
}

type AiChatMessage_BranchMetadata = {
	variantIndex: number;
	variantCount: number;
	variantAnchorIds: string[];
};

export type AiChatMessage_ToolActions = {
	addToolOutput: AiChatController["addToolOutput"];
	resumeStream: AiChatController["resumeStream"];
	stop: AiChatController["stop"];
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
	toolActions: AiChatMessage_ToolActions;
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
