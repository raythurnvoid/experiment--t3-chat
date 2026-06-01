import "./ai-chat.css";

import type { ComponentPropsWithRef, Ref } from "react";
import { memo, useState, useEffect, useRef, useDeferredValue, useLayoutEffect } from "react";
import { useFn, useLiveRef, useThrottle } from "@/hooks/utils-hooks.ts";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { ArrowDown, PanelLeft } from "lucide-react";

import { MyButton } from "@/components/my-button.tsx";
import { MainAppSidebarToggle } from "@/components/main-app-sidebar-toggle.tsx";
import { MyFloatingSurface } from "@/components/my-floating-surface.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { AiChatThreads } from "@/components/ai-chat/ai-chat-threads.tsx";
import { dom_find_first_element_overflowing_element, dom_TypedAttributeAccessor } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";
import { useUiStickToBottom } from "@/lib/ui.tsx";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import {
	useAiChatThreadRuntime,
	useAiChatThreadListController,
	useAiChatThreadEditingMessageId,
	type AiChatThreadRuntime,
	type AiChatRuntimeActions,
} from "@/hooks/ai-chat-hooks.tsx";
import {
	AiChatComposer,
	type AiChatComposer_ClassNames,
	type AiChatComposer_Props,
} from "@/components/ai-chat/ai-chat-composer.tsx";
import {
	AiChatMessage,
	type AiChatMessage_ClassNames,
	type AiChatMessage_CustomAttributes,
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

const AiChatWelcome = memo(function AiChatWelcome(props: AiChatWelcome_Props) {
	const { onClickSuggestion } = props;

	const handleClick = useFn<AiChatWelcome_Props["onClickSuggestion"]>((action) => {
		onClickSuggestion(action);
	});

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
						label: "find key points across files",
						action: "Search through my files and give me a summary of what's documented so far",
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
						onClick={() => handleClick(suggestion.action)}
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
});
// #endregion welcome

// #region skeleton
type AiChatSkeleton_ClassNames =
	| "AiChatSkeleton"
	| "AiChatSkeleton-row"
	| "AiChatSkeleton-row-align-end"
	| "AiChatSkeleton-bubble"
	| "AiChatSkeleton-bubble-user"
	| "AiChatSkeleton-bubble-agent"
	| "AiChatSkeleton-line"
	| "AiChatSkeleton-line-short"
	| "AiChatSkeleton-line-medium"
	| "AiChatSkeleton-line-long";

const AiChatSkeleton = memo(function AiChatSkeleton() {
	return (
		<div className={"AiChatSkeleton" satisfies AiChatSkeleton_ClassNames}>
			{/* User message skeleton */}
			<div
				className={cn(
					"AiChatSkeleton-row" satisfies AiChatSkeleton_ClassNames,
					"AiChatSkeleton-row-align-end" satisfies AiChatSkeleton_ClassNames,
				)}
			>
				<div
					className={cn(
						"AiChatSkeleton-bubble" satisfies AiChatSkeleton_ClassNames,
						"AiChatSkeleton-bubble-user" satisfies AiChatSkeleton_ClassNames,
					)}
				>
					<div
						className={cn(
							"AiChatSkeleton-line" satisfies AiChatSkeleton_ClassNames,
							"AiChatSkeleton-line-medium" satisfies AiChatSkeleton_ClassNames,
						)}
					/>
				</div>
			</div>
			{/* Agent message skeleton */}
			<div className={"AiChatSkeleton-row" satisfies AiChatSkeleton_ClassNames}>
				<div
					className={cn(
						"AiChatSkeleton-bubble" satisfies AiChatSkeleton_ClassNames,
						"AiChatSkeleton-bubble-agent" satisfies AiChatSkeleton_ClassNames,
					)}
				>
					<div
						className={cn(
							"AiChatSkeleton-line" satisfies AiChatSkeleton_ClassNames,
							"AiChatSkeleton-line-long" satisfies AiChatSkeleton_ClassNames,
						)}
					/>
					<div
						className={cn(
							"AiChatSkeleton-line" satisfies AiChatSkeleton_ClassNames,
							"AiChatSkeleton-line-long" satisfies AiChatSkeleton_ClassNames,
						)}
					/>
					<div
						className={cn(
							"AiChatSkeleton-line" satisfies AiChatSkeleton_ClassNames,
							"AiChatSkeleton-line-short" satisfies AiChatSkeleton_ClassNames,
						)}
					/>
				</div>
			</div>
		</div>
	);
});
// #endregion skeleton

// #region thread error
type AiChatThreadError_ClassNames = "AiChatThreadError" | "AiChatThreadError-bubble" | "AiChatThreadError-error";

type AiChatThreadError_Props = ErrorComponentProps & {
	message?: string;
};

const AiChatThreadError = memo(function AiChatThreadError(props: AiChatThreadError_Props) {
	const { message = "This chat cannot continue because it is in an invalid state." } = props;

	return (
		<div className={"AiChatThread-content" satisfies AiChatThread_ClassNames}>
			<div className={"AiChatThreadError" satisfies AiChatThreadError_ClassNames}>
				<div className={"AiChatThreadError-bubble" satisfies AiChatThreadError_ClassNames}>
					<div className={"AiChatThreadError-error" satisfies AiChatThreadError_ClassNames}>{message}</div>
				</div>
			</div>
		</div>
	);
});
// #endregion thread error

// #region message list
type AiChatMessagesList_ClassNames = "AiChatMessageList" | "AiChatMessageList-error";

type AiChatMessagesList_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;

	selectedThreadId: string | null;
	selectedModelId: AiChatThreadRuntime["selectedModelId"];
	selectedModeId: AiChatThreadRuntime["selectedModeId"];
	messages: AiChatThreadRuntime["activeBranchMessages"]["list"];
	status: AiChatThreadRuntime["status"];
	isRunning: AiChatThreadRuntime["isRunning"];
	streamErrorText: string | null;
	activeBranchAnchorId: string | null | undefined;
	actions: AiChatRuntimeActions;
	onClickSuggestion: (action: string) => void;
};

