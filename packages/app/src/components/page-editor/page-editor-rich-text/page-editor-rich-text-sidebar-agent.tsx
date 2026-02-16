import "./page-editor-rich-text-sidebar-agent.css";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, Clock, Plus, Star } from "lucide-react";

import { AiChatThread } from "@/components/ai-chat/ai-chat.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import {
	MySearchSelect,
	MySearchSelectItem,
	MySearchSelectList,
	MySearchSelectPopover,
	MySearchSelectPopoverContent,
	MySearchSelectPopoverScrollableArea,
	MySearchSelectSearch,
	MySearchSelectTrigger,
	type MySearchSelectItem_Props,
	type MySearchSelect_Props,
} from "@/components/my-search-select.tsx";
import { ai_chat_is_optimistic_thread, type AiChatController, useAiChatController } from "@/hooks/ai-chat-hooks.tsx";
import { cn } from "@/lib/utils.ts";

// #region thread picker item
type PageEditorRichTextSidebarAgentThreadPickerItem_ClassNames =
	| "PageEditorRichTextSidebarAgentThreadPicker-item"
	| "PageEditorRichTextSidebarAgentThreadPicker-item-title"
	| "PageEditorRichTextSidebarAgentThreadPicker-item-actions"
	| "PageEditorRichTextSidebarAgentThreadPicker-item-action";

type PageEditorRichTextSidebarAgentThreadPickerItem_Props = {
	controller: AiChatController;
	thread: AiChatController["currentThreadsWithOptimistic"]["unarchived"]["results"][number];
};

function PageEditorRichTextSidebarAgentThreadPickerItem(props: PageEditorRichTextSidebarAgentThreadPickerItem_Props) {
	const { controller, thread } = props;
	const selectStore = MySearchSelect.useStore();

	const isActiveItem =
		MySearchSelect.useStoreState(selectStore, (state) => {
			if (!state?.activeId) {
				return false;
			}

			const activeItem = selectStore.item(state.activeId);
			return activeItem?.value === thread._id;
		}) ?? false;

	const actionTabIndex = isActiveItem ? 0 : -1;

	const threadTitle = controller.streamingTitleByThreadId[thread._id] ?? (thread.title || "New Chat");
	const isOptimisticThread = ai_chat_is_optimistic_thread(thread);
	const isStarred = thread.starred === true;
	const isArchived = thread.archived === true;
	const starButtonLabel = isStarred ? "Remove from favorites" : "Add to favorites";
	const archiveLabel = isArchived ? "Unarchive" : "Archive";

	const handleItemClickBehavior: NonNullable<MySearchSelectItem_Props["setValueOnClick"]> = (event) => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) {
			return true;
		}
		return !target.closest("[data-page-editor-rich-text-sidebar-agent-thread-picker-action]");
	};

	const handleActionMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const handleToggleStar = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (isOptimisticThread) {
			return;
		}

		controller.setThreadStarred(thread._id, !isStarred);
	};

	const handleToggleArchive = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (isOptimisticThread) {
			return;
		}

		controller.archiveThread(thread._id, !isArchived);
	};

	return (
		<MySearchSelectItem
			value={thread._id}
			hideOnClick={handleItemClickBehavior}
			setValueOnClick={handleItemClickBehavior}
			className={cn("PageEditorRichTextSidebarAgentThreadPicker-item" satisfies PageEditorRichTextSidebarAgentThreadPickerItem_ClassNames)}
		>
			<span
				className={cn(
					"PageEditorRichTextSidebarAgentThreadPicker-item-title" satisfies PageEditorRichTextSidebarAgentThreadPickerItem_ClassNames,
				)}
			>
				{threadTitle}
			</span>
			{!isOptimisticThread ? (
				<div
					className={cn(
						"PageEditorRichTextSidebarAgentThreadPicker-item-actions" satisfies PageEditorRichTextSidebarAgentThreadPickerItem_ClassNames,
					)}
				>
					<MyIconButton
						data-page-editor-rich-text-sidebar-agent-thread-picker-action
						className={cn(
							"PageEditorRichTextSidebarAgentThreadPicker-item-action" satisfies PageEditorRichTextSidebarAgentThreadPickerItem_ClassNames,
						)}
						tabIndex={actionTabIndex}
						variant="ghost-highlightable"
						aria-pressed={isStarred}
						tooltip={starButtonLabel}
						onMouseDown={handleActionMouseDown}
						onClick={handleToggleStar}
					>
						<MyIconButtonIcon>
							<Star fill={isStarred ? "currentColor" : "none"} />
						</MyIconButtonIcon>
					</MyIconButton>
					<MyIconButton
						data-page-editor-rich-text-sidebar-agent-thread-picker-action
						className={cn(
							"PageEditorRichTextSidebarAgentThreadPicker-item-action" satisfies PageEditorRichTextSidebarAgentThreadPickerItem_ClassNames,
						)}
						tabIndex={actionTabIndex}
						variant="ghost-highlightable"
						tooltip={archiveLabel}
						onMouseDown={handleActionMouseDown}
						onClick={handleToggleArchive}
					>
						<MyIconButtonIcon>{isArchived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}</MyIconButtonIcon>
					</MyIconButton>
				</div>
			) : null}
		</MySearchSelectItem>
	);
}
// #endregion thread picker item

