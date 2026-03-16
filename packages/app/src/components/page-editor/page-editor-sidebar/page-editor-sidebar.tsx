import "./page-editor-sidebar.css";
import { memo, useEffect, useRef, useState, type MouseEvent, type Ref } from "react";
import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { ArchiveIcon, ArchiveRestoreIcon, Clock, GripVertical, Plus, Star, X } from "lucide-react";
import { create } from "zustand";
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
import {
	storage_local,
	storage_local_subscribe_to_storage_events,
	type storage_local_Key,
	useAppLocalStorageState,
} from "@/lib/storage.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { cn } from "@/lib/utils.ts";

const PAGE_EDITOR_SIDEBAR_TAB_ID_COMMENTS = "app_page_editor_sidebar_tabs_comments" satisfies AppElementId;
const PAGE_EDITOR_SIDEBAR_TAB_ID_AGENT = "app_page_editor_sidebar_tabs_agent" satisfies AppElementId;
const PAGE_EDITOR_SIDEBAR_AGENT_TABS_DROPPABLE_ID = "page_editor_sidebar_agent_tabs";
const PAGE_EDITOR_SIDEBAR_AGENT_TAB_ID_NEW = "__page_editor_sidebar_agent_new_chat__";
const PAGE_EDITOR_SIDEBAR_OPEN_TABS_STORAGE_KEY =
	"app_state::page_editor_sidebar_open_tabs" satisfies storage_local_Key;

type page_editor_sidebar_open_tab_Entry = { id: string; title: string };

type page_editor_sidebar_open_tabs_state_State = {
	openTabs: page_editor_sidebar_open_tab_Entry[];
};

const usePageEditorSidebarOpenTabsState = ((/* iife */) => {
	const storage = storage_local();

	const parseOpenTabs = (value: string | null): page_editor_sidebar_open_tabs_state_State["openTabs"] => {
		if (!value) {
			return [];
		}

		try {
			const parsed = JSON.parse(value) as unknown;
			if (!Array.isArray(parsed)) {
				return [];
			}

			return parsed.filter(
				(item): item is page_editor_sidebar_open_tab_Entry =>
					typeof item === "object" &&
					item !== null &&
					typeof (item as page_editor_sidebar_open_tab_Entry).id === "string" &&
					typeof (item as page_editor_sidebar_open_tab_Entry).title === "string",
			);
		} catch {
			return [];
		}
	};

	const store = create<page_editor_sidebar_open_tabs_state_State>(() => ({
		openTabs: parseOpenTabs(storage.getItem(PAGE_EDITOR_SIDEBAR_OPEN_TABS_STORAGE_KEY)),
	}));

	let suppressWrite = false;

	const setStateWithoutTriggeringWriteback = (nextState: Partial<page_editor_sidebar_open_tabs_state_State>) => {
		suppressWrite = true;
		store.setState(nextState);
		suppressWrite = false;
	};

	store.subscribe((state, prev) => {
		if (suppressWrite || state.openTabs === prev.openTabs) {
			return;
		}

		storage.setItem(PAGE_EDITOR_SIDEBAR_OPEN_TABS_STORAGE_KEY, JSON.stringify(state.openTabs));
	});

	if (typeof window !== "undefined") {
		storage_local_subscribe_to_storage_events((event) => {
			if (event.key !== PAGE_EDITOR_SIDEBAR_OPEN_TABS_STORAGE_KEY) {
				return;
			}

			const nextValue = parseOpenTabs(event.newValue);
			const current = store.getState().openTabs;
			if (
				current === nextValue ||
				(current.length === nextValue.length &&
					current.every((entry, index) => entry.id === nextValue[index]?.id && entry.title === nextValue[index]?.title))
			) {
				return;
			}

			setStateWithoutTriggeringWriteback({ openTabs: nextValue });
		});
	}

	return store;
})();

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