const AiChatMessagesList = memo(function AiChatMessagesList(props: AiChatMessagesList_Props) {
	const {
		ref,
		id,
		className,
		selectedThreadId,
		selectedModelId,
		selectedModeId,
		messages,
		status,
		isRunning,
		streamErrorText,
		activeBranchAnchorId,
		actions,
		onClickSuggestion,
		...rest
	} = props;

	const deferredMessages = useDeferredValue(messages);
	const throttledMessages = useThrottle(deferredMessages, 100);

	const messageCount = messages.length;

	// Make sure to always show the skeleton when switching between threads,
	// we cannot rely on `messageCount === 0` because we might have optimistic message,
	// stored that might prevent the skeleton from being shown.
	const shouldShowSkeleton = status === "loading" && !isRunning;

	const handleSuggestionClick = useFn<AiChatMessagesList_Props["onClickSuggestion"]>((action) => {
		onClickSuggestion(action);
	});

	return (
		<div
			// Ensure the list is unmounted when the thread or branch anchor is changed
			// or when the branch is switched
			key={`${selectedThreadId ?? "new"}:${activeBranchAnchorId ?? "root"}`}
			ref={ref}
			id={id}
			className={cn("AiChatMessageList" satisfies AiChatMessagesList_ClassNames, className)}
			{...rest}
		>
			{shouldShowSkeleton ? (
				<AiChatSkeleton />
			) : messageCount === 0 ? (
				<AiChatWelcome onClickSuggestion={handleSuggestionClick} />
			) : (
				throttledMessages.map((message, index) => {
					return (
						<AiChatMessage
							// index is better in this case because the messages follow a static order
							// and this will prevent them from being unmounted when the message is
							// persisted after stream
							key={index}
							messageId={message.id}
							message={message}
							selectedThreadId={selectedThreadId}
							selectedModelId={selectedModelId}
							selectedModeId={selectedModeId}
							actions={actions}
						/>
					);
				})
			)}
			{streamErrorText && (
				<div className={"AiChatMessageList-error" satisfies AiChatMessagesList_ClassNames}>{streamErrorText}</div>
			)}
		</div>
	);
});
// #endregion message list

