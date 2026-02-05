import "./ai-chat-threads.css";

import type { ChangeEvent, ComponentPropsWithRef, Ref } from "react";
import { useState } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, Plus, Search, Star, X } from "lucide-react";

import { InfiniteScrollSentinel } from "@/components/infinite-scroll-sentinel.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyInput, MyInputArea, MyInputBox, MyInputControl, MyInputIcon } from "@/components/my-input.tsx";
import { MySidebar, MySidebarContent, MySidebarHeader, type MySidebar_Props } from "@/components/my-sidebar.tsx";
import { cn, ui_create_auto_complete_off_value } from "@/lib/utils.ts";
import { type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { ai_chat_is_optimistic_thread, type AiChatController } from "@/hooks/ai-chat-hooks.tsx";

const ai_chat_threads_RESULTS_LIST_ID = "ai_chat_threads_results_list";

// #region header
type AiChatThreadsHeader_ClassNames =
	| "AiChatThreadsHeader"
	| "AiChatThreadsHeader-row"
	| "AiChatThreadsHeader-close-button"
	| "AiChatThreadsHeader-close-icon";

type AiChatThreadsHeader_Props = {
	searchQuery: string;
	showArchived: boolean;
	onClose?: () => void;
	onSearchChange: AiChatThreadsSearch_Props["onSearchChange"];
	onShowArchivedChange: AiChatThreadsArchivedToggle_Props["onCheckedChange"];
	onNewChat: AiChatThreadsNewButton_Props["onClick"];
};

function AiChatThreadsHeader(props: AiChatThreadsHeader_Props) {
	const { onClose, searchQuery, showArchived, onSearchChange, onShowArchivedChange, onNewChat } = props;
	const handleCloseClick = () => {
		onClose?.();
	};

	return (
		<div className={cn("AiChatThreadsHeader" satisfies AiChatThreadsHeader_ClassNames)}>
			{onClose ? (
				<div className={cn("AiChatThreadsHeader-row" satisfies AiChatThreadsHeader_ClassNames)}>
					<MyIconButton
						className={cn("AiChatThreadsHeader-close-button" satisfies AiChatThreadsHeader_ClassNames)}
						variant="ghost"
						onClick={handleCloseClick}
						tooltip="Close"
					>
						<MyIcon className={cn("AiChatThreadsHeader-close-icon" satisfies AiChatThreadsHeader_ClassNames)}>
							<X />
						</MyIcon>
					</MyIconButton>
				</div>
			) : null}
			<AiChatThreadsSearch searchQuery={searchQuery} onSearchChange={onSearchChange} />
			<AiChatThreadsArchivedToggle checked={showArchived} onCheckedChange={onShowArchivedChange} />
			<AiChatThreadsNewButton onClick={onNewChat} />
		</div>
	);
}
// #endregion header

// #region search
type AiChatThreadsSearch_ClassNames =
	| "AiChatThreadsSearch"
	| "AiChatThreadsSearch-label"
	| "AiChatThreadsSearch-field"
	| "AiChatThreadsSearch-icon"
	| "AiChatThreadsSearch-input";

type AiChatThreadsSearch_Props = {
	searchQuery: string;
	onSearchChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

function AiChatThreadsSearch(props: AiChatThreadsSearch_Props) {
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
}
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

function AiChatThreadsArchivedToggle(props: AiChatThreadsArchivedToggle_Props) {
	const { checked, onCheckedChange } = props;

	return (
		<label className={cn("AiChatThreadsArchivedToggle" satisfies AiChatThreadsArchivedToggle_ClassNames)}>
			<input
				type="checkbox"
				className={cn("AiChatThreadsArchivedToggle-input" satisfies AiChatThreadsArchivedToggle_ClassNames)}
				checked={checked}
				onChange={onCheckedChange}
			/>
			<span className={cn("AiChatThreadsArchivedToggle-label" satisfies AiChatThreadsArchivedToggle_ClassNames)}>
				Show archived
			</span>
		</label>
	);
}
// #endregion archived toggle

// #region new button
type AiChatThreadsNewButton_ClassNames =
	| "AiChatThreadsNewButton"
	| "AiChatThreadsNewButton-icon"
	| "AiChatThreadsNewButton-label";

type AiChatThreadsNewButton_Props = {
	onClick: () => void;
};

function AiChatThreadsNewButton(props: AiChatThreadsNewButton_Props) {
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
}
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
	onSelectThread: (threadId: string) => void;
	onToggleFavouriteThread: (threadId: app_convex_Id<"ai_chat_threads">, starred: boolean) => void;
	onArchiveThread: (threadId: string, isArchived: boolean) => void;
};

function AiChatThreadsListItem(props: AiChatThreadsListItem_Props) {
	const {
		thread,
		searchQuery,
		streamingTitleByThreadId,
		selectedThreadId,
		onSelectThread,
		onToggleFavouriteThread,
		onArchiveThread,
	} = props;

	const streamingTitle = streamingTitleByThreadId[thread._id];
	const isActive = selectedThreadId === thread._id;
	const threadTitle = streamingTitle ?? (thread.title || "New Chat");
	const isArchived = thread.archived === true;
	const matchesSearch = !searchQuery || threadTitle.toLowerCase().includes(searchQuery.toLowerCase());

	const handleSelect = () => {
		onSelectThread(thread._id);
	};

	const handleStarToggle = () => {
		const isStarred = thread.starred === true;
		onToggleFavouriteThread(thread._id, !isStarred);
	};

	const handleArchiveToggle = () => {
		onArchiveThread(thread._id, !isArchived);
	};

	const isStarred = thread.starred === true;
	const starButtonLabel = isStarred ? "Remove from favorites" : "Add to favorites";
	const archiveButtonLabel = isArchived ? "Unarchive thread" : "Archive thread";

	return (
		<li
			className={cn(
				"AiChatThreadsListItem" satisfies AiChatThreadsListItem_ClassNames,
				!matchesSearch && ("AiChatThreadsListItem-state-hidden" satisfies AiChatThreadsListItem_ClassNames),
			)}
			data-active={isActive || undefined}
			aria-current={isActive ? "true" : undefined}
		>
			<button
				type="button"
				className={cn("AiChatThreadsListItem-trigger" satisfies AiChatThreadsListItem_ClassNames)}
				onClick={handleSelect}
			>
				<span className={cn("AiChatThreadsListItem-title" satisfies AiChatThreadsListItem_ClassNames)}>
					{threadTitle}
				</span>
			</button>
			<div className={cn("AiChatThreadsListItem-actions" satisfies AiChatThreadsListItem_ClassNames)}>
				<MyIconButton
					className={cn("AiChatThreadsListItem-action" satisfies AiChatThreadsListItem_ClassNames)}
					variant="ghost-secondary"
					onClick={handleStarToggle}
					aria-pressed={isStarred}
					tooltip={starButtonLabel}
				>
					<MyIconButtonIcon>
						<Star fill={isStarred ? "currentColor" : "none"} />
					</MyIconButtonIcon>
				</MyIconButton>
				<MyIconButton
					className={cn("AiChatThreadsListItem-action" satisfies AiChatThreadsListItem_ClassNames)}
					variant="ghost-secondary"
					onClick={handleArchiveToggle}
					tooltip={archiveButtonLabel}
				>
					<MyIconButtonIcon>{isArchived ? <ArchiveIcon /> : <ArchiveRestoreIcon />}</MyIconButtonIcon>
				</MyIconButton>
			</div>
		</li>
	);
}
// #endregion list item

// #region optimistic list item
type AiChatThreadsOptimisticListItem_Props = {
	thread: app_convex_Doc<"ai_chat_threads">;
	searchQuery: string;
	selectedThreadId: string | null;
	onSelectThread: AiChatThreadsListItem_Props["onSelectThread"];
	onArchiveThread: AiChatThreadsListItem_Props["onArchiveThread"];
};

function AiChatThreadsOptimisticListItem(props: AiChatThreadsOptimisticListItem_Props) {
	const { thread, searchQuery, selectedThreadId, onSelectThread, onArchiveThread } = props;

	const isActive = selectedThreadId === thread._id;
	const threadTitle = thread.title || "New Chat";
	const matchesSearch = !searchQuery || threadTitle.toLowerCase().includes(searchQuery.toLowerCase());

	const handleSelect = () => {
		onSelectThread(thread._id);
	};

	const handleDelete = () => {
		onArchiveThread(thread._id, true);
	};

	const archiveButtonLabel = "Archive thread";

	return (
		<li
			className={cn(
				"AiChatThreadsListItem" satisfies AiChatThreadsListItem_ClassNames,
				!matchesSearch && ("AiChatThreadsListItem-state-hidden" satisfies AiChatThreadsListItem_ClassNames),
			)}
			data-active={isActive || undefined}
			aria-current={isActive ? "true" : undefined}
		>
			<button
				type="button"
				className={cn("AiChatThreadsListItem-trigger" satisfies AiChatThreadsListItem_ClassNames)}
				onClick={handleSelect}
			>
				<span className={cn("AiChatThreadsListItem-title" satisfies AiChatThreadsListItem_ClassNames)}>
					{threadTitle}
				</span>
			</button>
			<div className={cn("AiChatThreadsListItem-actions" satisfies AiChatThreadsListItem_ClassNames)}>
				<MyIconButton
					className={cn("AiChatThreadsListItem-action" satisfies AiChatThreadsListItem_ClassNames)}
					variant="ghost-secondary"
					onClick={handleDelete}
					tooltip={archiveButtonLabel}
				>
					<MyIconButtonIcon>
						<ArchiveRestoreIcon />
					</MyIconButtonIcon>
				</MyIconButton>
			</div>
		</li>
	);
}
// #endregion optimistic list item

// #region list
type AiChatThreadsList_ClassNames = "AiChatThreadsResults" | "AiChatThreadsList" | "AiChatThreadsList-sentinel";

type AiChatThreadsList_Props = ComponentPropsWithRef<"section"> & {
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
	onSelectThread: AiChatThreadsListItem_Props["onSelectThread"];
	onToggleFavouriteThread: AiChatThreadsListItem_Props["onToggleFavouriteThread"];
	onArchiveThread: AiChatThreadsListItem_Props["onArchiveThread"];
};

function AiChatThreadsList(props: AiChatThreadsList_Props) {
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
		onArchiveThread,
		...rest
	} = props;

	const [scrollRoot, setScrollRoot] = useState<HTMLUListElement | null>(null);

	const threads = paginatedThreads?.results ?? [];
	const sortedThreads = threads.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));

	const canLoadMore = paginatedThreads?.status === "CanLoadMore";

	const handleIntersection = (args: { entry: IntersectionObserverEntry; observer: IntersectionObserver }) => {
		const { entry } = args;
		if (!entry.isIntersecting) {
			return;
		}
		if (!paginatedThreads || !canLoadMore) {
			return;
		}
		paginatedThreads.loadMore(100);
	};

	return (
		<section
			ref={ref}
			id={id}
			className={cn("AiChatThreadsResults" satisfies AiChatThreadsList_ClassNames, className)}
			aria-label="Search results"
			{...rest}
		>
			<ul
				ref={setScrollRoot}
				id={ai_chat_threads_RESULTS_LIST_ID}
				className={cn("AiChatThreadsList" satisfies AiChatThreadsList_ClassNames)}
			>
				{sortedThreads.map((thread) => {
					if (ai_chat_is_optimistic_thread(thread)) {
						return (
							<AiChatThreadsOptimisticListItem
								key={thread.clientGeneratedId ?? thread._id}
								thread={thread}
								searchQuery={searchQuery}
								selectedThreadId={selectedThreadId}
								onSelectThread={onSelectThread}
								onArchiveThread={onArchiveThread}
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
							onSelectThread={onSelectThread}
							onToggleFavouriteThread={onToggleFavouriteThread}
							onArchiveThread={onArchiveThread}
						/>
					);
				})}

				{paginatedThreads ? (
					<li aria-hidden="true" className={cn("AiChatThreadsList-sentinel" satisfies AiChatThreadsList_ClassNames)}>
						<InfiniteScrollSentinel root={scrollRoot} rootMargin="400px 0px" onIntersection={handleIntersection} />
					</li>
				) : null}
			</ul>
		</section>
	);
}
// #endregion list

