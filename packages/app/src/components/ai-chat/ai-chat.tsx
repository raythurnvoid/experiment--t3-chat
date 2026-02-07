import "./ai-chat.css";

import type { ComponentPropsWithRef, Ref } from "react";
import { useState, useEffect, useEffectEvent, useRef } from "react";
import { ArrowDown, Menu, PanelLeft } from "lucide-react";

import { MyButton } from "@/components/my-button.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { AiChatThreads } from "@/components/ai-chat/ai-chat-threads.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { dom_find_first_element_overflowing_element, dom_TypedAttributeAccessor } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import { use_app_global_store } from "@/lib/app-global-store.ts";
import { ai_chat_get_parent_id, useAiChatController, type AiChatController } from "@/hooks/ai-chat-hooks.tsx";
import {
	AiChatComposer,
	type AiChatComposer_ClassNames,
	type AiChatComposer_Props,
} from "@/components/ai-chat/ai-chat-composer.tsx";
import {
	AiChatMessage,
	type AiChatMessage_ClassNames,
	type AiChatMessage_CustomAttributes,
	type AiChatMessage_Props,
	type AiChatMessageUser_ClassNames,
} from "@/components/ai-chat/ai-chat-message.tsx";

// #region welcome
type AiChatWelcome_ClassNames =
	| "AiChatWelcome"
	| "AiChatWelcome-title"
	| "AiChatWelcome-subtitle"
	| "AiChatWelcome-suggestions"
	| "AiChatWelcome-suggestion"
	| "AiChatWelcome-suggestion-title"
	| "AiChatWelcome-suggestion-label";

type AiChatWelcome_Props = {
	onClickSuggestion: (action: string) => void;
};

function AiChatWelcome(props: AiChatWelcome_Props) {
	const { onClickSuggestion } = props;

	// TODO: the suggestions should be based on recent users activity

	return (
		<div className={"AiChatWelcome" satisfies AiChatWelcome_ClassNames}>
			<h3 className={"AiChatWelcome-title" satisfies AiChatWelcome_ClassNames}>Hello there!</h3>
			<p className={"AiChatWelcome-subtitle" satisfies AiChatWelcome_ClassNames}>How can I help you today?</p>
			<div className={"AiChatWelcome-suggestions" satisfies AiChatWelcome_ClassNames}>
				{[
					{
						title: "Draft a new page",
						label: "from a topic or rough notes",
						action: "Create a new page with a well-structured draft about ",
					},
					{
						title: "Summarize my docs",
						label: "find key points across pages",
						action: "Search through my pages and give me a summary of what's documented so far",
					},
					{
						title: "Help me write",
						label: "draft a professional email",
						action: "Help me draft a professional email to ",
					},
					{
						title: "Edit an existing page",
						label: "improve, expand, or fix content",
						action: "Find and improve the content of ",
					},
				].map((suggestion) => (
					<MyButton
						key={suggestion.action}
						variant="secondary-subtle"
						className={"AiChatWelcome-suggestion" satisfies AiChatWelcome_ClassNames}
						onClick={() => onClickSuggestion(suggestion.action)}
					>
						<span className={"AiChatWelcome-suggestion-title" satisfies AiChatWelcome_ClassNames}>
							{suggestion.title}
						</span>
						<span className={"AiChatWelcome-suggestion-label" satisfies AiChatWelcome_ClassNames}>
							{suggestion.label}
						</span>
					</MyButton>
				))}
			</div>
		</div>
	);
}
// #endregion welcome

// #region messages list
export type AiChatMessagesList_ClassNames = "AiChatMessageList";

