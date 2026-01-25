import "./ai-chat-threads.css";

import type { ChangeEvent, ComponentPropsWithRef, Ref } from "react";
import { useState } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, MessageSquare, Plus, Search, Star, X } from "lucide-react";

import { cn, ui_create_auto_complete_off_value } from "@/lib/utils.ts";
import { type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";

// #region header
type AiChatThreadsHeader_ClassNames =
	| "AiChatThreadsHeader"
	| "AiChatThreadsHeader-row"
	| "AiChatThreadsHeader-close-button"
	| "AiChatThreadsHeader-close-icon";

type AiChatThreadsHeader_Props = {
	searchQuery: string;
	showArchived: boolean;
	onClose?: (() => void) | undefined;
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
					<button
						type="button"
						className={cn("AiChatThreadsHeader-close-button" satisfies AiChatThreadsHeader_ClassNames)}
						onClick={handleCloseClick}
						aria-label="Close threads list"
					>
						<X className={cn("AiChatThreadsHeader-close-icon" satisfies AiChatThreadsHeader_ClassNames)} />
					</button>
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
		<div className={cn("AiChatThreadsSearch" satisfies AiChatThreadsSearch_ClassNames)}>
			<div className={cn("AiChatThreadsSearch-label" satisfies AiChatThreadsSearch_ClassNames)}>Search chats</div>
			<div className={cn("AiChatThreadsSearch-field" satisfies AiChatThreadsSearch_ClassNames)}>
				<Search className={cn("AiChatThreadsSearch-icon" satisfies AiChatThreadsSearch_ClassNames)} />
				<input
					className={cn("AiChatThreadsSearch-input" satisfies AiChatThreadsSearch_ClassNames)}
					placeholder="Search chats..."
					value={searchQuery}
					autoComplete={ui_create_auto_complete_off_value()}
					onChange={onSearchChange}
				/>
			</div>
		</div>
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
		<button
			type="button"
			className={cn("AiChatThreadsNewButton" satisfies AiChatThreadsNewButton_ClassNames)}
			onClick={onClick}
		>
			<Plus className={cn("AiChatThreadsNewButton-icon" satisfies AiChatThreadsNewButton_ClassNames)} />
			<span className={cn("AiChatThreadsNewButton-label" satisfies AiChatThreadsNewButton_ClassNames)}>New Chat</span>
		</button>
	);
}
// #endregion new button

// #region list item
type AiChatThreadsListItem_ClassNames =
	| "AiChatThreadsListItem"
	| "AiChatThreadsListItem-state-hidden"
	| "AiChatThreadsListItem-trigger"
	| "AiChatThreadsListItem-icon"
	| "AiChatThreadsListItem-title"
	| "AiChatThreadsListItem-actions"
	| "AiChatThreadsListItem-action"
	| "AiChatThreadsListItem-action-icon";

type AiChatThreadsListItem_Props = {
	thread: app_convex_Doc<"threads">;
	searchQuery: string;
	streamingTitleByThreadId: Record<string, string | undefined>;
	selectedThreadId: string | null;
	onSelectThread: (threadId: string) => void;
	onToggleFavouriteThread: (threadId: app_convex_Id<"threads">, starred: boolean) => void;
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
		<div
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
				<MessageSquare className={cn("AiChatThreadsListItem-icon" satisfies AiChatThreadsListItem_ClassNames)} />
				<span className={cn("AiChatThreadsListItem-title" satisfies AiChatThreadsListItem_ClassNames)}>
					{threadTitle}
				</span>
			</button>
			<div className={cn("AiChatThreadsListItem-actions" satisfies AiChatThreadsListItem_ClassNames)}>
				<button
					type="button"
					className={cn("AiChatThreadsListItem-action" satisfies AiChatThreadsListItem_ClassNames)}
					onClick={handleStarToggle}
					aria-label={starButtonLabel}
					aria-pressed={isStarred}
					title={starButtonLabel}
				>
					<Star
						className={cn("AiChatThreadsListItem-action-icon" satisfies AiChatThreadsListItem_ClassNames)}
						fill={isStarred ? "currentColor" : "none"}
					/>
				</button>
				<button
					type="button"
					className={cn("AiChatThreadsListItem-action" satisfies AiChatThreadsListItem_ClassNames)}
					onClick={handleArchiveToggle}
					aria-label={archiveButtonLabel}
					title={archiveButtonLabel}
				>
					{isArchived ? (
						<ArchiveIcon
							className={cn("AiChatThreadsListItem-action-icon" satisfies AiChatThreadsListItem_ClassNames)}
						/>
					) : (
						<ArchiveRestoreIcon
							className={cn("AiChatThreadsListItem-action-icon" satisfies AiChatThreadsListItem_ClassNames)}
						/>
					)}
				</button>
			</div>
		</div>
	);
}
// #endregion list item