// #region thread picker
type PageEditorRichTextSidebarAgentThreadPicker_ClassNames =
	| "PageEditorRichTextSidebarAgentThreadPicker"
	| "PageEditorRichTextSidebarAgentThreadPicker-popover-content"
	| "PageEditorRichTextSidebarAgentThreadPicker-item-empty";

type PageEditorRichTextSidebarAgentThreadPicker_Props = {
	controller: AiChatController;
};

function PageEditorRichTextSidebarAgentThreadPicker(props: PageEditorRichTextSidebarAgentThreadPicker_Props) {
	const { controller } = props;

	const threads = controller.currentThreadsWithOptimistic.unarchived.results;

	const handleSelectThread = (threadId: string) => {
		controller.selectThread(threadId);
	};

	const handleSelectValue: MySearchSelect_Props["setValue"] = (value) => {
		if (!value) {
			return;
		}

		handleSelectThread(value);
	};

	return (
		<div
			className={cn(
				"PageEditorRichTextSidebarAgentThreadPicker" satisfies PageEditorRichTextSidebarAgentThreadPicker_ClassNames,
			)}
		>
			<MySearchSelect value={controller.selectedThreadId ?? undefined} setValue={handleSelectValue}>
				<MySearchSelectTrigger>
					<MyIconButton variant="ghost-highlightable" tooltip="Past chats">
						<MyIcon>
							<Clock />
						</MyIcon>
					</MyIconButton>
				</MySearchSelectTrigger>
				<MySearchSelectPopover>
					<MySearchSelectPopoverScrollableArea>
						<MySearchSelectPopoverContent
							className={cn(
								"PageEditorRichTextSidebarAgentThreadPicker-popover-content" satisfies PageEditorRichTextSidebarAgentThreadPicker_ClassNames,
							)}
						>
							<MySearchSelectSearch placeholder="Search chats..." />
							{threads.length === 0 ? (
								<div
									className={cn(
										"PageEditorRichTextSidebarAgentThreadPicker-item-empty" satisfies PageEditorRichTextSidebarAgentThreadPicker_ClassNames,
									)}
								>
									No chats found
								</div>
							) : (
								<MySearchSelectList>
									{threads.map((thread) => {
										const isOptimisticThread = ai_chat_is_optimistic_thread(thread);
										const threadKey = isOptimisticThread
											? (thread.clientGeneratedId ?? thread._id)
											: thread._id;

										return (
											<PageEditorRichTextSidebarAgentThreadPickerItem
												key={threadKey}
												controller={controller}
												thread={thread}
											/>
										);
									})}
								</MySearchSelectList>
							)}
						</MySearchSelectPopoverContent>
					</MySearchSelectPopoverScrollableArea>
				</MySearchSelectPopover>
			</MySearchSelect>
		</div>
	);
}
// #endregion thread picker

// #region root
export type PageEditorRichTextSidebarAgent_ClassNames =
	| "PageEditorRichTextSidebarAgent"
	| "PageEditorRichTextSidebarAgent-header"
	| "PageEditorRichTextSidebarAgent-header-actions"
	| "PageEditorRichTextSidebarAgent-chat-area";

export function PageEditorRichTextSidebarAgent() {
	const controller = useAiChatController({ includeArchived: false });
	const hasAutoStartedRef = useRef(false);
	const [scrollableContainer, setScrollableContainer] = useState<HTMLElement | null>(null);

	const handleNewChat = () => {
		controller.startNewChat();
	};

	useEffect(() => {
		if (!hasAutoStartedRef.current && !controller.selectedThreadId) {
			hasAutoStartedRef.current = true;
			controller.startNewChat();
		}
	}, []);

	return (
		<div className={cn("PageEditorRichTextSidebarAgent" satisfies PageEditorRichTextSidebarAgent_ClassNames)}>
			<div className={cn("PageEditorRichTextSidebarAgent-header" satisfies PageEditorRichTextSidebarAgent_ClassNames)}>
				<div
					className={cn(
						"PageEditorRichTextSidebarAgent-header-actions" satisfies PageEditorRichTextSidebarAgent_ClassNames,
					)}
				>
					<PageEditorRichTextSidebarAgentThreadPicker controller={controller} />
					<MyIconButton variant="ghost-highlightable" tooltip="New chat" onClick={handleNewChat}>
						<MyIcon>
							<Plus />
						</MyIcon>
					</MyIconButton>
				</div>
			</div>
			<div
				ref={setScrollableContainer}
				className={cn("PageEditorRichTextSidebarAgent-chat-area" satisfies PageEditorRichTextSidebarAgent_ClassNames)}
			>
				<AiChatThread variant="sidebar" controller={controller} scrollableContainer={scrollableContainer} />
			</div>
		</div>
	);
}
// #endregion root