// #region root
export type AiChatThreads_ClassNames =
	| "AiChatThreads"
	| "AiChatThreadsSidebar"
	| "AiChatThreadsSidebar-header"
	| "AiChatThreadsSidebar-content";

export type AiChatThreads_Props = MySidebar_Props & {
	paginatedThreads: AiChatController["currentThreadsWithOptimistic"];
	streamingTitleByThreadId: Record<string, string | undefined>;
	selectedThreadId: string | null;
	onClose?: () => void;
	onSelectThread: AiChatThreadsListItem_Props["onSelectThread"];
	onToggleFavouriteThread: AiChatThreadsListItem_Props["onToggleFavouriteThread"];
	onArchiveThread: AiChatThreadsListItem_Props["onArchiveThread"];
	onNewChat: AiChatThreadsHeader_Props["onNewChat"];
};

export function AiChatThreads(props: AiChatThreads_Props) {
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
		onArchiveThread,
		onNewChat,
		...rest
	} = props;
	const [searchQuery, setSearchQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);

	const handleSearchChange: AiChatThreadsHeader_Props["onSearchChange"] = (event) => {
		setSearchQuery(event.target.value);
	};

	const handleArchivedChange: AiChatThreadsHeader_Props["onShowArchivedChange"] = (event) => {
		setShowArchived(event.target.checked);
	};

	const handleNewChat: AiChatThreadsHeader_Props["onNewChat"] = () => {
		onNewChat();
	};

	return (
		<MySidebar
			ref={ref}
			id={id}
			state={state}
			aria-hidden={state === "closed" ? true : undefined}
			inert={state === "closed" ? true : undefined}
			className={cn("AiChatThreadsSidebar" satisfies AiChatThreads_ClassNames, className)}
			{...rest}
		>
			<div className={cn("AiChatThreads" satisfies AiChatThreads_ClassNames)}>
				<MySidebarHeader className={cn("AiChatThreadsSidebar-header" satisfies AiChatThreads_ClassNames)}>
					<AiChatThreadsHeader
						onClose={onClose}
						searchQuery={searchQuery}
						onSearchChange={handleSearchChange}
						showArchived={showArchived}
						onShowArchivedChange={handleArchivedChange}
						onNewChat={handleNewChat}
					/>
				</MySidebarHeader>
				<MySidebarContent className={cn("AiChatThreadsSidebar-content" satisfies AiChatThreads_ClassNames)}>
					<AiChatThreadsList
						searchQuery={searchQuery}
						paginatedThreads={showArchived ? paginatedThreads.archived : paginatedThreads.unarchived}
						streamingTitleByThreadId={streamingTitleByThreadId}
						selectedThreadId={selectedThreadId}
						onSelectThread={onSelectThread}
						onToggleFavouriteThread={onToggleFavouriteThread}
						onArchiveThread={onArchiveThread}
					/>
				</MySidebarContent>
			</div>
		</MySidebar>
	);
}
// #endregion root