// #region auto scroll hook
const AUTO_SCROLL_BOTTOM_MARGIN = 1;

type useAutoScroll_Props = {
	scrollEl: HTMLElement | null;
	contentEl: HTMLDivElement | null;
	controller: AiChatThreadRuntime;
	enable?: boolean;
};

function useAutoScroll(props: useAutoScroll_Props) {
	const { scrollEl, contentEl, controller, enable = true } = props;

	const isRunning = controller.isRunning;
	const threadId = controller.selectedThreadId;

	const { isAtBottom, scrollToBottom } = useUiStickToBottom({
		scrollEl,
		contentEl,
		bottomMargin: AUTO_SCROLL_BOTTOM_MARGIN,
		enable,
	});

	const isAtBottomRef = useRef(isAtBottom);
	const wasRunningRef = useRef(isRunning);

	useEffect(() => {
		isAtBottomRef.current = isAtBottom;
	}, [isAtBottom]);

	useEffect(() => {
		const wasRunning = wasRunningRef.current;
		wasRunningRef.current = isRunning;
		const justStopped = wasRunning && !isRunning;
		const justStarted = !wasRunning && isRunning;

		if (!enable) {
			return;
		}

		if (justStarted) {
			if (!isAtBottomRef.current) {
				return;
			}

			requestAnimationFrame(() => {
				scrollToBottom("auto");
			});
		}

		if (justStopped) {
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
export type AiChatThread_Variant = "default" | "sidebar";

export type AiChatThread_ClassNames =
	| "AiChatThread"
	| "AiChatThread-variant-default"
	| "AiChatThread-variant-sidebar"
	| "AiChatThread-content"
	| "AiChatThread-scroll-to-bottom"
	| "AiChatThread-scroll-to-bottom-card"
	| "AiChatThread-scroll-to-bottom-icon"
	| "AiChatThread-composer";

export type AiChatThread_Props = {
	variant?: AiChatThread_Variant;
	controller: AiChatThreadRuntime;
	scrollableContainer: HTMLElement | null;
};

export type AiChatThread_CustomAttributes = {
	"data-thread-id": string;
};

export const AiChatThread = memo(function AiChatThread(props: AiChatThread_Props) {
	const { variant = "default", controller, scrollableContainer } = props;

	const selectedThreadId = controller.selectedThreadId;
	const selectedModelId = controller.selectedModelId;
	const selectedModeId = controller.selectedModeId;
	const editingMessageId = useAiChatThreadEditingMessageId(selectedThreadId);
	const initialComposerValue = controller.session?.draftComposerText ?? "";
	const controllerRef = useLiveRef(controller);

	useLayoutEffect(() => {
		controller.syncRenderState();
	});

	const [runtimeActions] = useState<AiChatRuntimeActions>(() => {
		const isThreadRunning = (threadId: string) => {
			const controller = controllerRef.current;
			return controller.selectedThreadId === threadId && controller.isRunning;
		};

		return {
			addToolOutput: ((...args: Parameters<AiChatRuntimeActions["addToolOutput"]>) =>
				controllerRef.current.addToolOutput(...args)) as AiChatRuntimeActions["addToolOutput"],
			resumeStream: ((...args: Parameters<AiChatRuntimeActions["resumeStream"]>) =>
				controllerRef.current.resumeStream(...args)) as AiChatRuntimeActions["resumeStream"],
			stop: () => {
				controllerRef.current.stop();
			},
			setSelectedModelId: (modelId) => {
				controllerRef.current.setSelectedModelId(modelId);
			},
			setSelectedModeId: (modeId) => {
				controllerRef.current.setSelectedModeId(modeId);
			},
			sendUserText: (threadId, value, options) => {
				if (isThreadRunning(threadId)) {
					return;
				}
				controllerRef.current.sendUserText(threadId, value, options);
			},
			regenerate: (threadId, messageId) => {
				if (isThreadRunning(threadId)) {
					return;
				}
				controllerRef.current.regenerate(threadId, messageId);
			},
			branchChat: (threadId, messageId) => {
				if (isThreadRunning(threadId)) {
					return;
				}
				controllerRef.current.branchChat(threadId, messageId);
			},
			selectBranchAnchor: (threadId, anchorId) => {
				if (isThreadRunning(threadId)) {
					return;
				}
				controllerRef.current.selectBranchAnchor(threadId, anchorId);
			},
			setEditingMessageId: (threadId, messageId) => {
				if (messageId && isThreadRunning(threadId)) {
					return;
				}
				controllerRef.current.setEditingMessageId(threadId, messageId);
			},
		};
	});

	const [messagesListEl, setMessagesListEl] = useState<HTMLDivElement | null>(null);

	const { isAtBottom, scrollToBottom } = useAutoScroll({
		scrollEl: scrollableContainer,
		contentEl: messagesListEl,
		controller,
	});

	const handleScrollToBottom = useFn(() => {
		scrollToBottom("smooth");
	});

	const handleComposerValueChange = useFn<AiChatComposer_Props["onValueChange"]>((value) => {
		if (!selectedThreadId) {
			return;
		}
		controller.setComposerValue(selectedThreadId, value);
	});

	const handleSelectedModelIdChange = useFn<AiChatComposer_Props["onSelectedModelIdChange"]>((value) => {
		controller.setSelectedModelId(value);
	});

	const handleSelectedModeIdChange = useFn<AiChatComposer_Props["onSelectedModeIdChange"]>((value) => {
		controller.setSelectedModeId(value);
	});

	const handleComposerSubmit = useFn<AiChatComposer_Props["onSubmit"]>((value) => {
		if (!value.trim()) {
			return;
		}

		if (selectedThreadId) {
			controller.sendUserText(selectedThreadId, value);
		} else {
			controller.startNewChat(value);
		}
	});

	const handleComposerCancel = useFn<AiChatComposer_Props["onCancel"]>(() => {
		controller.stop();
	});

	const handleClickSuggestion = useFn<AiChatMessagesList_Props["onClickSuggestion"]>((action) => {
		if (!action.trim()) {
			return;
		}

		if (selectedThreadId) {
			controller.sendUserText(selectedThreadId, action);
		} else {
			controller.startNewChat(action);
		}
	});

	const handleEditStart = useFn((args: { messageId: string; parentId: string | null }) => {
		if (!selectedThreadId) {
			return;
		}
		if (controller.isRunning) {
			return;
		}
		controller.selectBranchAnchor(selectedThreadId, args.parentId);
		controller.setEditingMessageId(selectedThreadId, args.messageId);
	});

	const handleKeyDown = useFn<ComponentPropsWithRef<"div">["onKeyDown"]>((event) => {
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
			event.key === "FileUp" ||
			event.key === "FileDown" ||
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
						if (selectedThreadId) {
							controller.setEditingMessageId(selectedThreadId, null);
						}
						elToFocus = event.currentTarget.querySelector<HTMLElement>(
							`.${"AiChatThread-composer" satisfies AiChatThread_ClassNames} .${"AiChatComposer-editor-content" satisfies AiChatComposer_ClassNames}`,
						);
						preventScroll = true;
					} else if (event.key === "ArrowUp") {
						const shouldNavigateUp = useAppGlobalStore.getState().ai_chat_composer_selection_collapsed_and_at_start;
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
							if (selectedThreadId) {
								controller.setEditingMessageId(selectedThreadId, null);
							}
						}
					} else if (event.key === "ArrowDown" && editingMessageId) {
						const shouldNavigateDown = useAppGlobalStore.getState().ai_chat_composer_selection_collapsed_and_at_end;
						if (!shouldNavigateDown) {
							break;
						}

						const editingIndex = userMessageIds.indexOf(editingMessageId);
						if (editingIndex === -1) {
							break;
						}

						if (editingIndex === userMessageElements.length - 1) {
							elToFocus = event.currentTarget.querySelector<HTMLElement>(
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
							if (selectedThreadId) {
								controller.setEditingMessageId(selectedThreadId, null);
							}
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
							parentId: focusedMessage.metadata?.convexParentId ?? null,
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
					} else if (event.key === "FileUp") {
						const scrollEl = scrollableContainer;
						if (!scrollEl) {
							break;
						}
						const targetElement =
							dom_find_first_element_overflowing_element(scrollEl, userMessageElements, "up") ??
							userMessageElements.at(0) ??
							null;
						targetMessageEl = targetElement instanceof HTMLElement ? targetElement : null;
					} else if (event.key === "FileDown") {
						const scrollEl = scrollableContainer;
						if (!scrollEl) {
							break;
						}
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
	});

	const handleCatchBoundaryError = useFn((error: Error) => {
		console.error("[AiChatThread.handleCatchBoundaryError] Chat render failed", {
			error,
			selectedThreadId,
			anchorId: controller.activeBranchMessages.anchorId ?? null,
		});
	});

	const getCatchBoundaryResetKey = () => {
		return `${selectedThreadId ?? "new"}:${controller.activeBranchMessages.anchorId ?? "root"}`;
	};

	return (
		<div
			className={cn(
				"AiChatThread" satisfies AiChatThread_ClassNames,
				variant === "default" && ("AiChatThread-variant-default" satisfies AiChatThread_ClassNames),
				variant === "sidebar" && ("AiChatThread-variant-sidebar" satisfies AiChatThread_ClassNames),
			)}
			{...((selectedThreadId
				? { "data-thread-id": selectedThreadId }
				: {}) satisfies Partial<AiChatThread_CustomAttributes>)}
			onKeyDown={handleKeyDown}
		>
			<CatchBoundary
				getResetKey={getCatchBoundaryResetKey}
				errorComponent={AiChatThreadError}
				onCatch={handleCatchBoundaryError}
			>
				<div className={"AiChatThread-content" satisfies AiChatThread_ClassNames}>
					<AiChatMessagesList
						ref={setMessagesListEl}
						selectedThreadId={selectedThreadId}
						selectedModelId={selectedModelId}
						selectedModeId={selectedModeId}
						messages={controller.activeBranchMessages.list}
						status={controller.status}
						isRunning={controller.isRunning}
						streamErrorText={controller.error ? "An error occurred during the generation" : null}
						activeBranchAnchorId={controller.activeBranchMessages.anchorId}
						actions={runtimeActions}
						onClickSuggestion={handleClickSuggestion}
					/>
				</div>
				<div className={"AiChatThread-scroll-to-bottom" satisfies AiChatThread_ClassNames}>
					<MyFloatingSurface
						className={"AiChatThread-scroll-to-bottom-card" satisfies AiChatThread_ClassNames}
						hidden={isAtBottom}
					>
						<MyIconButton variant="floating" tooltip="Scroll to bottom" onClick={handleScrollToBottom}>
							<ArrowDown className={"AiChatThread-scroll-to-bottom-icon" satisfies AiChatThread_ClassNames} />
						</MyIconButton>
					</MyFloatingSurface>
				</div>
				<div className={"AiChatThread-composer" satisfies AiChatThread_ClassNames}>
					<AiChatComposer
						key={selectedThreadId ?? "new"}
						canCancel={controller.isRunning}
						canSend={!selectedThreadId || controller.canSendUserText}
						isRunning={controller.isRunning}
						initialValue={initialComposerValue}
						selectedModelId={selectedModelId}
						selectedModeId={selectedModeId}
						onValueChange={handleComposerValueChange}
						onSelectedModelIdChange={handleSelectedModelIdChange}
						onSelectedModeIdChange={handleSelectedModeIdChange}
						onSubmit={handleComposerSubmit}
						onCancel={handleComposerCancel}
					/>
				</div>
			</CatchBoundary>
		</div>
	);
});
// #endregion thread

// #region root
const AiChatThreadRuntimePanel = memo(function AiChatThreadRuntimePanel(props: {
	scrollableContainer: HTMLElement | null;
}) {
	const { scrollableContainer } = props;
	const controller = useAiChatThreadRuntime();

	return <AiChatThread controller={controller} scrollableContainer={scrollableContainer} />;
});

type AiChat_ClassNames =
	| "AiChat"
	| "AiChat-main"
	| "AiChat-thread-panel"
	| "AiChat-thread-controls"
	| "AiChat-thread-control-button"
	| "AiChat-thread-control-icon"
	| "AiChat-thread-content";

type AiChat_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
};

export const AiChat = memo(function AiChat(props: AiChat_Props) {
	const { ref, id, className, ...rest } = props;

	const { membershipId } = AppTenantProvider.useContext();
	const controller = useAiChatThreadListController();
	const controllerRef = useLiveRef(controller);
	const [lastOpenThreadId] = useAppLocalStorageStateValue(
		`app_state::ai_chat_last_open::scope::${membershipId}`,
	);
	const [aiChatSidebarOpen, setAiChatSidebarOpen] = useState(true);
	const [scrollableContainer, setScrollableContainer] = useState<HTMLElement | null>(null);

	const handleCloseSidebar = useFn(() => {
		setAiChatSidebarOpen(false);
	});

	const handleOpenSidebar = useFn(() => {
		setAiChatSidebarOpen(true);
	});

	useEffect(() => {
		const controller = controllerRef.current;

		// Keep route-level restoration here. The file editor sidebar has its own
		// open-tab storage, so the shared list controller should not decide which
		// chat surface wins on mount.
		if (controller.session?.optimisticThread) {
			return;
		}

		if (!lastOpenThreadId) {
			if (controller.selectedThreadId) {
				controller.clearSelectedThread();
			}
			return;
		}

		if (controller.selectedThreadId === lastOpenThreadId) {
			return;
		}

		controller.selectThread(lastOpenThreadId);
	}, [controller.selectedThreadId, controller.session?.optimisticThread, controllerRef, lastOpenThreadId]);

	return (
		<div ref={ref} id={id} className={cn("AiChat" satisfies AiChat_ClassNames, className)} {...rest}>
			<AiChatThreads
				state={aiChatSidebarOpen ? "expanded" : "closed"}
				paginatedThreads={controller.currentThreadsWithOptimistic}
				streamingTitleByThreadId={controller.streamingTitleByThreadId}
				selectedThreadId={controller.selectedThreadId}
				onClose={handleCloseSidebar}
				onSelectThread={controller.selectThread}
				onToggleFavouriteThread={controller.setThreadStarred}
				onBranchThread={controller.branchChat}
				onArchiveThread={controller.archiveThread}
				onRemoveOptimisticThread={controller.removeOptimisticThread}
				onNewChat={controller.startNewChat}
			/>

			{/* Main Content Area - takes remaining space */}
			<div className={"AiChat-main" satisfies AiChat_ClassNames}>
				<div className={"AiChat-thread-panel" satisfies AiChat_ClassNames}>
					{!aiChatSidebarOpen && (
						<div className={"AiChat-thread-controls" satisfies AiChat_ClassNames}>
							<MainAppSidebarToggle
								variant="ghost-highlightable"
								tooltip="Open app sidebar"
								className={"AiChat-thread-control-button" satisfies AiChat_ClassNames}
							/>

							<MyIconButton
								variant="ghost-highlightable"
								tooltip="Open chat threads"
								onClick={handleOpenSidebar}
								className={"AiChat-thread-control-button" satisfies AiChat_ClassNames}
							>
								<PanelLeft className={"AiChat-thread-control-icon" satisfies AiChat_ClassNames} />
							</MyIconButton>
						</div>
					)}
					<div ref={setScrollableContainer} className={"AiChat-thread-content" satisfies AiChat_ClassNames}>
						<AiChatThreadRuntimePanel scrollableContainer={scrollableContainer} />
					</div>
				</div>
			</div>
		</div>
	);
});

// #endregion root