type PageEditorSidebarAgent_ClassNames =
	| "PageEditorSidebarAgent"
	| "PageEditorSidebarAgent-header"
	| "PageEditorSidebarAgent-header-main"
	| "PageEditorSidebarAgent-header-tabs"
	| "PageEditorSidebarAgent-header-tabs-draggable"
	| "PageEditorSidebarAgent-header-tab"
	| "PageEditorSidebarAgent-header-tab-handle"
	| "PageEditorSidebarAgent-header-tab-title"
	| "PageEditorSidebarAgent-header-tab-close"
	| "PageEditorSidebarAgent-header-actions"
	| "PageEditorSidebarAgent-chat-area";

const PageEditorSidebarAgent = memo(function PageEditorSidebarAgent() {
	const controller = useAiChatController({ includeArchived: false });
	const hasAutoStartedRef = useRef(false);
	const [scrollableContainer, setScrollableContainer] = useState<HTMLElement | null>(null);
	const rootSelectedTab = useAppLocalStorageState((state) => state.pages_last_tab);
	const openTabs = usePageEditorSidebarOpenTabsState((state) => state.openTabs);
	const selectedAgentTab = useAppLocalStorageState((state) => state.page_editor_sidebar_agent_selected_tab);
	const currentThreads = controller.currentThreadsWithOptimistic.unarchived.results;

	const selectedChatTabId =
		openTabs.find((tab) => tab.id === selectedAgentTab)?.id ??
		(controller.selectedThreadId && openTabs.find((tab) => tab.id === controller.selectedThreadId)?.id) ??
		controller.selectedThreadId ??
		openTabs.at(-1)?.id ??
		PAGE_EDITOR_SIDEBAR_AGENT_TAB_ID_NEW;

	// Start a new chat only when the Agent root tab is actually active.
	useEffect(() => {
		if (
			rootSelectedTab === PAGE_EDITOR_SIDEBAR_TAB_ID_AGENT &&
			!hasAutoStartedRef.current &&
			!controller.selectedThreadId
		) {
			hasAutoStartedRef.current = true;
			controller.startNewChat();
		}
	}, [rootSelectedTab, controller.selectedThreadId, controller]);

	// Replace optimistic open-tab ids with their persisted thread ids once the thread is upgraded.
	useEffect(() => {
		let changed = false;
		const nextOpenTabs: page_editor_sidebar_open_tab_Entry[] = [];
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
			usePageEditorSidebarOpenTabsState.setState({ openTabs: nextOpenTabs });
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
					usePageEditorSidebarOpenTabsState.setState({ openTabs: nextOpenTabs });
					useAppLocalStorageState.setState({ page_editor_sidebar_agent_selected_tab: threadId });
					return;
				}
			}

			const title = get_tab_title({
				threadId,
				currentThreads,
				streamingTitleByThreadId: controller.streamingTitleByThreadId,
			});
			usePageEditorSidebarOpenTabsState.setState((prev) => ({
				openTabs: [...prev.openTabs, { id: threadId, title }],
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
			usePageEditorSidebarOpenTabsState.setState({ openTabs: next });
		}
	}, [openTabs, currentThreads, controller.streamingTitleByThreadId]);

	const handleBeforeSelectThread = useFn((threadId: string) => {
		const inOpenTabs = openTabs.some((t) => t.id === threadId);
		const title = get_tab_title({
			threadId,
			currentThreads,
			streamingTitleByThreadId: controller.streamingTitleByThreadId,
		});
		useAppLocalStorageState.setState({ page_editor_sidebar_agent_selected_tab: threadId });
		if (!inOpenTabs) {
			usePageEditorSidebarOpenTabsState.setState((prev) => ({
				openTabs: [...prev.openTabs, { id: threadId, title }],
			}));
		}
	});

	const handleChatTabChange = useFn((nextSelectedId: string | null | undefined) => {
		if (!nextSelectedId || nextSelectedId === selectedChatTabId) {
			return;
		}

		useAppLocalStorageState.setState({ page_editor_sidebar_agent_selected_tab: nextSelectedId });
		if (nextSelectedId !== PAGE_EDITOR_SIDEBAR_AGENT_TAB_ID_NEW) {
			controller.selectThread(nextSelectedId);
		}
	});

	const handleDragEnd = useFn((result: DropResult) => {
		if (result.destination == null || result.destination.index === result.source.index) {
			return;
		}

		const next = reorder_open_tabs(openTabs, result.source.index, result.destination.index);
		usePageEditorSidebarOpenTabsState.setState({ openTabs: next });
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

		usePageEditorSidebarOpenTabsState.setState({ openTabs: nextOpenTabs });
	});

	const handleNewChat = () => {
		controller.startNewChat();
	};

	return (
		<div className={cn("PageEditorSidebarAgent" satisfies PageEditorSidebarAgent_ClassNames)}>
			<MyTabs selectedId={selectedChatTabId} setSelectedId={handleChatTabChange}>
				<div className={cn("PageEditorSidebarAgent-header" satisfies PageEditorSidebarAgent_ClassNames)}>
					<div className={cn("PageEditorSidebarAgent-header-main" satisfies PageEditorSidebarAgent_ClassNames)}>
						<div className={cn("PageEditorSidebarAgent-header-tabs" satisfies PageEditorSidebarAgent_ClassNames)}>
							<MyTabsList aria-label="Open chats">
								{openTabs.length > 0 ? (
									<DragDropContext onDragEnd={handleDragEnd}>
										<Droppable droppableId={PAGE_EDITOR_SIDEBAR_AGENT_TABS_DROPPABLE_ID} direction="horizontal">
											{(droppableProvided) => (
												<div
													ref={droppableProvided.innerRef}
													{...droppableProvided.droppableProps}
													className={cn(
														"PageEditorSidebarAgent-header-tabs-draggable" satisfies PageEditorSidebarAgent_ClassNames,
													)}
												>
													{openTabs.map((entry, index) => (
														<Draggable key={entry.id} draggableId={entry.id} index={index}>
															{(draggableProvided) => (
																<div
																	ref={draggableProvided.innerRef}
																	{...draggableProvided.draggableProps}
																	className={cn(
																		"PageEditorSidebarAgent-header-tab" satisfies PageEditorSidebarAgent_ClassNames,
																	)}
																>
																	<MyTabsTab id={entry.id}>
																		<span
																			{...draggableProvided.dragHandleProps}
																			className={cn(
																				"PageEditorSidebarAgent-header-tab-handle" satisfies PageEditorSidebarAgent_ClassNames,
																			)}
																			aria-hidden
																		>
																			<MyIcon>
																				<GripVertical />
																			</MyIcon>
																		</span>
																		<span
																			className={cn(
																				"PageEditorSidebarAgent-header-tab-title" satisfies PageEditorSidebarAgent_ClassNames,
																			)}
																		>
																			{entry.title}
																		</span>
																	</MyTabsTab>
																	<MyIconButton
																		className={cn(
																			"PageEditorSidebarAgent-header-tab-close" satisfies PageEditorSidebarAgent_ClassNames,
																		)}
																		variant="ghost-highlightable"
																		tooltip={openTabs.length <= 1 ? "Keep at least one tab open" : "Close tab"}
																		disabled={openTabs.length <= 1}
																		onClick={() => handleCloseTab(entry.id)}
																	>
																		<MyIconButtonIcon>
																			<X />
																		</MyIconButtonIcon>
																	</MyIconButton>
																</div>
															)}
														</Draggable>
													))}
													{droppableProvided.placeholder}
												</div>
											)}
										</Droppable>
									</DragDropContext>
								) : (
									<MyTabsTab id={selectedChatTabId}>
										{selectedChatTabId === PAGE_EDITOR_SIDEBAR_AGENT_TAB_ID_NEW
											? "New chat"
											: get_tab_title({
													threadId: selectedChatTabId,
													currentThreads,
													streamingTitleByThreadId: controller.streamingTitleByThreadId,
												})}
									</MyTabsTab>
								)}
							</MyTabsList>
						</div>
						<div className={cn("PageEditorSidebarAgent-header-actions" satisfies PageEditorSidebarAgent_ClassNames)}>
							<PageEditorSidebarAgentThreadPicker
								controller={controller}
								onBeforeSelectThread={handleBeforeSelectThread}
							/>
							<MyIconButton variant="ghost-highlightable" tooltip="New chat" onClick={handleNewChat}>
								<MyIcon>
									<Plus />
								</MyIcon>
							</MyIconButton>
						</div>
					</div>
				</div>
				<MyTabsPanels
					ref={setScrollableContainer}
					className={cn("PageEditorSidebarAgent-chat-area" satisfies PageEditorSidebarAgent_ClassNames)}
				>
					<MyTabsPanel key={selectedChatTabId} tabId={selectedChatTabId}>
						<AiChatThread variant="sidebar" controller={controller} scrollableContainer={scrollableContainer} />
					</MyTabsPanel>
				</MyTabsPanels>
			</MyTabs>
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

function reorder_open_tabs(
	list: page_editor_sidebar_open_tab_Entry[],
	sourceIndex: number,
	destinationIndex: number,
): page_editor_sidebar_open_tab_Entry[] {
	const result = [...list];
	const [removed] = result.splice(sourceIndex, 1);
	result.splice(destinationIndex, 0, removed);
	return result;
}

export const PageEditorSidebar = memo(function PageEditorSidebar(props: PageEditorSidebar_Props) {
	const { commentsContainerRef } = props;

	const pagesLastTab = useAppLocalStorageState((state) => state.pages_last_tab) ?? PAGE_EDITOR_SIDEBAR_TAB_ID_COMMENTS;

	const handleTabChange = (nextSelectedId: string | null | undefined) => {
		if (!nextSelectedId || nextSelectedId === pagesLastTab) {
			return;
		}

		useAppLocalStorageState.setState({ pages_last_tab: nextSelectedId as AppElementId });
	};

	return (
		<>
			<MyTabs selectedId={pagesLastTab} setSelectedId={handleTabChange}>
				<div className={cn("PageEditorSidebar-toolbar" satisfies PageEditorSidebar_ClassNames)}>
					<div className={cn("PageEditorSidebar-toolbar-scrollable-area" satisfies PageEditorSidebar_ClassNames)}>
						<MyTabsList
							className={cn("PageEditorSidebar-tabs-list" satisfies PageEditorSidebar_ClassNames)}
							aria-label="Sidebar tabs"
						>
							<MyTabsTab id={PAGE_EDITOR_SIDEBAR_TAB_ID_COMMENTS}>Comments</MyTabsTab>
							<MyTabsTab id={PAGE_EDITOR_SIDEBAR_TAB_ID_AGENT}>Agent</MyTabsTab>
						</MyTabsList>
					</div>
				</div>
				<MyTabsPanels className={cn("PageEditorSidebar-tabs-panels" satisfies PageEditorSidebar_ClassNames)}>
					<MyTabsPanel
						className={cn("PageEditorSidebar-panel" satisfies PageEditorSidebar_ClassNames)}
						tabId={PAGE_EDITOR_SIDEBAR_TAB_ID_COMMENTS}
					>
						<div
							ref={commentsContainerRef}
							className={cn("PageEditorSidebar-comments-host" satisfies PageEditorSidebar_ClassNames)}
						></div>
					</MyTabsPanel>
					<MyTabsPanel
						className={cn("PageEditorSidebar-panel" satisfies PageEditorSidebar_ClassNames)}
						tabId={PAGE_EDITOR_SIDEBAR_TAB_ID_AGENT}
					>
						<PageEditorSidebarAgent />
					</MyTabsPanel>
				</MyTabsPanels>
			</MyTabs>
		</>
	);
});
// #endregion root
