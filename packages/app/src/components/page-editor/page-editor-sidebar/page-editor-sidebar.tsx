import "./page-editor-sidebar.css";
import { memo, useEffect, useRef, useState, type MouseEvent, type Ref } from "react";
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
import { MyTabs, MyTabsList, MyTabsPanel, MyTabsPanels, MyTabsTab } from "@/components/my-tabs.tsx";
import { ai_chat_is_optimistic_thread, type AiChatController, useAiChatController } from "@/hooks/ai-chat-hooks.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { useAppLocalStorageState } from "@/lib/storage.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

// #region agent
type PageEditorSidebarAgentThreadPickerItem_ClassNames =
	| "PageEditorSidebarAgentThreadPicker-item"
	| "PageEditorSidebarAgentThreadPicker-item-title"
	| "PageEditorSidebarAgentThreadPicker-item-actions"
	| "PageEditorSidebarAgentThreadPicker-item-action";

type PageEditorSidebarAgentThreadPickerItem_CustomAttributes = {
	"data-page-editor-sidebar-agent-thread-picker-action": "";
};

type PageEditorSidebarAgentThreadPickerItem_Props = {
	value: string;
	title: string;
	isOptimistic: boolean;
	starred: boolean;
	archived: boolean;
	onStarredChange: (starred: boolean) => void;
	onArchiveChange: (archived: boolean) => void;
};

const PageEditorSidebarAgentThreadPickerItem = memo(function PageEditorSidebarAgentThreadPickerItem(
	props: PageEditorSidebarAgentThreadPickerItem_Props,
) {
	const { value, title, isOptimistic, starred, archived, onStarredChange, onArchiveChange } = props;
	const selectStore = MySearchSelect.useStore();

	const isActiveItem =
		MySearchSelect.useStoreState(selectStore, (state) => {
			if (!state?.activeId) {
				return false;
			}

			const activeItem = selectStore.item(state.activeId);
			return activeItem?.value === value;
		}) ?? false;

	const actionTabIndex = isActiveItem ? 0 : -1;

	const starButtonLabel = starred ? "Remove from favorites" : "Add to favorites";
	const archiveLabel = archived ? "Unarchive" : "Archive";

	const handleItemClickBehavior: NonNullable<MySearchSelectItem_Props["setValueOnClick"]> = (event) => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) {
			return true;
		}
		return !target.closest("[data-page-editor-sidebar-agent-thread-picker-action]");
	};

	const handleActionMouseDown = (event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	const handleToggleStar = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (isOptimistic) {
			return;
		}

		onStarredChange(!starred);
	};

	const handleToggleArchive = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		if (isOptimistic) {
			return;
		}

		onArchiveChange(!archived);
	};

	return (
		<MySearchSelectItem
			value={value}
			hideOnClick={handleItemClickBehavior}
			setValueOnClick={handleItemClickBehavior}
			className={cn(
				"PageEditorSidebarAgentThreadPicker-item" satisfies PageEditorSidebarAgentThreadPickerItem_ClassNames,
			)}
		>
			<span
				className={cn(
					"PageEditorSidebarAgentThreadPicker-item-title" satisfies PageEditorSidebarAgentThreadPickerItem_ClassNames,
				)}
			>
				{title}
			</span>
			{!isOptimistic ? (
				<div
					className={cn(
						"PageEditorSidebarAgentThreadPicker-item-actions" satisfies PageEditorSidebarAgentThreadPickerItem_ClassNames,
					)}
				>
					<MyIconButton
						{...({
							"data-page-editor-sidebar-agent-thread-picker-action": "",
						} satisfies Partial<PageEditorSidebarAgentThreadPickerItem_CustomAttributes>)}
						className={cn(
							"PageEditorSidebarAgentThreadPicker-item-action" satisfies PageEditorSidebarAgentThreadPickerItem_ClassNames,
						)}
						tabIndex={actionTabIndex}
						variant="ghost-highlightable"
						aria-pressed={starred}
						tooltip={starButtonLabel}
						onMouseDown={handleActionMouseDown}
						onClick={handleToggleStar}
					>
						<MyIconButtonIcon>
							<Star fill={starred ? "currentColor" : "none"} />
						</MyIconButtonIcon>
					</MyIconButton>
					<MyIconButton
						{...({
							"data-page-editor-sidebar-agent-thread-picker-action": "",
						} satisfies Partial<PageEditorSidebarAgentThreadPickerItem_CustomAttributes>)}
						className={cn(
							"PageEditorSidebarAgentThreadPicker-item-action" satisfies PageEditorSidebarAgentThreadPickerItem_ClassNames,
						)}
						tabIndex={actionTabIndex}
						variant="ghost-highlightable"
						tooltip={archiveLabel}
						onMouseDown={handleActionMouseDown}
						onClick={handleToggleArchive}
					>
						<MyIconButtonIcon>{archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}</MyIconButtonIcon>
					</MyIconButton>
				</div>
			) : null}
		</MySearchSelectItem>
	);
});