export type AiChatMessagesList_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;

	selectedThreadId: string | null;
	activeBranchMessages: ReturnType<typeof useAiChatController>["activeBranchMessages"];
	messagesChildrenByParentId: ReturnType<typeof useAiChatController>["messagesChildrenByParentId"];
	isRunning: boolean;
	editingMessageId: string | null;
	onToolOutput: AiChatMessage_Props["onToolOutput"];
	onToolResumeStream: AiChatMessage_Props["onToolResumeStream"];
	onToolStop: AiChatMessage_Props["onToolStop"];
	onEditStart: AiChatMessage_Props["onEditStart"];
	onEditCancel: AiChatMessage_Props["onEditCancel"];
	onEditSubmit: AiChatMessage_Props["onEditSubmit"];
	onClickSuggestion: (action: string) => void;
	onMessageRegenerate: AiChatMessage_Props["onMessageRegenerate"];
	onMessageBranchChat: AiChatMessage_Props["onMessageBranchChat"];
	onSelectBranchAnchor: AiChatMessage_Props["onSelectBranchAnchor"];
};

function AiChatMessagesList(props: AiChatMessagesList_Props) {
	const {
		ref,
		id,
		className,
		selectedThreadId,
		activeBranchMessages,
		messagesChildrenByParentId,
		isRunning,
		editingMessageId,
		onToolOutput,
		onToolResumeStream,
		onToolStop,
		onEditStart,
		onEditCancel,
		onEditSubmit,
		onClickSuggestion,
		onMessageRegenerate,
		onMessageBranchChat,
		onSelectBranchAnchor,
		...rest
	} = props;

	const messageCount = activeBranchMessages.list.length;

	const handleSuggestionClick = (action: string) => {
		onClickSuggestion(action);
	};

	return (
		<div
			// Ensure the list is unmounted when the thread or branch anchor is changed
			// or when the branch is switched
			key={`${selectedThreadId ?? "new"}:${activeBranchMessages.anchorId ?? "root"}`}
			ref={ref}
			id={id}
			className={cn("AiChatMessageList" satisfies AiChatMessagesList_ClassNames, className)}
			{...rest}
		>
			{messageCount === 0 ? (
				<AiChatWelcome onClickSuggestion={handleSuggestionClick} />
			) : (
				activeBranchMessages.list.map((message, index) => (
					<AiChatMessage
						// index is better in this case because the messages follow a static order
						// and this will prevent them from being unmounted when the message is
						// persisted after stream
						key={index}
						message={message}
						selectedThreadId={selectedThreadId}
						isRunning={isRunning}
						isEditing={editingMessageId === message.id}
						messagesChildrenByParentId={messagesChildrenByParentId}
						onToolOutput={onToolOutput}
						onToolResumeStream={onToolResumeStream}
						onToolStop={onToolStop}
						onEditStart={onEditStart}
						onEditCancel={onEditCancel}
						onEditSubmit={onEditSubmit}
						onMessageRegenerate={onMessageRegenerate}
						onMessageBranchChat={onMessageBranchChat}
						onSelectBranchAnchor={onSelectBranchAnchor}
					/>
				))
			)}
		</div>
	);
}
// #endregion messages list

// #region auto scroll hook
const AUTO_SCROLL_BOTTOM_MARGIN = 1;

type useAutoScroll_Props = {
	scrollEl: HTMLDivElement | null;
	contentEl: HTMLDivElement | null;
	controller: AiChatController;
	enable?: boolean;
};

