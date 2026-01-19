import "./ai-chat-threads.css";

import type { ChangeEvent, ComponentPropsWithRef, Ref } from "react";
import { useMemo, useState } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, MessageSquare, Plus, Search, Star, X } from "lucide-react";
import { useMutation, useQuery } from "convex/react";

import { cn, ui_create_auto_complete_off_value } from "@/lib/utils.ts";
import { app_convex_api, type app_convex_Doc } from "@/lib/app-convex-client.ts";
import { useAiChatThreadStore } from "@/stores/ai-chat-thread-store.ts";

// #region header
type AiChatThreadsHeader_ClassNames =
	| "AiChatThreadsHeader"
	| "AiChatThreadsHeader-row"
	| "AiChatThreadsHeader-close-button"
	| "AiChatThreadsHeader-close-icon";

type AiChatThreadsHeader_Props = {
	onClose?: (() => void) | undefined;
	searchQuery: string;
	showArchived: boolean;
	onSearchChange: (event: ChangeEvent<HTMLInputElement>) => void;
	onShowArchivedChange: (event: ChangeEvent<HTMLInputElement>) => void;
	onNewChat: () => void;
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
	activeThreadId: string;
};

function AiChatThreadsListItem(props: AiChatThreadsListItem_Props) {
	const { thread, searchQuery, activeThreadId } = props;
	const selectThread = useAiChatThreadStore((state) => state.selectThread);
	const isMain = activeThreadId === thread._id;
	const threadTitle = thread.title || "New Chat";
	const isArchived = thread.archived === true;
	const matchesSearch = !searchQuery || threadTitle.toLowerCase().includes(searchQuery.toLowerCase());
	const threadUpdateMutation = useMutation(app_convex_api.ai_chat.thread_update);

	const handleSelect = () => {
		selectThread(thread._id);
	};

	const handleStarToggle = () => {
		const isStarred = thread.starred === true;
		threadUpdateMutation({
			threadId: thread._id,
			starred: !isStarred,
		}).catch((error) => {
			console.error("Failed to update thread starred status:", error);
		});
	};

	const handleArchiveToggle = () => {
		threadUpdateMutation({
			threadId: thread._id,
			isArchived: !isArchived,
		}).catch((error) => {
			console.error("Failed to update thread archived status:", error);
		});
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
			data-active={isMain || undefined}
			aria-current={isMain ? "true" : undefined}
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

// #region list list
type AiChatThreadsListList_ClassNames = "AiChatThreadsListList";

type AiChatThreadsListList_Props = {
	archived: boolean;
	searchQuery: string;
	threads: app_convex_Doc<"threads">[];
};

function AiChatThreadsListList(props: AiChatThreadsListList_Props) {
	const { archived, searchQuery, threads } = props;
	const activeThreadId = useAiChatThreadStore((state) => state.selectedThreadId ?? "");
	const visibleThreads = useMemo(() => {
		return threads.filter((thread) => thread.archived === archived);
	}, [threads, archived]);

	return (
		<div className={cn("AiChatThreadsListList" satisfies AiChatThreadsListList_ClassNames)}>
			{visibleThreads.map((thread) => (
				<AiChatThreadsListItem
					key={thread._id}
					thread={thread}
					searchQuery={searchQuery}
					activeThreadId={activeThreadId}
				/>
			))}
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
};

function AiChatThreadsList(props: AiChatThreadsList_Props) {
	const { ref, id, className, archived, searchQuery, threads, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("AiChatThreadsList" satisfies AiChatThreadsList_ClassNames, className)}
			{...rest}
		>
			<AiChatThreadsListList archived={archived} searchQuery={searchQuery} threads={threads} />
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
	onClose?: (() => void) | undefined;
};

export function AiChatThreads(props: AiChatThreads_Props) {
	const { ref, id, className, onClose, ...rest } = props;
	const [searchQuery, setSearchQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const startNewThread = useAiChatThreadStore((state) => state.startNewThread);
	const threadsList = useQuery(app_convex_api.ai_chat.threads_list, {
		paginationOpts: {
			numItems: 20,
			cursor: null,
		},
		includeArchived: true,
	});
	const threadsPage = threadsList?.page?.threads ?? [];

	const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
		setSearchQuery(event.target.value);
	};

	const handleArchivedChange = (event: ChangeEvent<HTMLInputElement>) => {
		setShowArchived(event.target.checked);
	};

	const handleNewChat = () => {
		startNewThread().catch((error) => {
			console.error("Failed to create new chat thread:", error);
		});
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
			<AiChatThreadsList archived={showArchived} searchQuery={searchQuery} threads={threadsPage} />
		</div>
	);
}
// #endregion root
