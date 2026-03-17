import "./page-editor-sidebar-agent.css";
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
	MyTabsTabSurface,
} from "@/components/my-tabs.tsx";
import { ai_chat_is_optimistic_thread, type AiChatController, useAiChatController } from "@/hooks/ai-chat-hooks.tsx";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { useAppLocalStorageState, type app_local_storage_state_State } from "@/lib/storage.ts";
import { cn } from "@/lib/utils.ts";

const DROPPABLE_ID = "page_editor_sidebar_agent_tabs";
const NEW_CHAT_TAB_ID = "__page_editor_sidebar_agent_new_chat__";

function get_tab_title(args: {
	threadId: string;
	currentThreads: AiChatController["currentThreadsWithOptimistic"]["unarchived"]["results"];
	streamingTitleByThreadId: AiChatController["streamingTitleByThreadId"];
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
// #endregion thread picker item

// #region thread picker list
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
// #endregion thread picker list

// #region thread picker
type PageEditorSidebarAgentThreadPicker_ClassNames =
	| "PageEditorSidebarAgentThreadPicker"
	| "PageEditorSidebarAgentThreadPicker-popover-content";

type PageEditorSidebarAgentThreadPicker_Props = {
	controller: AiChatController;
	/** Called before selectThread when user picks a thread (e.g. to add to open tabs and set selected tab). */
	onBeforeSelectThread?: (threadId: string) => void;
};

const PageEditorSidebarAgentThreadPicker = memo(function PageEditorSidebarAgentThreadPicker(
	props: PageEditorSidebarAgentThreadPicker_Props,
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
// #endregion thread picker

// #region header
type PageEditorSidebarAgentHeader_ClassNames = "PageEditorSidebarAgentHeader";

type PageEditorSidebarAgentHeader_Props = {
	controller: AiChatController;
	openTabs: app_local_storage_state_State["page_editor_sidebar_open_tabs"];
	selectedChatTabId: string;
	currentThreads: AiChatController["currentThreadsWithOptimistic"]["unarchived"]["results"];
	appHoistingContainer: HTMLElement | null;
};

const PageEditorSidebarAgentHeader = memo(function PageEditorSidebarAgentHeader(
	props: PageEditorSidebarAgentHeader_Props,
) {
	const { controller, openTabs, selectedChatTabId, currentThreads, appHoistingContainer } = props;

	return (
		<div className={cn("PageEditorSidebarAgentHeader" satisfies PageEditorSidebarAgentHeader_ClassNames)}>
			<PageEditorSidebarAgentHeaderTabs
				controller={controller}
				openTabs={openTabs}
				selectedChatTabId={selectedChatTabId}
				currentThreads={currentThreads}
				appHoistingContainer={appHoistingContainer}
			/>
			<PageEditorSidebarAgentHeaderActions
				controller={controller}
				openTabs={openTabs}
				currentThreads={currentThreads}
			/>
		</div>
	);
});
// #endregion header

// #region header actions
type PageEditorSidebarAgentHeaderActions_ClassNames = "PageEditorSidebarAgentHeaderActions";

type PageEditorSidebarAgentHeaderActions_Props = {
	controller: AiChatController;
	openTabs: app_local_storage_state_State["page_editor_sidebar_open_tabs"];
	currentThreads: AiChatController["currentThreadsWithOptimistic"]["unarchived"]["results"];
};

const PageEditorSidebarAgentHeaderActions = memo(function PageEditorSidebarAgentHeaderActions(
	props: PageEditorSidebarAgentHeaderActions_Props,
) {
	const { controller, openTabs, currentThreads } = props;

	const handleBeforeSelectThread = useFn((threadId: string) => {
		const inOpenTabs = openTabs.some((t) => t.id === threadId);
		const title = get_tab_title({
			threadId,
			currentThreads,
			streamingTitleByThreadId: controller.streamingTitleByThreadId,
		});
		useAppLocalStorageState.setState({ page_editor_sidebar_agent_selected_tab: threadId });
		if (!inOpenTabs) {
			useAppLocalStorageState.setState((prev) => ({
				page_editor_sidebar_open_tabs: [...prev.page_editor_sidebar_open_tabs, { id: threadId, title }],
			}));
		}
	});

	const handleNewChat = () => {
		controller.startNewChat();
	};

	return (
		<div className={cn("PageEditorSidebarAgentHeaderActions" satisfies PageEditorSidebarAgentHeaderActions_ClassNames)}>
			<PageEditorSidebarAgentThreadPicker controller={controller} onBeforeSelectThread={handleBeforeSelectThread} />
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
type PageEditorSidebarAgentHeaderTabs_ClassNames =
	| "PageEditorSidebarAgentHeaderTabs"
	| "PageEditorSidebarAgentHeaderTabs-tabs-draggable"
	| "PageEditorSidebarAgentHeaderTabs-tab"
	| "PageEditorSidebarAgentHeaderTabs-tab-handle"
	| "PageEditorSidebarAgentHeaderTabs-tab-primary-action"
	| "PageEditorSidebarAgentHeaderTabs-tab-title"
	| "PageEditorSidebarAgentHeaderTabs-tab-close";

type PageEditorSidebarAgentHeaderTabs_Props = {
	controller: AiChatController;
	openTabs: app_local_storage_state_State["page_editor_sidebar_open_tabs"];
	selectedChatTabId: string;
	currentThreads: AiChatController["currentThreadsWithOptimistic"]["unarchived"]["results"];
	appHoistingContainer: HTMLElement | null;
};

const PageEditorSidebarAgentHeaderTabs = memo(function PageEditorSidebarAgentHeaderTabs(
	props: PageEditorSidebarAgentHeaderTabs_Props,
) {
	const { controller, openTabs, selectedChatTabId, currentThreads, appHoistingContainer } = props;

	const handleDragEnd = useFn((result: DropResult) => {
		const { destination, source } = result;
		if (destination == null || destination.droppableId !== DROPPABLE_ID || destination.index === source.index) {
			return;
		}

		const next = [...openTabs];
		const [removed] = next.splice(source.index, 1);
		next.splice(destination.index, 0, removed);

		useAppLocalStorageState.setState({ page_editor_sidebar_open_tabs: next });
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
				useAppLocalStorageState.setState({ page_editor_sidebar_agent_selected_tab: fallbackTab.id });
				controller.selectThread(fallbackTab.id);
			}
		}

		useAppLocalStorageState.setState({ page_editor_sidebar_open_tabs: nextOpenTabs });
	});

	return (
		<MyTabsList
			className={cn("PageEditorSidebarAgentHeaderTabs" satisfies PageEditorSidebarAgentHeaderTabs_ClassNames)}
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
									"PageEditorSidebarAgentHeaderTabs-tabs-draggable" satisfies PageEditorSidebarAgentHeaderTabs_ClassNames,
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
														className={cn(
															"PageEditorSidebarAgentHeaderTabs-tab" satisfies PageEditorSidebarAgentHeaderTabs_ClassNames,
														)}
													>
														<MyTabsTabPrimaryAction
															id={entry.id}
															className={cn(
																"PageEditorSidebarAgentHeaderTabs-tab-primary-action" satisfies PageEditorSidebarAgentHeaderTabs_ClassNames,
															)}
														>
															<span
																className={cn(
																	"PageEditorSidebarAgentHeaderTabs-tab-title" satisfies PageEditorSidebarAgentHeaderTabs_ClassNames,
																)}
															>
																{entry.title}
															</span>
														</MyTabsTabPrimaryAction>

														<span
															{...draggableProvided.dragHandleProps}
															className={cn(
																"PageEditorSidebarAgentHeaderTabs-tab-handle" satisfies PageEditorSidebarAgentHeaderTabs_ClassNames,
																"MyButton" satisfies MyButton_ClassNames,
																"MyButton-variant-ghost-highlightable" satisfies MyButton_ClassNames,
																"MyIconButton" satisfies MyIconButton_ClassNames,
															)}
															tabIndex={isSelectedTab ? 0 : -1}
														>
															<MyIconButtonIcon>
																<GripVertical />
															</MyIconButtonIcon>
														</span>

														<MyIconButton
															className={cn(
																"PageEditorSidebarAgentHeaderTabs-tab-close" satisfies PageEditorSidebarAgentHeaderTabs_ClassNames,
															)}
															variant="ghost-highlightable"
															tooltip={openTabs.length <= 1 ? "Keep at least one tab open" : "Close tab"}
															disabled={openTabs.length <= 1}
															tabIndex={isSelectedTab ? 0 : -1}
															onClick={() => handleCloseTab(entry.id)}
														>
															<MyIconButtonIcon>
																<X />
															</MyIconButtonIcon>
														</MyIconButton>
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
type PageEditorSidebarAgent_ClassNames =
	| "PageEditorSidebarAgent"
	| "PageEditorSidebarAgent-chat-area"
	| "PageEditorSidebarAgent-chat-area-panel";

export type PageEditorSidebarAgent_Props = {
	/** Id of the root sidebar tab that shows this agent panel (used to know when agent is active for auto-start). */
	rootTabId: string;
};

export const PageEditorSidebarAgent = memo(function PageEditorSidebarAgent(props: PageEditorSidebarAgent_Props) {
	const { rootTabId } = props;
	const controller = useAiChatController({ includeArchived: false });
	const hasAutoStartedRef = useRef(false);
	const [scrollableContainer, setScrollableContainer] = useState<HTMLElement | null>(null);
	const rootSelectedTab = useAppLocalStorageState((state) => state.pages_last_tab);
	const openTabs = useAppLocalStorageState((state) => state.page_editor_sidebar_open_tabs);
	const selectedAgentTab = useAppLocalStorageState((state) => state.page_editor_sidebar_agent_selected_tab);
	const currentThreads = controller.currentThreadsWithOptimistic.unarchived.results;
	const appHoistingContainer = document.getElementById("app_hoisting_container" satisfies AppElementId);

	const selectedChatTabId =
		openTabs.find((tab) => tab.id === selectedAgentTab)?.id ??
		(controller.selectedThreadId && openTabs.find((tab) => tab.id === controller.selectedThreadId)?.id) ??
		controller.selectedThreadId ??
		openTabs.at(-1)?.id ??
		NEW_CHAT_TAB_ID;

	// Start a new chat only when the Agent root tab is actually active.
	useEffect(() => {
		if (rootSelectedTab === rootTabId && !hasAutoStartedRef.current && !controller.selectedThreadId) {
			hasAutoStartedRef.current = true;
			controller.startNewChat();
		}
	}, [rootSelectedTab, rootTabId, controller.selectedThreadId, controller]);

	// Replace optimistic open-tab ids with their persisted thread ids once the thread is upgraded.
	useEffect(() => {
		let changed = false;
		const nextOpenTabs: app_local_storage_state_State["page_editor_sidebar_open_tabs"] = [];
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
			useAppLocalStorageState.setState({ page_editor_sidebar_open_tabs: nextOpenTabs });
		}

		if (!selectedAgentTab) {
			return;
		}

		const persistedSelectedThread = currentThreads.find((thread) => {
			return !ai_chat_is_optimistic_thread(thread) && thread.clientGeneratedId === selectedAgentTab;
		});

		if (persistedSelectedThread && persistedSelectedThread._id !== selectedAgentTab) {
			useAppLocalStorageState.setState({
				page_editor_sidebar_agent_selected_tab: persistedSelectedThread._id,
			});
		}
	}, [openTabs, selectedAgentTab, currentThreads, controller.streamingTitleByThreadId]);

	// Keep the stored opened chat tabs in sync with controller selection.
	useEffect(() => {
		const threadId = controller.selectedThreadId;
		if (!threadId) {
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
					useAppLocalStorageState.setState({ page_editor_sidebar_open_tabs: nextOpenTabs });
					useAppLocalStorageState.setState({ page_editor_sidebar_agent_selected_tab: threadId });
					return;
				}
			}

			const title = get_tab_title({
				threadId,
				currentThreads,
				streamingTitleByThreadId: controller.streamingTitleByThreadId,
			});
			useAppLocalStorageState.setState((prev) => ({
				page_editor_sidebar_open_tabs: [...prev.page_editor_sidebar_open_tabs, { id: threadId, title }],
			}));
			useAppLocalStorageState.setState({ page_editor_sidebar_agent_selected_tab: threadId });
			return;
		}

		if (selectedAgentTab !== threadId) {
			useAppLocalStorageState.setState({ page_editor_sidebar_agent_selected_tab: threadId });
		}
	}, [controller.selectedThreadId, controller.streamingTitleByThreadId, openTabs, selectedAgentTab, currentThreads]);

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
			useAppLocalStorageState.setState({ page_editor_sidebar_open_tabs: next });
		}
	}, [openTabs, currentThreads, controller.streamingTitleByThreadId]);

	const handleChatTabChange = useFn((nextSelectedId: string | null | undefined) => {
		if (!nextSelectedId || nextSelectedId === selectedChatTabId) {
			return;
		}

		useAppLocalStorageState.setState({ page_editor_sidebar_agent_selected_tab: nextSelectedId });
		if (nextSelectedId !== NEW_CHAT_TAB_ID) {
			controller.selectThread(nextSelectedId);
		}
	});

	return (
		<div className={cn("PageEditorSidebarAgent" satisfies PageEditorSidebarAgent_ClassNames)}>
			<MyTabs selectedId={selectedChatTabId} setSelectedId={handleChatTabChange}>
				<PageEditorSidebarAgentHeader
					controller={controller}
					openTabs={openTabs}
					selectedChatTabId={selectedChatTabId}
					currentThreads={currentThreads}
					appHoistingContainer={appHoistingContainer}
				/>
				<MyTabsPanels className={cn("PageEditorSidebarAgent-chat-area" satisfies PageEditorSidebarAgent_ClassNames)}>
					<MyTabsPanel
						ref={setScrollableContainer}
						key={selectedChatTabId}
						className={"PageEditorSidebarAgent-chat-area-panel" satisfies PageEditorSidebarAgent_ClassNames}
						tabId={selectedChatTabId}
					>
						<AiChatThread variant="sidebar" controller={controller} scrollableContainer={scrollableContainer} />
					</MyTabsPanel>
				</MyTabsPanels>
			</MyTabs>
		</div>
	);
});
// #endregion root