function useAutoScroll(props: useAutoScroll_Props) {
	const { scrollEl, contentEl, controller, enable = true } = props;

	const isRunning = controller.isRunning;
	const threadId = controller.selectedThreadId;

	const [isAtBottom, setIsAtBottom] = useState(true);
	const isAtBottomRef = useRef(isAtBottom);

	const wasRunningRef = useRef(isRunning);
	const lastScrollTopRef = useRef(0);

	// stores the scroll behavior to reuse during content resize, or null if not scrolling
	const scrollingToBottomBehaviorRef = useRef<ScrollBehavior | null>(null);

	useEffect(() => {
		isAtBottomRef.current = isAtBottom;
	}, [isAtBottom]);

	const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
		if (!scrollEl) {
			return;
		}

		scrollingToBottomBehaviorRef.current = behavior;
		scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior });
	};

	const handleScroll = useEffectEvent(() => {
		if (!scrollEl) {
			return;
		}

		const newIsAtBottom =
			scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= AUTO_SCROLL_BOTTOM_MARGIN ||
			scrollEl.scrollHeight <= scrollEl.clientHeight;

		if (!newIsAtBottom && lastScrollTopRef.current < scrollEl.scrollTop) {
			// ignore scroll down
		} else {
			if (newIsAtBottom) {
				scrollingToBottomBehaviorRef.current = null;
			}

			const shouldUpdate = newIsAtBottom || scrollingToBottomBehaviorRef.current === null;

			if (shouldUpdate) {
				setIsAtBottom(newIsAtBottom);
			}
		}

		lastScrollTopRef.current = scrollEl.scrollTop;
	});

	const handleContentResize = useEffectEvent(() => {
		if (!enable) {
			handleScroll();
			return;
		}

		const scrollBehavior = scrollingToBottomBehaviorRef.current;
		if (scrollBehavior) {
			scrollToBottom(scrollBehavior);
		} else if (isAtBottomRef.current) {
			scrollToBottom("instant");
		}

		handleScroll();
	});

	useEffect(() => {
		const el = scrollEl;
		if (!el) {
			return;
		}

		lastScrollTopRef.current = el.scrollTop;

		handleScroll();
		el.addEventListener("scroll", handleScroll, { passive: true });
		return () => el.removeEventListener("scroll", handleScroll);
	}, [scrollEl]);

	useEffect(() => {
		if (!contentEl) {
			return;
		}

		const resizeObserver = new ResizeObserver(handleContentResize);
		resizeObserver.observe(contentEl);

		return () => {
			resizeObserver.disconnect();
		};
	}, [contentEl]);

	useEffect(() => {
		wasRunningRef.current = isRunning;

		if (!enable) {
			return;
		}

		const wasRunning = wasRunningRef.current;

		if (!wasRunning && isRunning) {
			if (!isAtBottomRef.current) {
				return;
			}

			scrollingToBottomBehaviorRef.current = "auto";
			requestAnimationFrame(() => {
				scrollToBottom("auto");
			});
		}

		if (wasRunning && !isRunning) {
			if (!isAtBottomRef.current) {
				return;
			}

			scrollToBottom("smooth");
		}
	}, [isRunning, enable]);

	useEffect(() => {
		if (!threadId || !enable) {
			return;
		}

		scrollingToBottomBehaviorRef.current = "instant";
		requestAnimationFrame(() => {
			scrollToBottom("instant");
		});
	}, [threadId, enable]);

	return {
		isAtBottom,
		scrollToBottom,
	} as const;
}
// #endregion auto scroll hook

// #region thread
type AiChatThread_ClassNames =
	| "AiChatThread"
	| "AiChatThread-content"
	| "AiChatThread-scroll-to-bottom"
	| "AiChatThread-scroll-to-bottom-icon"
	| "AiChatThread-composer";

type AiChatThread_Props = {
	controller: AiChatController;
};

