import "./file-editor-sidebar-agent.css";
import { memo, useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { ArchiveIcon, ArchiveRestoreIcon, Clock, GripVertical, Plus, Star, X } from "lucide-react";
import { AiChatThread } from "@/components/ai-chat/ai-chat.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import type { MyButton_ClassNames } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon, type MyIconButton_ClassNames } from "@/components/my-icon-button.tsx";
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
import {
	MyTabs,
	MyTabsList,
	MyTabsPanel,
	MyTabsPanels,
	MyTabsTabPrimaryAction,
	MyTabsTabSecondaryAction,
	MyTabsTabSecondaryActionIcon,
	type MyTabsTabSecondaryAction_ClassNames,
	MyTabsTabSurface,
} from "@/components/my-tabs.tsx";
import {
	AiChatController,
	type AiChatControllerStorageKey,
	type AiChatOptimisticThreadId,
	type AiChatThreadListController,
} from "@/hooks/ai-chat-controller.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { ai_chat_is_optimistic_thread } from "@/lib/ai-chat.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_local_storage_set_value,
	type storage_local_ValueByKey,
	useAppLocalStorageValue,
} from "@/lib/storage.ts";
import { cn, type GeneratedIdPrefix } from "@/lib/utils.ts";

const DROPPABLE_ID = "file_editor_sidebar_agent_tabs";
const NEW_CHAT_TAB_ID = "__file_editor_sidebar_agent_new_chat__";

function get_tab_title(args: {
	threadId: string;
	currentThreads: AiChatThreadListController["currentThreadsWithOptimistic"]["unarchived"]["results"];
	streamingTitleByThreadId: AiChatThreadListController["streamingTitleByThreadId"];
	fallbackTitle?: string;
}) {
	const { threadId, currentThreads, streamingTitleByThreadId, fallbackTitle = "New chat" } = args;
	const streamedTitle = streamingTitleByThreadId[threadId];
	if (streamedTitle) {
		return streamedTitle;
	}

	const thread = currentThreads.find((currentThread) => currentThread._id === threadId);
	if (thread?.title) {
		return thread.title;
	}

	return fallbackTitle;
}

// #region thread picker item
type FileEditorSidebarAgentThreadPickerItem_ClassNames =
	| "FileEditorSidebarAgentThreadPicker-item"
	| "FileEditorSidebarAgentThreadPicker-item-title"
	| "FileEditorSidebarAgentThreadPicker-item-actions"
	| "FileEditorSidebarAgentThreadPicker-item-action";

type FileEditorSidebarAgentThreadPickerItem_CustomAttributes = {
	"data-file-editor-sidebar-agent-thread-picker-action": "";
};

type FileEditorSidebarAgentThreadPickerItem_Props = {
	value: string;
	title: string;
	isOptimistic: boolean;
	starred: boolean;
	archived: boolean;
	onStarredChange: (starred: boolean) => void;
	onArchiveChange: (archived: boolean) => void;
};

