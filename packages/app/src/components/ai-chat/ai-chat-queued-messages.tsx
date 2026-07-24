import "./ai-chat-queued-messages.css";

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DragDropContext, Draggable, Droppable, type DragUpdate, type DropResult } from "@hello-pangea/dnd";
import { X } from "lucide-react";

import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import type { AiChatQueuedUserMessage } from "@/hooks/ai-chat-controller.tsx";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

type AiChatQueuedMessages_ClassNames =
	| "AiChatQueuedMessages"
	| "AiChatQueuedMessages-header"
	| "AiChatQueuedMessages-heading"
	| "AiChatQueuedMessages-resume"
	| "AiChatQueuedMessages-list"
	| "AiChatQueuedMessages-item"
	| "AiChatQueuedMessages-item-state-editing"
	| "AiChatQueuedMessages-item-state-dragging"
	| "AiChatQueuedMessages-item-drop-before"
	| "AiChatQueuedMessages-item-drop-after"
	| "AiChatQueuedMessages-edit"
	| "AiChatQueuedMessages-text"
	| "AiChatQueuedMessages-remove"
	| "AiChatQueuedMessages-remove-icon"
	| "AiChatQueuedMessages-note";

type AiChatQueuedMessages_Props = {
	messages: readonly AiChatQueuedUserMessage[];
	editingMessageId: AiChatQueuedUserMessage["id"] | null;
	isFull: boolean;
	isPaused: boolean;
	onEdit: (messageId: AiChatQueuedUserMessage["id"]) => void;
	onRemove: (messageId: AiChatQueuedUserMessage["id"]) => void;
	onReorderStateChange: (isReordering: boolean) => void;
	onReorder: (orderedMessageIds: readonly AiChatQueuedUserMessage["id"][]) => void;
	onResume: () => void;
};

type AiChatQueuedMessages_DropIndicator = {
	messageId: AiChatQueuedUserMessage["id"];
	edge: "before" | "after";
};