type PageEditorSidebarAgentThreadPickerList_ClassNames =
	| "PageEditorSidebarAgentThreadPickerList"
	| "PageEditorSidebarAgentThreadPickerList-empty"
	| "PageEditorSidebarAgentThreadPickerList-list";

type PageEditorSidebarAgentThreadPickerList_Props = {
	threads: AiChatController["currentThreadsWithOptimistic"]["unarchived"]["results"];
	threadTitleById: AiChatController["streamingTitleByThreadId"];
	onStarredChange: (args: { threadId: string; starred: boolean }) => void;
	onArchiveChange: (args: { threadId: string; archived: boolean }) => void;
};

const PageEditorSidebarAgentThreadPickerList = memo(function PageEditorSidebarAgentThreadPickerList(
	props: PageEditorSidebarAgentThreadPickerList_Props,
) {
	const { threads, threadTitleById, onStarredChange, onArchiveChange } = props;

	return (
		<div
			className={cn(
				"PageEditorSidebarAgentThreadPickerList" satisfies PageEditorSidebarAgentThreadPickerList_ClassNames,
			)}
		>
			{threads.length === 0 ? (
				<div
					className={cn(
						"PageEditorSidebarAgentThreadPickerList-empty" satisfies PageEditorSidebarAgentThreadPickerList_ClassNames,
					)}
				>
					No chats found
				</div>
			) : (
				<MySearchSelectList
					className={cn(
						"PageEditorSidebarAgentThreadPickerList-list" satisfies PageEditorSidebarAgentThreadPickerList_ClassNames,
					)}
				>
					{threads.map((thread) => {
						const isOptimisticThread = ai_chat_is_optimistic_thread(thread);
						const threadKey = isOptimisticThread ? (thread.clientGeneratedId ?? thread._id) : thread._id;
						const title = threadTitleById[thread._id] ?? (thread.title || "New Chat");

						return (
							<PageEditorSidebarAgentThreadPickerItem
								key={threadKey}
								value={thread._id}
								title={title}
								isOptimistic={isOptimisticThread}
								starred={thread.starred === true}
								archived={thread.archived === true}
								onStarredChange={(starred) => onStarredChange({ threadId: thread._id, starred })}
								onArchiveChange={(archived) => onArchiveChange({ threadId: thread._id, archived })}
							/>
						);
					})}
				</MySearchSelectList>
			)}
		</div>
	);
});

type PageEditorSidebarAgentThreadPicker_ClassNames =
	| "PageEditorSidebarAgentThreadPicker"
	| "PageEditorSidebarAgentThreadPicker-popover-content";

type PageEditorSidebarAgentThreadPicker_Props = {
	controller: AiChatController;
};

const PageEditorSidebarAgentThreadPicker = memo(function PageEditorSidebarAgentThreadPicker(
	props: PageEditorSidebarAgentThreadPicker_Props,
) {
	const { controller } = props;

	const threads = controller.currentThreadsWithOptimistic.unarchived.results;

	const handleSelectThread = useFn((threadId: string) => {
		controller.selectThread(threadId);
	});

	const handleSelectValue = useFn<MySearchSelect_Props["setValue"]>((value) => {
		if (!value) {
			return;
		}

		handleSelectThread(value);
	});

	const handleStarredChange = useFn((args: { threadId: string; starred: boolean }) => {
		controller.setThreadStarred(args.threadId, args.starred);
	});

	const handleArchiveChange = useFn((args: { threadId: string; archived: boolean }) => {
		controller.archiveThread(args.threadId, args.archived);
	});

	return (
		<div className={cn("PageEditorSidebarAgentThreadPicker" satisfies PageEditorSidebarAgentThreadPicker_ClassNames)}>
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
								"PageEditorSidebarAgentThreadPicker-popover-content" satisfies PageEditorSidebarAgentThreadPicker_ClassNames,
							)}
						>
							<MySearchSelectSearch placeholder="Search chats..." />
							<PageEditorSidebarAgentThreadPickerList
								threads={threads}
								threadTitleById={controller.streamingTitleByThreadId}
								onStarredChange={handleStarredChange}
								onArchiveChange={handleArchiveChange}
							/>
						</MySearchSelectPopoverContent>
					</MySearchSelectPopoverScrollableArea>
				</MySearchSelectPopover>
			</MySearchSelect>
		</div>
	);
});

type PageEditorSidebarAgent_ClassNames =
	| "PageEditorSidebarAgent"
	| "PageEditorSidebarAgent-header"
	| "PageEditorSidebarAgent-header-actions"
	| "PageEditorSidebarAgent-chat-area";