const FileEditorSidebarAgentThreadPickerItem = memo(function FileEditorSidebarAgentThreadPickerItem(
	props: FileEditorSidebarAgentThreadPickerItem_Props,
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
		return !target.closest("[data-file-editor-sidebar-agent-thread-picker-action]");
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
				"FileEditorSidebarAgentThreadPicker-item" satisfies FileEditorSidebarAgentThreadPickerItem_ClassNames,
			)}
		>
			<span
				className={cn(
					"FileEditorSidebarAgentThreadPicker-item-title" satisfies FileEditorSidebarAgentThreadPickerItem_ClassNames,
				)}
			>
				{title}
			</span>
			{!isOptimistic ? (
				<div
					className={cn(
						"FileEditorSidebarAgentThreadPicker-item-actions" satisfies FileEditorSidebarAgentThreadPickerItem_ClassNames,
					)}
				>
					<MyIconButton
						{...({
							"data-file-editor-sidebar-agent-thread-picker-action": "",
						} satisfies Partial<FileEditorSidebarAgentThreadPickerItem_CustomAttributes>)}
						className={cn(
							"FileEditorSidebarAgentThreadPicker-item-action" satisfies FileEditorSidebarAgentThreadPickerItem_ClassNames,
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
							"data-file-editor-sidebar-agent-thread-picker-action": "",
						} satisfies Partial<FileEditorSidebarAgentThreadPickerItem_CustomAttributes>)}
						className={cn(
							"FileEditorSidebarAgentThreadPicker-item-action" satisfies FileEditorSidebarAgentThreadPickerItem_ClassNames,
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
// #endregion thread picker item

// #region thread picker list
type FileEditorSidebarAgentThreadPickerList_ClassNames =
	| "FileEditorSidebarAgentThreadPickerList"
	| "FileEditorSidebarAgentThreadPickerList-empty"
	| "FileEditorSidebarAgentThreadPickerList-list";

type FileEditorSidebarAgentThreadPickerList_Props = {
	threads: AiChatThreadListController["currentThreadsWithOptimistic"]["unarchived"]["results"];
	threadTitleById: AiChatThreadListController["streamingTitleByThreadId"];
	onStarredChange: (args: { threadId: string; starred: boolean }) => void;
	onArchiveChange: (args: { threadId: string; archived: boolean }) => void;
};

const FileEditorSidebarAgentThreadPickerList = memo(function FileEditorSidebarAgentThreadPickerList(
	props: FileEditorSidebarAgentThreadPickerList_Props,
) {
	const { threads, threadTitleById, onStarredChange, onArchiveChange } = props;

	return (
		<div
			className={cn(
				"FileEditorSidebarAgentThreadPickerList" satisfies FileEditorSidebarAgentThreadPickerList_ClassNames,
			)}
		>
			{threads.length === 0 ? (
				<div
					className={cn(
						"FileEditorSidebarAgentThreadPickerList-empty" satisfies FileEditorSidebarAgentThreadPickerList_ClassNames,
					)}
				>
					No chats found
				</div>
			) : (
				<MySearchSelectList
					className={cn(
						"FileEditorSidebarAgentThreadPickerList-list" satisfies FileEditorSidebarAgentThreadPickerList_ClassNames,
					)}
				>
					{threads.map((thread) => {
						const isOptimisticThread = ai_chat_is_optimistic_thread(thread);
						const threadKey = isOptimisticThread ? (thread.clientGeneratedId ?? thread._id) : thread._id;
						const title = threadTitleById[thread._id] ?? (thread.title || "New Chat");

						return (
							<FileEditorSidebarAgentThreadPickerItem
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
// #endregion thread picker list

// #region thread picker
type FileEditorSidebarAgentThreadPicker_ClassNames =
	| "FileEditorSidebarAgentThreadPicker"
	| "FileEditorSidebarAgentThreadPicker-popover-content";

type FileEditorSidebarAgentThreadPicker_Props = {
	controller: AiChatThreadListController;
	/** Called before selectThread when user picks a thread (e.g. to add to open tabs and set selected tab). */
	onBeforeSelectThread?: (threadId: string) => void;
};

const FileEditorSidebarAgentThreadPicker = memo(function FileEditorSidebarAgentThreadPicker(
	props: FileEditorSidebarAgentThreadPicker_Props,
) {
	const { controller, onBeforeSelectThread } = props;

	const threads = controller.currentThreadsWithOptimistic.unarchived.results;

	const handleSelectValue = useFn<MySearchSelect_Props["setValue"]>((value) => {
		if (!value) {
			return;
		}

		onBeforeSelectThread?.(value);
		controller.selectThread(value);
	});

	const handleStarredChange = useFn((args: { threadId: string; starred: boolean }) => {
		controller.setThreadStarred(args.threadId, args.starred);
	});

	const handleArchiveChange = useFn((args: { threadId: string; archived: boolean }) => {
		controller.archiveThread(args.threadId, args.archived);
	});

	return (
		<div className={cn("FileEditorSidebarAgentThreadPicker" satisfies FileEditorSidebarAgentThreadPicker_ClassNames)}>
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
								"FileEditorSidebarAgentThreadPicker-popover-content" satisfies FileEditorSidebarAgentThreadPicker_ClassNames,
							)}
						>
							<MySearchSelectSearch placeholder="Search chats..." />
							<FileEditorSidebarAgentThreadPickerList
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
// #endregion thread picker

// #region header
type FileEditorSidebarAgentHeader_ClassNames = "FileEditorSidebarAgentHeader";

type FileEditorSidebarAgentHeader_Props = {
	controller: AiChatThreadListController;
	openTabs: storage_local_ValueByKey[`app_state::file_editor_sidebar_open_tabs::scope::${string}`];
	membershipId: string;
	selectedChatTabId: string;
	currentThreads: AiChatThreadListController["currentThreadsWithOptimistic"]["unarchived"]["results"];
	appHoistingContainer: HTMLElement | null;
	onOptimisticThreadCreated: (threadId: AiChatOptimisticThreadId) => void;
};

const FileEditorSidebarAgentHeader = memo(function FileEditorSidebarAgentHeader(
	props: FileEditorSidebarAgentHeader_Props,
) {
	const {
		controller,
		openTabs,
		membershipId,
		selectedChatTabId,
		currentThreads,
		appHoistingContainer,
		onOptimisticThreadCreated,
	} = props;

	return (
		<div className={cn("FileEditorSidebarAgentHeader" satisfies FileEditorSidebarAgentHeader_ClassNames)}>
			<FileEditorSidebarAgentHeaderTabs
				controller={controller}
				openTabs={openTabs}
				membershipId={membershipId}
				selectedChatTabId={selectedChatTabId}
				currentThreads={currentThreads}
				appHoistingContainer={appHoistingContainer}
			/>
			<FileEditorSidebarAgentHeaderActions
				controller={controller}
				openTabs={openTabs}
				membershipId={membershipId}
				currentThreads={currentThreads}
				onOptimisticThreadCreated={onOptimisticThreadCreated}
			/>
		</div>
	);
});
// #endregion header

// #region header actions
type FileEditorSidebarAgentHeaderActions_ClassNames = "FileEditorSidebarAgentHeaderActions";

type FileEditorSidebarAgentHeaderActions_Props = {
	controller: AiChatThreadListController;
	openTabs: storage_local_ValueByKey[`app_state::file_editor_sidebar_open_tabs::scope::${string}`];
	membershipId: string;
	currentThreads: AiChatThreadListController["currentThreadsWithOptimistic"]["unarchived"]["results"];
	onOptimisticThreadCreated: (threadId: AiChatOptimisticThreadId) => void;
};

const FileEditorSidebarAgentHeaderActions = memo(function FileEditorSidebarAgentHeaderActions(
	props: FileEditorSidebarAgentHeaderActions_Props,
) {
	const { controller, openTabs, membershipId, currentThreads, onOptimisticThreadCreated } = props;
	const selectedTabStorageKey: `app_state::file_editor_sidebar_agent_selected_tab::scope::${string}` = `app_state::file_editor_sidebar_agent_selected_tab::scope::${membershipId}`;
	const openTabsStorageKey: `app_state::file_editor_sidebar_open_tabs::scope::${string}` = `app_state::file_editor_sidebar_open_tabs::scope::${membershipId}`;

	const handleBeforeSelectThread = useFn((threadId: string) => {
		const inOpenTabs = openTabs.some((t) => t.id === threadId);
		const title = get_tab_title({
			threadId,
			currentThreads,
			streamingTitleByThreadId: controller.streamingTitleByThreadId,
		});
		app_local_storage_set_value(selectedTabStorageKey, threadId);
		if (!inOpenTabs) {
			app_local_storage_set_value(openTabsStorageKey, (previousTabs) => [...previousTabs, { id: threadId, title }]);
		}
	});

	const handleNewChat = () => {
		const threadId = controller.startNewChat();
		onOptimisticThreadCreated(threadId);
		app_local_storage_set_value(selectedTabStorageKey, threadId);
		app_local_storage_set_value(openTabsStorageKey, (previousTabs) => {
			if (previousTabs.some((tab) => tab.id === threadId)) {
				return previousTabs;
			}

			return [...previousTabs, { id: threadId, title: "New chat" }];
		});
	};

	return (
		<div className={cn("FileEditorSidebarAgentHeaderActions" satisfies FileEditorSidebarAgentHeaderActions_ClassNames)}>
			<FileEditorSidebarAgentThreadPicker controller={controller} onBeforeSelectThread={handleBeforeSelectThread} />
			<MyIconButton variant="ghost-highlightable" tooltip="New chat" onClick={handleNewChat}>
				<MyIcon>
					<Plus />
				</MyIcon>
			</MyIconButton>
		</div>
	);
});
// #endregion header actions

// #region header tabs
type FileEditorSidebarAgentHeaderTabs_ClassNames =
	| "FileEditorSidebarAgentHeaderTabs"
	| "FileEditorSidebarAgentHeaderTabs-tabs-draggable"
	| "FileEditorSidebarAgentHeaderTabs-tab"
	| "FileEditorSidebarAgentHeaderTabs-tab-handle"
	| "FileEditorSidebarAgentHeaderTabs-tab-primary-action"
	| "FileEditorSidebarAgentHeaderTabs-tab-title"
	| "FileEditorSidebarAgentHeaderTabs-tab-close";

type FileEditorSidebarAgentHeaderTabs_CustomAttributes = {
	"data-ai-chat-thread-id": string;
};

type FileEditorSidebarAgentHeaderTabs_Props = {
	controller: AiChatThreadListController;
	openTabs: storage_local_ValueByKey[`app_state::file_editor_sidebar_open_tabs::scope::${string}`];
	membershipId: string;
	selectedChatTabId: string;
	currentThreads: AiChatThreadListController["currentThreadsWithOptimistic"]["unarchived"]["results"];
	appHoistingContainer: HTMLElement | null;
};

const FileEditorSidebarAgentHeaderTabs = memo(function FileEditorSidebarAgentHeaderTabs(
	props: FileEditorSidebarAgentHeaderTabs_Props,
) {
	const { controller, openTabs, membershipId, selectedChatTabId, currentThreads, appHoistingContainer } = props;
	const selectedTabStorageKey: `app_state::file_editor_sidebar_agent_selected_tab::scope::${string}` = `app_state::file_editor_sidebar_agent_selected_tab::scope::${membershipId}`;
	const openTabsStorageKey: `app_state::file_editor_sidebar_open_tabs::scope::${string}` = `app_state::file_editor_sidebar_open_tabs::scope::${membershipId}`;

	const handleDragEnd = useFn((result: DropResult) => {
		const { destination, source } = result;
		if (destination == null || destination.droppableId !== DROPPABLE_ID || destination.index === source.index) {
			return;
		}

		const next = [...openTabs];
		const [removed] = next.splice(source.index, 1);
		next.splice(destination.index, 0, removed);

		app_local_storage_set_value(openTabsStorageKey, next);
	});

	const handleCloseTab = useFn((threadId: string) => {
		if (openTabs.length <= 1) {
			return;
		}

		const closedTabIndex = openTabs.findIndex((tab) => tab.id === threadId);
		if (closedTabIndex < 0) {
			return;
		}

		const nextOpenTabs = openTabs.filter((tab) => tab.id !== threadId);
		const shouldSwitchTab = selectedChatTabId === threadId || controller.selectedThreadId === threadId;

		if (shouldSwitchTab) {
			const fallbackTab = nextOpenTabs[closedTabIndex - 1] ?? nextOpenTabs[closedTabIndex] ?? nextOpenTabs[0];
			if (fallbackTab) {
				app_local_storage_set_value(selectedTabStorageKey, fallbackTab.id);
				controller.selectThread(fallbackTab.id);
			}
		}

		app_local_storage_set_value(openTabsStorageKey, nextOpenTabs);
		// Remove the client-only session too; otherwise closed New chat tabs can be resurrected from optimistic state.
		controller.removeOptimisticThread(threadId);
	});

	return (
		<MyTabsList
			className={cn("FileEditorSidebarAgentHeaderTabs" satisfies FileEditorSidebarAgentHeaderTabs_ClassNames)}
			aria-label="Open chats"
		>
			{openTabs.length > 0 ? (
				<DragDropContext onDragEnd={handleDragEnd}>
					<Droppable droppableId={DROPPABLE_ID} direction="horizontal">
						{(droppableProvided) => (
							<div
								ref={droppableProvided.innerRef}
								{...droppableProvided.droppableProps}
								className={cn(
									"FileEditorSidebarAgentHeaderTabs-tabs-draggable" satisfies FileEditorSidebarAgentHeaderTabs_ClassNames,
								)}
							>
								{openTabs.map((entry, index) => {
									const isSelectedTab = entry.id === selectedChatTabId;

									return (
										<Draggable key={entry.id} draggableId={entry.id} index={index}>
											{(draggableProvided, draggableSnapshot) => {
												const draggableTab = (
													<MyTabsTabSurface
														ref={draggableProvided.innerRef}
														{...draggableProvided.draggableProps}
														variant="bordered"
														{...({
															"data-ai-chat-thread-id": entry.id,
														} satisfies Partial<FileEditorSidebarAgentHeaderTabs_CustomAttributes>)}
														className={cn(
															"FileEditorSidebarAgentHeaderTabs-tab" satisfies FileEditorSidebarAgentHeaderTabs_ClassNames,
														)}
													>
														<MyTabsTabPrimaryAction
															id={entry.id}
															className={cn(
																"FileEditorSidebarAgentHeaderTabs-tab-primary-action" satisfies FileEditorSidebarAgentHeaderTabs_ClassNames,
															)}
														>
															<span
																className={cn(
																	"FileEditorSidebarAgentHeaderTabs-tab-title" satisfies FileEditorSidebarAgentHeaderTabs_ClassNames,
																)}
															>
																{entry.title}
															</span>
														</MyTabsTabPrimaryAction>

														<span
															{...draggableProvided.dragHandleProps}
															aria-label={`Drag chat tab: ${entry.title}`}
															className={cn(
																"FileEditorSidebarAgentHeaderTabs-tab-handle" satisfies FileEditorSidebarAgentHeaderTabs_ClassNames,
																"MyButton" satisfies MyButton_ClassNames,
																"MyButton-variant-ghost-highlightable" satisfies MyButton_ClassNames,
																"MyIconButton" satisfies MyIconButton_ClassNames,
																"MyTabsTabSecondaryAction" satisfies MyTabsTabSecondaryAction_ClassNames,
															)}
															tabIndex={isSelectedTab ? 0 : -1}
														>
															<MyTabsTabSecondaryActionIcon>
																<GripVertical />
															</MyTabsTabSecondaryActionIcon>
														</span>

														<MyTabsTabSecondaryAction
															className={cn(
																"FileEditorSidebarAgentHeaderTabs-tab-close" satisfies FileEditorSidebarAgentHeaderTabs_ClassNames,
															)}
															tooltip={openTabs.length <= 1 ? "Keep at least one tab open" : "Close tab"}
															disabled={openTabs.length <= 1}
															tabIndex={isSelectedTab ? 0 : -1}
															onClick={() => handleCloseTab(entry.id)}
														>
															<MyTabsTabSecondaryActionIcon>
																<X />
															</MyTabsTabSecondaryActionIcon>
														</MyTabsTabSecondaryAction>
													</MyTabsTabSurface>
												);

												if (draggableSnapshot.isDragging && appHoistingContainer) {
													return createPortal(draggableTab, appHoistingContainer);
												}

												return draggableTab;
											}}
										</Draggable>
									);
								})}
								{droppableProvided.placeholder}
							</div>
						)}
					</Droppable>
				</DragDropContext>
			) : (
				<MyTabsTabSurface>
					<MyTabsTabPrimaryAction id={selectedChatTabId}>
						{selectedChatTabId === NEW_CHAT_TAB_ID
							? "New chat"
							: get_tab_title({
									threadId: selectedChatTabId,
									currentThreads,
									streamingTitleByThreadId: controller.streamingTitleByThreadId,
								})}
					</MyTabsTabPrimaryAction>
				</MyTabsTabSurface>
			)}
		</MyTabsList>
	);
});
// #endregion header tabs

// #region root
type FileEditorSidebarAgent_ClassNames =
	| "FileEditorSidebarAgent"
	| "FileEditorSidebarAgent-chat-area"
	| "FileEditorSidebarAgent-chat-area-panel";

const FileEditorSidebarAgentChatThread = memo(function FileEditorSidebarAgentChatThread(props: {
	scrollableContainer: HTMLElement | null;
}) {
	const { scrollableContainer } = props;
	const controller = AiChatController.useThreadRuntime();

	return <AiChatThread variant="sidebar" controller={controller} scrollableContainer={scrollableContainer} />;
});

export type FileEditorSidebarAgent_Props = {
	/** Id of the root sidebar tab that shows this agent panel (used to know when agent is active for auto-start). */
	rootTabId: string;
};

export const FileEditorSidebarAgent = memo(function FileEditorSidebarAgent(props: FileEditorSidebarAgent_Props) {
	const { membershipId } = AppTenantProvider.useContext();
	const selectedTabStorageKey: AiChatControllerStorageKey = `app_state::file_editor_sidebar_agent_selected_tab::scope::${membershipId}`;

	return (
		<AiChatController key={selectedTabStorageKey} storageKey={selectedTabStorageKey}>
			<FileEditorSidebarAgentContent {...props} />
		</AiChatController>
	);
});

const FileEditorSidebarAgentContent = memo(function FileEditorSidebarAgentContent(props: FileEditorSidebarAgent_Props) {
	const { rootTabId } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const controller = AiChatController.useThreadList({ includeArchived: false });
	const hasAutoStartedRef = useRef(false);
	const mountedOptimisticThreadIdsRef = useRef(new Set<string>());
	const [scrollableContainer, setScrollableContainer] = useState<HTMLElement | null>(null);
	const rootSelectedTab = useAppLocalStorageValue("app_state::files_last_tab");
	const openTabsStorageKey: `app_state::file_editor_sidebar_open_tabs::scope::${string}` = `app_state::file_editor_sidebar_open_tabs::scope::${membershipId}`;
	const selectedTabStorageKey: `app_state::file_editor_sidebar_agent_selected_tab::scope::${string}` = `app_state::file_editor_sidebar_agent_selected_tab::scope::${membershipId}`;
	const openTabs = useAppLocalStorageValue(openTabsStorageKey);
	const selectedAgentTab = useAppLocalStorageValue(selectedTabStorageKey);
	const currentThreads = controller.currentThreadsWithOptimistic.unarchived.results;
	const appHoistingContainer = document.getElementById("app_hoisting_container" satisfies AppElementId);

	const selectedStoredOpenTab = openTabs.find((tab) => tab.id === selectedAgentTab);
	const selectedControllerOpenTab = openTabs.find((tab) => tab.id === controller.selectedThreadId);

	// Keep the sidebar tab selection authoritative inside this panel. The chat
	// controller catches up below; otherwise global last-open restoration can
	// briefly write a stale thread id back into sidebar storage.
	const selectedChatTabId =
		selectedStoredOpenTab?.id ??
		selectedControllerOpenTab?.id ??
		openTabs.at(-1)?.id ??
		controller.selectedThreadId ??
		NEW_CHAT_TAB_ID;

	const rememberOptimisticThreadId = useFn((threadId: AiChatOptimisticThreadId) => {
		mountedOptimisticThreadIdsRef.current.add(threadId);
	});

	// Start a new chat only when the Agent root tab is actually active.
	useEffect(() => {
		if (rootSelectedTab === rootTabId && !hasAutoStartedRef.current && !controller.selectedThreadId) {
			hasAutoStartedRef.current = true;
			rememberOptimisticThreadId(controller.startNewChat());
		}
	}, [rootSelectedTab, rootTabId, controller.selectedThreadId, controller, rememberOptimisticThreadId]);

	// Replace optimistic open-tab ids with their persisted thread ids once the thread is upgraded.
	useEffect(() => {
		let changed = false;
		const nextOpenTabs: storage_local_ValueByKey[`app_state::file_editor_sidebar_open_tabs::scope::${string}`] = [];
		const seenIds = new Set<string>();

		for (const openTab of openTabs) {
			const persistedThread = currentThreads.find((thread) => {
				return !ai_chat_is_optimistic_thread(thread) && thread.clientGeneratedId === openTab.id;
			});

			const nextOpenTab =
				persistedThread == null
					? openTab
					: {
							id: persistedThread._id,
							title: get_tab_title({
								threadId: persistedThread._id,
								currentThreads,
								streamingTitleByThreadId: controller.streamingTitleByThreadId,
								fallbackTitle: openTab.title,
							}),
						};

			if (nextOpenTab.id !== openTab.id || nextOpenTab.title !== openTab.title) {
				changed = true;
			}

			if (seenIds.has(nextOpenTab.id)) {
				changed = true;
				continue;
			}

			seenIds.add(nextOpenTab.id);
			nextOpenTabs.push(nextOpenTab);
		}

		if (changed) {
			app_local_storage_set_value(openTabsStorageKey, nextOpenTabs);
		}

		if (!selectedAgentTab) {
			return;
		}

		const persistedSelectedThread = currentThreads.find((thread) => {
			return !ai_chat_is_optimistic_thread(thread) && thread.clientGeneratedId === selectedAgentTab;
		});

		if (persistedSelectedThread && persistedSelectedThread._id !== selectedAgentTab) {
			app_local_storage_set_value(selectedTabStorageKey, persistedSelectedThread._id);
		}
	}, [
		openTabs,
		selectedAgentTab,
		currentThreads,
		controller.streamingTitleByThreadId,
		openTabsStorageKey,
		selectedTabStorageKey,
	]);

	// Drop unsent optimistic tabs after reload; their in-memory Chat session is gone and cannot be resumed.
	useEffect(() => {
		const currentThreadIds = new Set<string>(currentThreads.map((thread) => thread._id));
		const currentOptimisticThreadIds = new Set(
			currentThreads.filter((thread) => ai_chat_is_optimistic_thread(thread)).map((thread) => thread._id),
		);
		const persistedClientGeneratedThreadIds = new Set(
			currentThreads.map((thread) => (ai_chat_is_optimistic_thread(thread) ? undefined : thread.clientGeneratedId)),
		);
		const nextOpenTabs = openTabs.filter((tab) => {
			if (!tab.id.startsWith("ai_thread-" satisfies GeneratedIdPrefix)) {
				return true;
			}

			if (mountedOptimisticThreadIdsRef.current.has(tab.id) || currentOptimisticThreadIds.has(tab.id)) {
				return true;
			}

			return currentThreadIds.has(tab.id) || persistedClientGeneratedThreadIds.has(tab.id);
		});
		if (nextOpenTabs.length === openTabs.length) {
			return;
		}

		app_local_storage_set_value(openTabsStorageKey, nextOpenTabs);

		if (selectedAgentTab && !nextOpenTabs.some((tab) => tab.id === selectedAgentTab)) {
			const fallbackSelectedTab =
				(controller.selectedThreadId && nextOpenTabs.find((tab) => tab.id === controller.selectedThreadId)?.id) ??
				nextOpenTabs.at(-1)?.id ??
				NEW_CHAT_TAB_ID;

			app_local_storage_set_value(selectedTabStorageKey, fallbackSelectedTab);

			if (controller.selectedThreadId === selectedAgentTab) {
				if (fallbackSelectedTab === NEW_CHAT_TAB_ID) {
					controller.clearSelectedThread();
				} else {
					controller.selectThread(fallbackSelectedTab);
				}
			}
		}
	}, [
		openTabs,
		selectedAgentTab,
		currentThreads,
		controller,
		controller.selectedThreadId,
		openTabsStorageKey,
		selectedTabStorageKey,
	]);

	// Keep tab selection authoritative for the sidebar panel, including after reload from local storage.
	useEffect(() => {
		if (selectedChatTabId === NEW_CHAT_TAB_ID || selectedChatTabId === controller.selectedThreadId) {
			return;
		}

		if (controller.selectedThreadId && !openTabs.some((tab) => tab.id === controller.selectedThreadId)) {
			return;
		}

		const selectedOptimisticThread = currentThreads.find((thread) => {
			return thread._id === selectedChatTabId && ai_chat_is_optimistic_thread(thread);
		});
		if (mountedOptimisticThreadIdsRef.current.has(selectedChatTabId) && !selectedOptimisticThread) {
			return;
		}

		controller.selectThread(selectedChatTabId);
	}, [selectedChatTabId, controller.selectedThreadId, openTabs, currentThreads, controller]);

	// Keep the stored opened chat tabs in sync with controller selection.
	useEffect(() => {
		const threadId = controller.selectedThreadId;
		if (!threadId) {
			return;
		}
		if (threadId !== selectedChatTabId) {
			return;
		}

		const persistedSelectedThread = currentThreads.find((thread) => {
			return !ai_chat_is_optimistic_thread(thread) && thread.clientGeneratedId === threadId && thread._id !== threadId;
		});
		if (persistedSelectedThread) {
			app_local_storage_set_value(selectedTabStorageKey, persistedSelectedThread._id);
			controller.selectThread(persistedSelectedThread._id);
			return;
		}

		const inOpenTabs = openTabs.some((t) => t.id === threadId);
		if (!inOpenTabs) {
			const upgradedOptimisticOpenTab = currentThreads.find((thread) => {
				return !ai_chat_is_optimistic_thread(thread) && thread._id === threadId;
			})?.clientGeneratedId;

			if (upgradedOptimisticOpenTab) {
				const upgradedOpenTabIndex = openTabs.findIndex((tab) => tab.id === upgradedOptimisticOpenTab);
				if (upgradedOpenTabIndex >= 0) {
					const title = get_tab_title({
						threadId,
						currentThreads,
						streamingTitleByThreadId: controller.streamingTitleByThreadId,
					});
					const nextOpenTabs = [...openTabs];
					nextOpenTabs[upgradedOpenTabIndex] = { id: threadId, title };
					app_local_storage_set_value(openTabsStorageKey, nextOpenTabs);
					app_local_storage_set_value(selectedTabStorageKey, threadId);
					return;
				}
			}

			const title = get_tab_title({
				threadId,
				currentThreads,
				streamingTitleByThreadId: controller.streamingTitleByThreadId,
			});
			app_local_storage_set_value(openTabsStorageKey, (previousTabs) => [...previousTabs, { id: threadId, title }]);
			app_local_storage_set_value(selectedTabStorageKey, threadId);
			return;
		}

		if (selectedAgentTab !== threadId) {
			app_local_storage_set_value(selectedTabStorageKey, threadId);
		}
	}, [
		controller.selectedThreadId,
		controller.streamingTitleByThreadId,
		openTabs,
		selectedAgentTab,
		selectedChatTabId,
		currentThreads,
		openTabsStorageKey,
		selectedTabStorageKey,
	]);

	// Keep open tab titles in sync with streaming titles
	useEffect(() => {
		let changed = false;
		const next = openTabs.map((tab) => {
			const nextTitle = get_tab_title({
				threadId: tab.id,
				currentThreads,
				streamingTitleByThreadId: controller.streamingTitleByThreadId,
				fallbackTitle: tab.title,
			});
			if (nextTitle !== tab.title) {
				changed = true;
				return { ...tab, title: nextTitle };
			}
			return tab;
		});
		if (changed) {
			app_local_storage_set_value(openTabsStorageKey, next);
		}
	}, [openTabs, currentThreads, controller.streamingTitleByThreadId, openTabsStorageKey]);

	const handleChatTabChange = useFn((nextSelectedId: string | null | undefined) => {
		if (!nextSelectedId || nextSelectedId === selectedChatTabId) {
			return;
		}

		app_local_storage_set_value(selectedTabStorageKey, nextSelectedId);
		if (nextSelectedId !== NEW_CHAT_TAB_ID) {
			controller.selectThread(nextSelectedId);
		}
	});

	return (
		<div className={cn("FileEditorSidebarAgent" satisfies FileEditorSidebarAgent_ClassNames)}>
			<MyTabs selectedId={selectedChatTabId} setSelectedId={handleChatTabChange}>
				<FileEditorSidebarAgentHeader
					controller={controller}
					openTabs={openTabs}
					membershipId={membershipId}
					selectedChatTabId={selectedChatTabId}
					currentThreads={currentThreads}
					appHoistingContainer={appHoistingContainer}
					onOptimisticThreadCreated={rememberOptimisticThreadId}
				/>
				<MyTabsPanels className={cn("FileEditorSidebarAgent-chat-area" satisfies FileEditorSidebarAgent_ClassNames)}>
					<MyTabsPanel
						ref={setScrollableContainer}
						key={selectedChatTabId}
						className={"FileEditorSidebarAgent-chat-area-panel" satisfies FileEditorSidebarAgent_ClassNames}
						tabId={selectedChatTabId}
					>
						<FileEditorSidebarAgentChatThread scrollableContainer={scrollableContainer} />
					</MyTabsPanel>
				</MyTabsPanels>
			</MyTabs>
		</div>
	);
});
// #endregion root