export const AiChatQueuedMessages = memo(function AiChatQueuedMessages(props: AiChatQueuedMessages_Props) {
	const {
		messages,
		editingMessageId,
		isFull,
		isPaused,
		onEdit,
		onRemove,
		onReorderStateChange,
		onReorder,
		onResume,
	} = props;
	const appHoistingContainer = document.getElementById("app_hoisting_container" satisfies AppElementId);
	const rootRef = useRef<HTMLElement | null>(null);
	const composerRef = useRef<HTMLElement | null>(null);
	const isReorderingRef = useRef(false);
	const queueHadFocusRef = useRef(false);
	const focusedMessageIdRef = useRef<AiChatQueuedUserMessage["id"] | null>(null);
	const previousMessagesRef = useRef(messages);
	const [dropIndicator, setDropIndicator] = useState<AiChatQueuedMessages_DropIndicator | null>(null);

	useLayoutEffect(() => {
		const previousMessages = previousMessagesRef.current;
		previousMessagesRef.current = messages;

		const focusedMessageId = focusedMessageIdRef.current;
		const focusedMessageWasRemoved = Boolean(
			focusedMessageId && !messages.some((message) => message.id === focusedMessageId),
		);
		const focusedQueueBecameEmpty = queueHadFocusRef.current && messages.length === 0;
		if (!focusedMessageWasRemoved && !focusedQueueBecameEmpty) {
			return;
		}
		focusedMessageIdRef.current = null;
		queueHadFocusRef.current = false;
		if (document.activeElement !== document.body) {
			return;
		}

		const previousIndex = previousMessages.findIndex((message) => message.id === focusedMessageId);
		const editButtons = rootRef.current?.querySelectorAll<HTMLButtonElement>(
			`.${"AiChatQueuedMessages-edit" satisfies AiChatQueuedMessages_ClassNames}`,
		);
		const nextButton = editButtons?.[Math.min(Math.max(previousIndex, 0), editButtons.length - 1)];
		if (nextButton) {
			nextButton.focus();
		} else if (composerRef.current?.isConnected) {
			composerRef.current.focus();
		}
	}, [messages]);

	const rememberComposer = () => {
		composerRef.current =
			rootRef.current?.parentElement?.querySelector<HTMLElement>('[role="textbox"]') ?? composerRef.current;
	};

	const focusComposer = () => {
		requestAnimationFrame(() => {
			rememberComposer();
			composerRef.current?.focus();
		});
	};

	useEffect(() => {
		return () => {
			if (isReorderingRef.current) {
				onReorderStateChange(false);
			}
		};
	}, [onReorderStateChange]);

	const handleDragStart = () => {
		isReorderingRef.current = true;
		onReorderStateChange(true);
	};

	const handleDragUpdate = (update: DragUpdate) => {
		const destination = update.destination;
		const sourceIndex = messages.findIndex((message) => message.id === update.draggableId);
		if (!destination || sourceIndex < 0 || destination.index === sourceIndex) {
			setDropIndicator(null);
			return;
		}

		const destinationMessage = messages[destination.index];
		if (!destinationMessage) {
			setDropIndicator(null);
			return;
		}

		setDropIndicator({
			messageId: destinationMessage.id,
			edge: sourceIndex < destination.index ? "after" : "before",
		});
	};

	const handleDragEnd = (result: DropResult) => {
		setDropIndicator(null);
		const destination = result.destination;
		const sourceIndex = messages.findIndex((message) => message.id === result.draggableId);
		if (destination && sourceIndex >= 0 && destination.index !== sourceIndex) {
			const nextMessages = [...messages];
			const [message] = nextMessages.splice(sourceIndex, 1);
			if (message) {
				nextMessages.splice(Math.min(destination.index, nextMessages.length), 0, message);
				onReorder(nextMessages.map((queuedMessage) => queuedMessage.id));
			}
		}
		isReorderingRef.current = false;
		onReorderStateChange(false);
	};

	if (messages.length === 0) {
		return null;
	}

	return (
		<section
			ref={rootRef}
			className={"AiChatQueuedMessages" satisfies AiChatQueuedMessages_ClassNames}
			aria-label="Queue Messages"
			data-testid="ai-chat-queued-messages"
			onFocusCapture={() => {
				queueHadFocusRef.current = true;
				rememberComposer();
			}}
			onBlurCapture={(event) => {
				if (
					event.relatedTarget instanceof Node &&
					event.relatedTarget !== document.body &&
					!event.currentTarget.contains(event.relatedTarget)
				) {
					queueHadFocusRef.current = false;
					focusedMessageIdRef.current = null;
				}
			}}
		>
			<div className={"AiChatQueuedMessages-header" satisfies AiChatQueuedMessages_ClassNames}>
				<h3 className={"AiChatQueuedMessages-heading" satisfies AiChatQueuedMessages_ClassNames}>Queue Messages</h3>
				{isPaused ? (
					<MyButton
						className={"AiChatQueuedMessages-resume" satisfies AiChatQueuedMessages_ClassNames}
						variant="ghost"
						data-testid="ai-chat-queue-resume"
						onFocus={() => {
							focusedMessageIdRef.current = null;
							rememberComposer();
						}}
						onClick={() => {
							focusComposer();
							onResume();
						}}
					>
						Resume
					</MyButton>
				) : null}
			</div>

			<DragDropContext onDragStart={handleDragStart} onDragUpdate={handleDragUpdate} onDragEnd={handleDragEnd}>
				<Droppable droppableId="ai-chat-queued-messages">
					{(droppableProvided) => (
						<ol
							ref={droppableProvided.innerRef}
							{...droppableProvided.droppableProps}
							className={"AiChatQueuedMessages-list" satisfies AiChatQueuedMessages_ClassNames}
						>
							{messages.map((message, index) => {
								const isEditing = message.id === editingMessageId;
								const dropEdge = dropIndicator?.messageId === message.id ? dropIndicator.edge : null;

								return (
									<Draggable
										key={message.id}
										draggableId={message.id}
										index={index}
										isDragDisabled={messages.length < 2}
										disableInteractiveElementBlocking
									>
										{(draggableProvided, draggableSnapshot) => {
											const { role: _dragHandleRole, tabIndex: _dragHandleTabIndex, ...dragHandleProps } =
												draggableProvided.dragHandleProps ?? {};

											const draggableMessage = (
												<li
													ref={draggableProvided.innerRef}
													{...draggableProvided.draggableProps}
													className={cn(
														"AiChatQueuedMessages-item" satisfies AiChatQueuedMessages_ClassNames,
														isEditing &&
															("AiChatQueuedMessages-item-state-editing" satisfies AiChatQueuedMessages_ClassNames),
														draggableSnapshot.isDragging &&
															("AiChatQueuedMessages-item-state-dragging" satisfies AiChatQueuedMessages_ClassNames),
														dropEdge === "before" &&
															("AiChatQueuedMessages-item-drop-before" satisfies AiChatQueuedMessages_ClassNames),
														dropEdge === "after" &&
															("AiChatQueuedMessages-item-drop-after" satisfies AiChatQueuedMessages_ClassNames),
													)}
													data-testid={`ai-chat-queued-message-${message.id}`}
													data-queued-message-id={message.id}
													data-queue-index={index}
													data-editing={isEditing || undefined}
													data-dragging={draggableSnapshot.isDragging || undefined}
													data-drop-edge={dropEdge ?? undefined}
												>
													<MyButton
														{...dragHandleProps}
														className={"AiChatQueuedMessages-edit" satisfies AiChatQueuedMessages_ClassNames}
														variant="ghost"
														aria-label={`${isEditing ? "Editing" : "Edit"} queued message: ${message.text}`}
														data-testid="ai-chat-queued-message-edit"
														onFocus={() => {
															focusedMessageIdRef.current = message.id;
															rememberComposer();
														}}
														onClick={() => {
															onEdit(message.id);
														}}
													>
														<span
															className={"AiChatQueuedMessages-text" satisfies AiChatQueuedMessages_ClassNames}
														>
															{message.text}
														</span>
													</MyButton>
													<MyIconButton
														className={"AiChatQueuedMessages-remove" satisfies AiChatQueuedMessages_ClassNames}
														variant="ghost"
														tooltip="Remove queued message"
														aria-label={`Remove queued message: ${message.text}`}
														data-testid="ai-chat-queued-message-remove"
														onFocus={() => {
															focusedMessageIdRef.current = message.id;
															rememberComposer();
														}}
														onClick={() => {
															onRemove(message.id);
														}}
													>
														<X
															aria-hidden="true"
															className={
																"AiChatQueuedMessages-remove-icon" satisfies AiChatQueuedMessages_ClassNames
															}
														/>
													</MyIconButton>
												</li>
											);

											if (draggableSnapshot.isDragging && appHoistingContainer) {
												return createPortal(draggableMessage, appHoistingContainer);
											}

											return draggableMessage;
										}}
									</Draggable>
								);
							})}
							{droppableProvided.placeholder}
						</ol>
					)}
				</Droppable>
			</DragDropContext>

			{isPaused ? (
				<p className={"AiChatQueuedMessages-note" satisfies AiChatQueuedMessages_ClassNames}>
					Queue paused. Resume when you are ready.
				</p>
			) : isFull ? (
				<p className={"AiChatQueuedMessages-note" satisfies AiChatQueuedMessages_ClassNames}>
					Queue is full. Remove a message to add another.
				</p>
			) : null}
		</section>
	);
});