const PageEditorSidebarAgent = memo(function PageEditorSidebarAgent() {
	const controller = useAiChatController({ includeArchived: false });
	const hasAutoStartedRef = useRef(false);
	const [scrollableContainer, setScrollableContainer] = useState<HTMLElement | null>(null);

	const handleNewChat = () => {
		controller.startNewChat();
	};

	// Start a new chat if no chat is selected on mount
	useEffect(() => {
		if (!hasAutoStartedRef.current && !controller.selectedThreadId) {
			hasAutoStartedRef.current = true;
			controller.startNewChat();
		}
	}, []);

	return (
		<div className={cn("PageEditorSidebarAgent" satisfies PageEditorSidebarAgent_ClassNames)}>
			<div className={cn("PageEditorSidebarAgent-header" satisfies PageEditorSidebarAgent_ClassNames)}>
				<div className={cn("PageEditorSidebarAgent-header-actions" satisfies PageEditorSidebarAgent_ClassNames)}>
					<PageEditorSidebarAgentThreadPicker controller={controller} />
					<MyIconButton variant="ghost-highlightable" tooltip="New chat" onClick={handleNewChat}>
						<MyIcon>
							<Plus />
						</MyIcon>
					</MyIconButton>
				</div>
			</div>
			<div
				ref={setScrollableContainer}
				className={cn("PageEditorSidebarAgent-chat-area" satisfies PageEditorSidebarAgent_ClassNames)}
			>
				<AiChatThread variant="sidebar" controller={controller} scrollableContainer={scrollableContainer} />
			</div>
		</div>
	);
});
// #endregion agent

// #region root
export type PageEditorSidebar_ClassNames =
	| "PageEditorSidebar"
	| "PageEditorSidebar-toolbar"
	| "PageEditorSidebar-toolbar-scrollable-area"
	| "PageEditorSidebar-tabs-list"
	| "PageEditorSidebar-tabs-panels"
	| "PageEditorSidebar-panel"
	| "PageEditorSidebar-panel-empty"
	| "PageEditorSidebar-comments-host";

export type PageEditorSidebar_Props = {
	commentsContainerRef: Ref<HTMLDivElement>;
};

export const PageEditorSidebar = memo(function PageEditorSidebar(props: PageEditorSidebar_Props) {
	const { commentsContainerRef } = props;

	const pagesLastTab =
		useAppLocalStorageState((state) => state.pages_last_tab) ??
		("app_page_editor_sidebar_tabs_comments" satisfies AppElementId);
	const selectedTabId = pagesLastTab ?? ("app_page_editor_sidebar_tabs_comments" satisfies AppElementId);

	const handleTabChange = (nextSelectedId: string | null | undefined) => {
		if (!nextSelectedId || nextSelectedId === pagesLastTab) {
			return;
		}

		useAppLocalStorageState.setState({ pages_last_tab: nextSelectedId as AppElementId });
	};

	return (
		<>
			<MyTabs selectedId={selectedTabId} setSelectedId={handleTabChange}>
				<div className={cn("PageEditorSidebar-toolbar" satisfies PageEditorSidebar_ClassNames)}>
					<div className={cn("PageEditorSidebar-toolbar-scrollable-area" satisfies PageEditorSidebar_ClassNames)}>
						<MyTabsList
							className={cn("PageEditorSidebar-tabs-list" satisfies PageEditorSidebar_ClassNames)}
							aria-label="Sidebar tabs"
						>
							<MyTabsTab id={"app_page_editor_sidebar_tabs_comments" satisfies AppElementId}>Comments</MyTabsTab>
							<MyTabsTab id={"app_page_editor_sidebar_tabs_agent" satisfies AppElementId}>Agent</MyTabsTab>
						</MyTabsList>
					</div>
				</div>
				<MyTabsPanels className={cn("PageEditorSidebar-tabs-panels" satisfies PageEditorSidebar_ClassNames)}>
					<MyTabsPanel
						className={cn("PageEditorSidebar-panel" satisfies PageEditorSidebar_ClassNames)}
						tabId={"app_page_editor_sidebar_tabs_comments" satisfies AppElementId}
					>
						<div
							ref={commentsContainerRef}
							className={cn("PageEditorSidebar-comments-host" satisfies PageEditorSidebar_ClassNames)}
						></div>
					</MyTabsPanel>
					<MyTabsPanel
						className={cn("PageEditorSidebar-panel" satisfies PageEditorSidebar_ClassNames)}
						tabId={"app_page_editor_sidebar_tabs_agent" satisfies AppElementId}
					>
						<PageEditorSidebarAgent />
					</MyTabsPanel>
				</MyTabsPanels>
			</MyTabs>
		</>
	);
});
// #endregion root
