import "./ai-chat-threads.css";

import type { ChangeEvent, ComponentPropsWithRef, Ref } from "react";
import { memo, useEffect, useState } from "react";

import { useFn } from "@/hooks/utils-hooks.ts";
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	EllipsisVertical,
	GitBranch,
	Plus,
	Search,
	Star,
	Trash2,
	X,
} from "lucide-react";

import { InfiniteScrollSentinel } from "@/components/infinite-scroll-sentinel.tsx";
import { MainAppSidebarToggle } from "@/components/main-app-sidebar-toggle.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyInput, MyInputArea, MyInputBox, MyInputControl, MyInputIcon } from "@/components/my-input.tsx";
import { MyLabel } from "@/components/my-label.tsx";
import {
	MyMenu,
	MyMenuItem,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	MyMenuPopover,
	MyMenuPopoverContent,
	MyMenuTrigger,
} from "@/components/my-menu.tsx";
import {
	MySidebar,
	MySidebarHeader,
	MySidebarList,
	MySidebarListItem,
	MySidebarListItemPrimaryAction,
	MySidebarListItemTitle,
	MySidebarScrollableArea,
	MySidebarTitle,
	type MySidebar_Props,
} from "@/components/my-sidebar.tsx";
import { MyFocus, type MyFocus_ClassNames } from "@/lib/my-focus.ts";
import { useUiId } from "@/lib/ui.tsx";
import { cn, ui_create_auto_complete_off_value } from "@/lib/utils.ts";
import { type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { ai_chat_is_optimistic_thread, type AiChatController } from "@/hooks/ai-chat-hooks.tsx";

const ai_chat_threads_RESULTS_LIST_ID = "ai_chat_threads_results_list";

// #region header
type AiChatThreadsHeader_ClassNames =
	| "AiChatThreadsHeader"
	| "AiChatThreadsHeader-top-section-left"
	| "AiChatThreadsHeader-hamburger-button"
	| "AiChatThreadsHeader-title"
	| "AiChatThreadsHeader-close-button"
	| "AiChatThreadsHeader-close-icon";

type AiChatThreadsHeader_Props = {
	onClose?: () => void;
};

const AiChatThreadsHeader = memo(function AiChatThreadsHeader(props: AiChatThreadsHeader_Props) {
	const { onClose } = props;
	const handleCloseClick = useFn(() => {
		onClose?.();
	});

	return (
		<MySidebarHeader className={cn("AiChatThreadsHeader" satisfies AiChatThreadsHeader_ClassNames)}>
			<div className={cn("AiChatThreadsHeader-top-section-left" satisfies AiChatThreadsHeader_ClassNames)}>
				<MainAppSidebarToggle
					className={cn("AiChatThreadsHeader-hamburger-button" satisfies AiChatThreadsHeader_ClassNames)}
					variant="ghost-highlightable"
					tooltip="Main Menu"
				/>
				<MySidebarTitle className={cn("AiChatThreadsHeader-title" satisfies AiChatThreadsHeader_ClassNames)}>
					AI Chat
				</MySidebarTitle>
			</div>
			{onClose ? (
				<MyIconButton
					className={cn("AiChatThreadsHeader-close-button" satisfies AiChatThreadsHeader_ClassNames)}
					variant="ghost-highlightable"
					onClick={handleCloseClick}
					tooltip="Close"
				>
					<MyIcon className={cn("AiChatThreadsHeader-close-icon" satisfies AiChatThreadsHeader_ClassNames)}>
						<X />
					</MyIcon>
				</MyIconButton>
			) : null}
		</MySidebarHeader>
	);
});
// #endregion header

// #region top section
type AiChatThreadsTopSection_ClassNames = "AiChatThreadsTopSection";

type AiChatThreadsTopSection_Props = {
	searchQuery: string;
	showArchived: boolean;
	onClose?: () => void;
	onSearchChange: AiChatThreadsSearch_Props["onSearchChange"];
	onShowArchivedChange: AiChatThreadsArchivedToggle_Props["onCheckedChange"];
	onNewChat: AiChatThreadsNewButton_Props["onClick"];
};

const AiChatThreadsTopSection = memo(function AiChatThreadsTopSection(props: AiChatThreadsTopSection_Props) {
	const { onClose, searchQuery, showArchived, onSearchChange, onShowArchivedChange, onNewChat } = props;

	return (
		<div className={cn("AiChatThreadsTopSection" satisfies AiChatThreadsTopSection_ClassNames)}>
			<AiChatThreadsHeader onClose={onClose} />
			<AiChatThreadsSearch searchQuery={searchQuery} onSearchChange={onSearchChange} />
			<AiChatThreadsArchivedToggle checked={showArchived} onCheckedChange={onShowArchivedChange} />
			<AiChatThreadsNewButton onClick={onNewChat} />
		</div>
	);
});
// #endregion top section

// #region search
type AiChatThreadsSearch_ClassNames = "AiChatThreadsSearch";

type AiChatThreadsSearch_Props = {
	searchQuery: string;
	onSearchChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

const AiChatThreadsSearch = memo(function AiChatThreadsSearch(props: AiChatThreadsSearch_Props) {
	const { searchQuery, onSearchChange } = props;

	return (
		<MyInput
			className={cn("AiChatThreadsSearch" satisfies AiChatThreadsSearch_ClassNames)}
			variant="surface"
			role="search"
		>
			<MyInputArea>
				<MyInputBox />
				<MyInputIcon>
					<Search />
				</MyInputIcon>
				<MyInputControl
					type="search"
					placeholder="Search chats"
					value={searchQuery}
					autoComplete={ui_create_auto_complete_off_value()}
					aria-controls={ai_chat_threads_RESULTS_LIST_ID}
					onChange={onSearchChange}
				/>
			</MyInputArea>
		</MyInput>
	);
});
// #endregion search

// #region archived toggle
type AiChatThreadsArchivedToggle_ClassNames =
	| "AiChatThreadsArchivedToggle"
	| "AiChatThreadsArchivedToggle-input"
	| "AiChatThreadsArchivedToggle-label";

type AiChatThreadsArchivedToggle_Props = {
	checked: boolean;
	onCheckedChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

const AiChatThreadsArchivedToggle = memo(function AiChatThreadsArchivedToggle(
	props: AiChatThreadsArchivedToggle_Props,
) {
	const { checked, onCheckedChange } = props;
	const inputId = useUiId("AiChatThreadsArchivedToggle-input");

	return (
		<div className={cn("AiChatThreadsArchivedToggle" satisfies AiChatThreadsArchivedToggle_ClassNames)}>
			<input
				id={inputId}
				type="checkbox"
				className={cn("AiChatThreadsArchivedToggle-input" satisfies AiChatThreadsArchivedToggle_ClassNames)}
				checked={checked}
				onChange={onCheckedChange}
			/>
			<MyLabel
				htmlFor={inputId}
				className={cn("AiChatThreadsArchivedToggle-label" satisfies AiChatThreadsArchivedToggle_ClassNames)}
			>
				Show archived
			</MyLabel>
		</div>
	);
});
// #endregion archived toggle

// #region new button
type AiChatThreadsNewButton_ClassNames =
	| "AiChatThreadsNewButton"
	| "AiChatThreadsNewButton-icon"
	| "AiChatThreadsNewButton-label";

type AiChatThreadsNewButton_Props = {
	onClick: () => void;
};

const AiChatThreadsNewButton = memo(function AiChatThreadsNewButton(props: AiChatThreadsNewButton_Props) {
	const { onClick } = props;

	return (
		<MyButton
			className={cn("AiChatThreadsNewButton" satisfies AiChatThreadsNewButton_ClassNames)}
			variant="secondary"
			onClick={onClick}
		>
			<MyButtonIcon className={cn("AiChatThreadsNewButton-icon" satisfies AiChatThreadsNewButton_ClassNames)}>
				<Plus />
			</MyButtonIcon>
			<span className={cn("AiChatThreadsNewButton-label" satisfies AiChatThreadsNewButton_ClassNames)}>New Chat</span>
		</MyButton>
	);
});
// #endregion new button

// #region list item
type AiChatThreadsListItem_ClassNames =
	| "AiChatThreadsListItem"
	| "AiChatThreadsListItem-state-hidden"
	| "AiChatThreadsListItem-trigger"
	| "AiChatThreadsListItem-title"
	| "AiChatThreadsListItem-actions"
	| "AiChatThreadsListItem-action";

type AiChatThreadsListItem_Props = {
	thread: app_convex_Doc<"ai_chat_threads">;
	searchQuery: string;
	streamingTitleByThreadId: Record<string, string | undefined>;
	selectedThreadId: string | null;
	onSelect: (threadId: string) => void;
	onToggleFavourite: (threadId: app_convex_Id<"ai_chat_threads">, starred: boolean) => void;
	onBranch: (threadId: string) => void;
	onArchive: (threadId: string, isArchived: boolean) => void;
};

const AiChatThreadsListItem = memo(function AiChatThreadsListItem(props: AiChatThreadsListItem_Props) {
	const {
		thread,
		searchQuery,
		streamingTitleByThreadId,
		selectedThreadId,
		onSelect,
		onToggleFavourite,
		onBranch,
		onArchive,
	} = props;

	const streamingTitle = streamingTitleByThreadId[thread._id];
	const isActive = selectedThreadId === thread._id;
	const threadTitle = streamingTitle ?? (thread.title || "New Chat");
	const isArchived = thread.archived === true;
	const matchesSearch = !searchQuery || threadTitle.toLowerCase().includes(searchQuery.toLowerCase());

	const handleSelect = useFn(() => {
		onSelect(thread._id);
	});

	const handleStarToggle = useFn(() => {
		const isStarred = thread.starred === true;
		onToggleFavourite(thread._id, !isStarred);
	});

	const handleBranch = useFn(() => {
		onBranch(thread._id);
	});

	const handleArchiveToggle = useFn(() => {
		onArchive(thread._id, !isArchived);
	});

	const isStarred = thread.starred === true;
	const starButtonLabel = isStarred ? "Remove from favorites" : "Add to favorites";
	const archiveLabel = isArchived ? "Unarchive" : "Archive";

	return (
		<MySidebarListItem
			className={cn(
				"AiChatThreadsListItem" satisfies AiChatThreadsListItem_ClassNames,
				!matchesSearch && ("AiChatThreadsListItem-state-hidden" satisfies AiChatThreadsListItem_ClassNames),
			)}
		>
			<MySidebarListItemPrimaryAction
				className={cn(
					"AiChatThreadsListItem-trigger" satisfies AiChatThreadsListItem_ClassNames,
					"MyFocus-row" satisfies MyFocus_ClassNames,
				)}
				selected={isActive}
				onClick={handleSelect}
			>
				<MySidebarListItemTitle
					className={cn("AiChatThreadsListItem-title" satisfies AiChatThreadsListItem_ClassNames)}
				>
					{threadTitle}
				</MySidebarListItemTitle>
			</MySidebarListItemPrimaryAction>
			<div className={cn("AiChatThreadsListItem-actions" satisfies AiChatThreadsListItem_ClassNames)}>
				<MyIconButton
					className={cn("AiChatThreadsListItem-action" satisfies AiChatThreadsListItem_ClassNames)}
					variant="ghost-highlightable"
					onClick={handleStarToggle}
					aria-pressed={isStarred}
					tooltip={starButtonLabel}
				>
					<MyIconButtonIcon>
						<Star fill={isStarred ? "currentColor" : "none"} />
					</MyIconButtonIcon>
				</MyIconButton>
				<MyMenu>
					<MyMenuTrigger>
						<MyIconButton
							className={cn("AiChatThreadsListItem-action" satisfies AiChatThreadsListItem_ClassNames)}
							variant="ghost-highlightable"
							tooltip="More actions"
						>
							<MyIconButtonIcon>
								<EllipsisVertical />
							</MyIconButtonIcon>
						</MyIconButton>
					</MyMenuTrigger>
					<MyMenuPopover>
						<MyMenuPopoverContent>
							<MyMenuItem onClick={handleBranch}>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>
										<GitBranch />
									</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>Branch</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
							<MyMenuItem variant="destructive" onClick={handleArchiveToggle}>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>{isArchived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>{archiveLabel}</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
						</MyMenuPopoverContent>
					</MyMenuPopover>
				</MyMenu>
			</div>
		</MySidebarListItem>
	);
});
// #endregion list item

// #region optimistic list item
type AiChatThreadsOptimisticListItem_Props = {
	thread: app_convex_Doc<"ai_chat_threads">;
	searchQuery: string;
	streamingTitleByThreadId: Record<string, string | undefined>;
	selectedThreadId: string | null;
	onSelect: AiChatThreadsListItem_Props["onSelect"];
	onRemove: (threadId: string) => void;
};

const AiChatThreadsOptimisticListItem = memo(function AiChatThreadsOptimisticListItem(
	props: AiChatThreadsOptimisticListItem_Props,
) {
	const { thread, searchQuery, streamingTitleByThreadId, selectedThreadId, onSelect, onRemove } = props;

	const streamingTitle = streamingTitleByThreadId[thread._id];
	const isActive = selectedThreadId === thread._id;
	const threadTitle = streamingTitle ?? (thread.title || "New Chat");
	const matchesSearch = !searchQuery || threadTitle.toLowerCase().includes(searchQuery.toLowerCase());

	const handleSelect = useFn(() => {
		onSelect(thread._id);
	});

	const handleRemove = useFn(() => {
		onRemove(thread._id);
	});

	return (
		<MySidebarListItem
			className={cn(
				"AiChatThreadsListItem" satisfies AiChatThreadsListItem_ClassNames,
				!matchesSearch && ("AiChatThreadsListItem-state-hidden" satisfies AiChatThreadsListItem_ClassNames),
			)}
		>
			<MySidebarListItemPrimaryAction
				className={cn(
					"AiChatThreadsListItem-trigger" satisfies AiChatThreadsListItem_ClassNames,
					"MyFocus-row" satisfies MyFocus_ClassNames,
				)}
				selected={isActive}
				onClick={handleSelect}
			>
				<MySidebarListItemTitle
					className={cn("AiChatThreadsListItem-title" satisfies AiChatThreadsListItem_ClassNames)}
				>
					{threadTitle}
				</MySidebarListItemTitle>
			</MySidebarListItemPrimaryAction>
			<div className={cn("AiChatThreadsListItem-actions" satisfies AiChatThreadsListItem_ClassNames)}>
				<MyMenu>
					<MyMenuTrigger>
						<MyIconButton
							className={cn("AiChatThreadsListItem-action" satisfies AiChatThreadsListItem_ClassNames)}
							variant="ghost-highlightable"
							tooltip="More actions"
						>
							<MyIconButtonIcon>
								<EllipsisVertical />
							</MyIconButtonIcon>
						</MyIconButton>
					</MyMenuTrigger>
					<MyMenuPopover>
						<MyMenuPopoverContent>
							<MyMenuItem variant="destructive" onClick={handleRemove}>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>
										<Trash2 />
									</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>Remove</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
						</MyMenuPopoverContent>
					</MyMenuPopover>
				</MyMenu>
			</div>
		</MySidebarListItem>
	);
});
// #endregion optimistic list item

// #region results
type AiChatThreadsResults_ClassNames =
	| "AiChatThreadsResults"
	| "AiChatThreadsResults-list"
	| "AiChatThreadsResults-sentinel";

type AiChatThreadsResults_Props = ComponentPropsWithRef<"section"> & {
	ref?: Ref<HTMLElement>;
	id?: string;
	className?: string;
	searchQuery: string;
	paginatedThreads:
		| AiChatController["currentThreadsWithOptimistic"]["unarchived"]
		| AiChatController["currentThreadsWithOptimistic"]["archived"]
		| null;
	streamingTitleByThreadId: Record<string, string | undefined>;
	selectedThreadId: string | null;
	onSelectThread: AiChatThreadsListItem_Props["onSelect"];
	onToggleFavouriteThread: AiChatThreadsListItem_Props["onToggleFavourite"];
	onBranchThread: AiChatThreadsListItem_Props["onBranch"];
	onArchiveThread: AiChatThreadsListItem_Props["onArchive"];
	onRemoveOptimisticThread: AiChatThreadsOptimisticListItem_Props["onRemove"];
};

const AiChatThreadsResults = memo(function AiChatThreadsResults(props: AiChatThreadsResults_Props) {
	const {
		ref,
		id,
		className,
		searchQuery,
		paginatedThreads,
		streamingTitleByThreadId,
		selectedThreadId,
		onSelectThread,
		onToggleFavouriteThread,
		onBranchThread,
		onArchiveThread,
		onRemoveOptimisticThread,
		...rest
	} = props;

	const [scrollRoot, setScrollRoot] = useState<HTMLUListElement | null>(null);

	const threads = paginatedThreads?.results ?? [];
	const sortedThreads = threads.toSorted((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

	const canLoadMore = paginatedThreads?.status === "CanLoadMore";

	const handleIntersection = useFn((args: { entry: IntersectionObserverEntry; observer: IntersectionObserver }) => {
		const { entry } = args;
		if (!entry.isIntersecting) {
			return;
		}
		if (!paginatedThreads || !canLoadMore) {
			return;
		}
		paginatedThreads.loadMore(100);
	});

	useEffect(() => {
		if (!scrollRoot) {
			return;
		}

		const focus = new MyFocus(scrollRoot);
		focus.start();

		return () => {
			focus.stop();
		};
	}, [scrollRoot]);

	return (
		<section
			ref={ref}
			id={id}
			className={cn("AiChatThreadsResults" satisfies AiChatThreadsResults_ClassNames, className)}
			aria-label="Search results"
			{...rest}
		>
			<MySidebarList
				ref={setScrollRoot}
				id={ai_chat_threads_RESULTS_LIST_ID}
				className={cn(
					"AiChatThreadsResults-list" satisfies AiChatThreadsResults_ClassNames,
					"MyFocus-container" satisfies MyFocus_ClassNames,
				)}
			>
				{sortedThreads.map((thread) => {
					if (ai_chat_is_optimistic_thread(thread)) {
						return (
							<AiChatThreadsOptimisticListItem
								key={thread.clientGeneratedId ?? thread._id}
								thread={thread}
								searchQuery={searchQuery}
								streamingTitleByThreadId={streamingTitleByThreadId}
								selectedThreadId={selectedThreadId}
								onSelect={onSelectThread}
								onRemove={onRemoveOptimisticThread}
							/>
						);
					}

					return (
						<AiChatThreadsListItem
							key={thread._id}
							thread={thread}
							searchQuery={searchQuery}
							streamingTitleByThreadId={streamingTitleByThreadId}
							selectedThreadId={selectedThreadId}
							onSelect={onSelectThread}
							onToggleFavourite={onToggleFavouriteThread}
							onBranch={onBranchThread}
							onArchive={onArchiveThread}
						/>
					);
				})}

				{paginatedThreads ? (
					<li
						aria-hidden="true"
						className={cn("AiChatThreadsResults-sentinel" satisfies AiChatThreadsResults_ClassNames)}
					>
						<InfiniteScrollSentinel root={scrollRoot} rootMargin="400px 0px" onIntersection={handleIntersection} />
					</li>
				) : null}
			</MySidebarList>
		</section>
	);
});
// #endregion results

// #region root
export type AiChatThreads_ClassNames = "AiChatThreads";

export type AiChatThreads_Props = MySidebar_Props & {
	paginatedThreads: AiChatController["currentThreadsWithOptimistic"];
	streamingTitleByThreadId: Record<string, string | undefined>;
	selectedThreadId: string | null;
	onClose?: () => void;
	onSelectThread: AiChatThreadsListItem_Props["onSelect"];
	onToggleFavouriteThread: AiChatThreadsListItem_Props["onToggleFavourite"];
	onBranchThread: AiChatThreadsListItem_Props["onBranch"];
	onArchiveThread: AiChatThreadsListItem_Props["onArchive"];
	onRemoveOptimisticThread: (threadId: string) => void;
	onNewChat: AiChatThreadsTopSection_Props["onNewChat"];
};

export const AiChatThreads = memo(function AiChatThreads(props: AiChatThreads_Props) {
	const {
		ref,
		id,
		className,
		state,
		paginatedThreads,
		streamingTitleByThreadId,
		selectedThreadId,
		onClose,
		onSelectThread,
		onToggleFavouriteThread,
		onBranchThread,
		onArchiveThread,
		onRemoveOptimisticThread,
		onNewChat,
		...rest
	} = props;
	const [searchQuery, setSearchQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);

	const handleSearchChange = useFn<AiChatThreadsTopSection_Props["onSearchChange"]>((event) => {
		setSearchQuery(event.target.value);
	});

	const handleArchivedChange = useFn<AiChatThreadsTopSection_Props["onShowArchivedChange"]>((event) => {
		setShowArchived(event.target.checked);
	});

	const handleNewChat = useFn<AiChatThreadsTopSection_Props["onNewChat"]>(() => {
		onNewChat();
	});

	return (
		<MySidebar
			ref={ref}
			id={id}
			state={state}
			aria-hidden={state === "closed" ? true : undefined}
			inert={state === "closed" ? true : undefined}
			className={cn("AiChatThreads" satisfies AiChatThreads_ClassNames, className)}
			{...rest}
		>
			<AiChatThreadsTopSection
				searchQuery={searchQuery}
				showArchived={showArchived}
				onClose={onClose}
				onSearchChange={handleSearchChange}
				onShowArchivedChange={handleArchivedChange}
				onNewChat={handleNewChat}
			/>
			<MySidebarScrollableArea>
				<AiChatThreadsResults
					searchQuery={searchQuery}
					paginatedThreads={showArchived ? paginatedThreads.archived : paginatedThreads.unarchived}
					streamingTitleByThreadId={streamingTitleByThreadId}
					selectedThreadId={selectedThreadId}
					onSelectThread={onSelectThread}
					onToggleFavouriteThread={onToggleFavouriteThread}
					onBranchThread={onBranchThread}
					onArchiveThread={onArchiveThread}
					onRemoveOptimisticThread={onRemoveOptimisticThread}
				/>
			</MySidebarScrollableArea>
		</MySidebar>
	);
});
// #endregion root