// #region optimistic list item
type AiChatThreadsOptimisticListItem_Props = {
	thread: app_convex_Doc<"threads">;
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
		<div
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
				<MessageSquare className={cn("AiChatThreadsListItem-icon" satisfies AiChatThreadsListItem_ClassNames)} />
				<span className={cn("AiChatThreadsListItem-title" satisfies AiChatThreadsListItem_ClassNames)}>
					{threadTitle}
				</span>
			</button>
			<div className={cn("AiChatThreadsListItem-actions" satisfies AiChatThreadsListItem_ClassNames)}>
				<button
					type="button"
					className={cn("AiChatThreadsListItem-action" satisfies AiChatThreadsListItem_ClassNames)}
					onClick={handleDelete}
					aria-label={archiveButtonLabel}
					title={archiveButtonLabel}
				>
					<ArchiveRestoreIcon
						className={cn("AiChatThreadsListItem-action-icon" satisfies AiChatThreadsListItem_ClassNames)}
					/>
				</button>
			</div>
		</div>
	);
}
// #endregion optimistic list item

// #region list list
type AiChatThreadsListList_ClassNames = "AiChatThreadsListList";

type AiChatThreadsListList_Props = {
	archived: boolean;
	searchQuery: string;
	threads: app_convex_Doc<"threads">[];
	streamingTitleByThreadId: Record<string, string | undefined>;
	selectedThreadId: string | null;
	onSelectThread: AiChatThreadsListItem_Props["onSelectThread"];
	onToggleFavouriteThread: AiChatThreadsListItem_Props["onToggleFavouriteThread"];
	onArchiveThread: AiChatThreadsListItem_Props["onArchiveThread"];
};

function AiChatThreadsListList(props: AiChatThreadsListList_Props) {
	const {
		archived,
		searchQuery,
		threads,
		streamingTitleByThreadId,
		selectedThreadId,
		onSelectThread,
		onToggleFavouriteThread,
		onArchiveThread,
	} = props;

	const sortedThreads = threads
		.filter((thread) => thread.archived === archived)
		.sort((a, b) => b.last_message_at - a.last_message_at);

	return (
		<div className={cn("AiChatThreadsListList" satisfies AiChatThreadsListList_ClassNames)}>
			{sortedThreads.map((thread) => {
				if (thread._id !== thread.external_id) {
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
				}

				return (
					<AiChatThreadsOptimisticListItem
						key={thread.external_id ?? thread._id}
						thread={thread}
						searchQuery={searchQuery}
						selectedThreadId={selectedThreadId}
						onSelectThread={onSelectThread}
						onArchiveThread={onArchiveThread}
					/>
				);
			})}
		</div>
	);
}
// #endregion list list

// #region list
type AiChatThreadsList_ClassNames = "AiChatThreadsList";

type AiChatThreadsList_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	archived: boolean;
	searchQuery: string;
	threads: app_convex_Doc<"threads">[];
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
		archived,
		searchQuery,
		threads,
		streamingTitleByThreadId,
		selectedThreadId,
		onSelectThread,
		onToggleFavouriteThread,
		onArchiveThread,
		...rest
	} = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("AiChatThreadsList" satisfies AiChatThreadsList_ClassNames, className)}
			{...rest}
		>
			<AiChatThreadsListList
				archived={archived}
				searchQuery={searchQuery}
				threads={threads}
				streamingTitleByThreadId={streamingTitleByThreadId}
				selectedThreadId={selectedThreadId}
				onSelectThread={onSelectThread}
				onToggleFavouriteThread={onToggleFavouriteThread}
				onArchiveThread={onArchiveThread}
			/>
		</div>
	);
}
// #endregion list

// #region root
export type AiChatThreads_ClassNames = "AiChatThreads";

export type AiChatThreads_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
	threads: app_convex_Doc<"threads">[];
	streamingTitleByThreadId: Record<string, string | undefined>;
	selectedThreadId: string | null;
	onClose?: (() => void) | undefined;
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
		threads,
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
		<div ref={ref} id={id} className={cn("AiChatThreads" satisfies AiChatThreads_ClassNames, className)} {...rest}>
			<AiChatThreadsHeader
				onClose={onClose}
				searchQuery={searchQuery}
				onSearchChange={handleSearchChange}
				showArchived={showArchived}
				onShowArchivedChange={handleArchivedChange}
				onNewChat={handleNewChat}
			/>
			<AiChatThreadsList
				archived={showArchived}
				searchQuery={searchQuery}
				threads={threads}
				streamingTitleByThreadId={streamingTitleByThreadId}
				selectedThreadId={selectedThreadId}
				onSelectThread={onSelectThread}
				onToggleFavouriteThread={onToggleFavouriteThread}
				onArchiveThread={onArchiveThread}
			/>
		</div>
	);
}
// #endregion root