function AiChatThread(props: AiChatThread_Props) {
	const { controller } = props;

	const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
	const selectedThreadId = controller.selectedThreadId;
	const initialComposerValue = controller.session?.draftComposerText ?? "";

	const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
	const [messagesListEl, setMessagesListEl] = useState<HTMLDivElement | null>(null);

	const { isAtBottom, scrollToBottom } = useAutoScroll({
		scrollEl: rootEl,
		contentEl: messagesListEl,
		controller,
		enable: controller.isRunning,
	});

	const handleScrollToBottom = () => {
		scrollToBottom("smooth");
	};

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

	const handleClickSuggestion: AiChatMessagesList_Props["onClickSuggestion"] = (action) => {
		if (!action.trim()) {
			return;
		}

		if (selectedThreadId) {
			controller.sendUserText(selectedThreadId, action);
		} else {
			controller.startNewChat(action);
		}
	};

	const handleMessageRegenerate: AiChatMessagesList_Props["onMessageRegenerate"] = (args) => {
		if (!selectedThreadId || args.threadId !== selectedThreadId) {
			return;
		}

		controller.regenerate(args.threadId, args.messageId);
	};

	const handleMessageBranchChat: AiChatMessagesList_Props["onMessageBranchChat"] = (args) => {
		if (!selectedThreadId || args.threadId !== selectedThreadId) {
			return;
		}

		controller.branchChat(args.threadId, args.messageId);
	};

	const handleEditStart: AiChatMessagesList_Props["onEditStart"] = (args) => {
		if (!selectedThreadId) {
			return;
		}
		if (controller.isRunning) {
			return;
		}
		controller.selectBranchAnchor(selectedThreadId, args.parentId);
		setEditingMessageId(args.messageId);
	};

	const handleEditCancel: AiChatMessagesList_Props["onEditCancel"] = () => {
		setEditingMessageId(null);
	};

	const handleEditSubmit: AiChatMessagesList_Props["onEditSubmit"] = (args) => {
		if (!selectedThreadId) {
			return;
		}
		const editingId = editingMessageId;
		if (!editingId) {
			return;
		}
		const value = args.value.trim();
		if (!value) {
			return;
		}

		controller.sendUserText(selectedThreadId, value, { messageId: editingId });
		setEditingMessageId(null);
	};

	const handleKeyDown: ComponentPropsWithRef<"div">["onKeyDown"] = (event) => {
		const activeElement = document.activeElement;

		if ((event.defaultPrevented && event.key !== "Escape") || !messagesListEl || !activeElement) {
			return;
		}

		// Implement keyboard navigation for user messages in the chat
		if (
			event.key === "ArrowUp" ||
			event.key === "ArrowDown" ||
			event.key === "Home" ||
			event.key === "End" ||
			event.key === "PageUp" ||
			event.key === "PageDown" ||
			event.key === "e" ||
			event.key === "Escape"
		) {
			const userMessageElements: HTMLElement[] = [];
			const userMessageIds: string[] = [];
			const typedAttributesAccessor = new dom_TypedAttributeAccessor<AiChatMessage_CustomAttributes>();
			for (const element of Array.from(
				messagesListEl.querySelectorAll<HTMLDivElement>(
					`.${"AiChatMessage" satisfies AiChatMessage_ClassNames}[${"data-ai-chat-message-id" satisfies keyof AiChatMessage_CustomAttributes}]`,
				),
			)) {
				const role = typedAttributesAccessor.get("data-ai-chat-message-role", element);
				const id = typedAttributesAccessor.get("data-ai-chat-message-id", element);
				if (!id || role !== "user") {
					continue;
				}
				userMessageIds.push(id);
				userMessageElements.push(element);
			}

			if (userMessageElements.length === 0) {
				return;
			}

			const isComposerInFocus = activeElement.classList.contains(
				"AiChatComposer-editor-content" satisfies AiChatComposer_ClassNames,
			);
			const isEditButtonInFocus = activeElement.classList.contains(
				"AiChatMessageUser-edit-button" satisfies AiChatMessageUser_ClassNames,
			);

			let elToFocus: HTMLElement | null | undefined = undefined;
			let preventScroll = false;
			let shouldScrollToBottom = false;

			do {
				if (isComposerInFocus) {
					if (event.key === "Escape" && editingMessageId) {
						setEditingMessageId(null);
						elToFocus = rootEl?.querySelector<HTMLElement>(
							`.${"AiChatThread-composer" satisfies AiChatThread_ClassNames} .${"AiChatComposer-editor-content" satisfies AiChatComposer_ClassNames}`,
						);
						preventScroll = true;
					} else if (event.key === "ArrowUp") {
						const shouldNavigateUp = use_app_global_store.getState().ai_chat_composer_selection_collapsed_and_at_start;
						if (!shouldNavigateUp) {
							break;
						}

						let targetMessageEl = userMessageElements.at(-1);
						if (editingMessageId) {
							const editingIndex = userMessageIds.indexOf(editingMessageId);
							if (editingIndex !== -1) {
								targetMessageEl = userMessageElements[Math.max(0, editingIndex - 1)];
							}
						}

						elToFocus = targetMessageEl
							? targetMessageEl.querySelector<HTMLElement>(
									`.${"AiChatMessageUser-edit-button" satisfies AiChatMessageUser_ClassNames}`,
								)
							: null;

						if (elToFocus) {
							setEditingMessageId(null);
						}
					} else if (event.key === "ArrowDown" && editingMessageId) {
						const shouldNavigateDown = use_app_global_store.getState().ai_chat_composer_selection_collapsed_and_at_end;
						if (!shouldNavigateDown) {
							break;
						}

						const editingIndex = userMessageIds.indexOf(editingMessageId);
						if (editingIndex === -1) {
							break;
						}

						if (editingIndex === userMessageElements.length - 1) {
							elToFocus = rootEl?.querySelector<HTMLElement>(
								`.${"AiChatThread-composer" satisfies AiChatThread_ClassNames} .${"AiChatComposer-editor-content" satisfies AiChatComposer_ClassNames}`,
							);
							preventScroll = true;
							break;
						}

						const nextMessageEl = userMessageElements[editingIndex + 1];
						if (!nextMessageEl) {
							break;
						}

						elToFocus = nextMessageEl.querySelector<HTMLElement>(
							`.${"AiChatMessageUser-edit-button" satisfies AiChatMessageUser_ClassNames}`,
						);

						if (elToFocus) {
							setEditingMessageId(null);
						}
					}
				} else if (isEditButtonInFocus) {
					const focusedMessageId = activeElement.getAttribute(
						"data-ai-chat-message-id" satisfies keyof AiChatMessage_CustomAttributes,
					);

					if (!focusedMessageId) {
						break;
					}

					if (event.key === "e" && !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)) {
						const focusedMessage = controller.activeBranchMessages.list.find(
							(message) => message.id === focusedMessageId,
						);
						if (!focusedMessage) {
							break;
						}

						event.preventDefault();
						handleEditStart({
							messageId: focusedMessage.id,
							parentId: ai_chat_get_parent_id(focusedMessage.metadata?.convexParentId),
						});
						break;
					}

					const index = userMessageIds.indexOf(focusedMessageId);

					let targetMessageEl: HTMLElement | null = null;
					if (event.key === "ArrowUp") {
						targetMessageEl = userMessageElements[index - 1] ?? null;
					} else if (event.key === "ArrowDown") {
						targetMessageEl = userMessageElements[index + 1] ?? null;
						if (!targetMessageEl) {
							elToFocus = event.currentTarget.querySelector<HTMLElement>(
								`.${"AiChatThread-composer" satisfies AiChatThread_ClassNames}
									.${"AiChatComposer-editor-content" satisfies AiChatComposer_ClassNames}`,
							);
							preventScroll = true;
							shouldScrollToBottom = true;
						}
					} else if (event.key === "Home") {
						targetMessageEl = userMessageElements.at(0) ?? null;
					} else if (event.key === "End") {
						targetMessageEl = userMessageElements.at(-1) ?? null;
					} else if (event.key === "PageUp") {
						const scrollEl = rootEl ?? (event.currentTarget instanceof Element ? event.currentTarget : messagesListEl);
						const targetElement =
							dom_find_first_element_overflowing_element(scrollEl, userMessageElements, "up") ??
							userMessageElements.at(0) ??
							null;
						targetMessageEl = targetElement instanceof HTMLElement ? targetElement : null;
					} else if (event.key === "PageDown") {
						const scrollEl = rootEl ?? (event.currentTarget instanceof Element ? event.currentTarget : messagesListEl);
						const targetElement =
							dom_find_first_element_overflowing_element(scrollEl, userMessageElements, "down") ??
							userMessageElements.at(-1) ??
							null;
						targetMessageEl = targetElement instanceof HTMLElement ? targetElement : null;
					}

					if (!elToFocus && targetMessageEl) {
						elToFocus = targetMessageEl.querySelector<HTMLElement>(
							`.${"AiChatMessageUser-edit-button" satisfies AiChatMessageUser_ClassNames}`,
						);
					}
				}
			} while (0);

			if (elToFocus) {
				event.preventDefault();
				elToFocus.focus({ preventScroll });
				if (shouldScrollToBottom) {
					scrollToBottom("instant");
				}
			}
		}
	};

	return (
		<div ref={setRootEl} className={"AiChatThread" satisfies AiChatThread_ClassNames} onKeyDown={handleKeyDown}>
			<div className={"AiChatThread-content" satisfies AiChatThread_ClassNames}>
				<AiChatMessagesList
					ref={setMessagesListEl}
					selectedThreadId={selectedThreadId}
					activeBranchMessages={controller.activeBranchMessages}
					messagesChildrenByParentId={controller.messagesChildrenByParentId}
					isRunning={controller.isRunning}
					editingMessageId={editingMessageId}
					onEditStart={handleEditStart}
					onEditCancel={handleEditCancel}
					onEditSubmit={handleEditSubmit}
					onToolOutput={controller.addToolOutput}
					onToolResumeStream={controller.resumeStream}
					onToolStop={controller.stop}
					onClickSuggestion={handleClickSuggestion}
					onMessageRegenerate={handleMessageRegenerate}
					onMessageBranchChat={handleMessageBranchChat}
					onSelectBranchAnchor={controller.selectBranchAnchor}
				/>
			</div>
			<div className={"AiChatThread-scroll-to-bottom" satisfies AiChatThread_ClassNames}>
				<MyIconButton variant="outline" tooltip="Scroll to bottom" onClick={handleScrollToBottom} hidden={isAtBottom}>
					<ArrowDown className={"AiChatThread-scroll-to-bottom-icon" satisfies AiChatThread_ClassNames} />
				</MyIconButton>
			</div>
			<div className={"AiChatThread-composer" satisfies AiChatThread_ClassNames}>
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
			<AiChatThreads
				state={aiChatSidebarOpen ? "expanded" : "closed"}
				paginatedThreads={controller.currentThreadsWithOptimistic}
				streamingTitleByThreadId={controller.streamingTitleByThreadId}
				selectedThreadId={controller.selectedThreadId}
				onClose={() => setAiChatSidebarOpen(false)}
				onSelectThread={controller.selectThread}
				onToggleFavouriteThread={controller.setThreadStarred}
				onBranchThread={controller.branchChat}
				onArchiveThread={controller.archiveThread}
				onNewChat={controller.startNewChat}
			/>

			{/* Main Content Area - takes remaining space */}
			<div className={"AiChat-main" satisfies AiChat_ClassNames}>
				<div className={"AiChat-thread-panel" satisfies AiChat_ClassNames}>
					{!aiChatSidebarOpen && (
						<div className={"AiChat-thread-controls" satisfies AiChat_ClassNames}>
							<MyIconButton
								variant="outline"
								tooltip="Open app sidebar"
								onClick={toggleSidebar}
								className={"AiChat-thread-control-button" satisfies AiChat_ClassNames}
							>
								<Menu className={"AiChat-thread-control-icon" satisfies AiChat_ClassNames} />
							</MyIconButton>

							<MyIconButton
								variant="outline"
								tooltip="Open chat threads"
								onClick={() => setAiChatSidebarOpen(true)}
								className={"AiChat-thread-control-button" satisfies AiChat_ClassNames}
							>
								<PanelLeft className={"AiChat-thread-control-icon" satisfies AiChat_ClassNames} />
							</MyIconButton>
						</div>
					)}
					<div className={"AiChat-thread-content" satisfies AiChat_ClassNames}>
						<AiChatThread controller={controller} />
					</div>
				</div>
			</div>
		</div>
	);
}

// #endregion root
