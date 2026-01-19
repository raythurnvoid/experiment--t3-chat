import "./ai-chat-threads.css";

import type { ChangeEvent, ComponentPropsWithRef, Ref } from "react";
import { useMemo, useState } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, MessageSquare, Plus, Search, Star, X } from "lucide-react";
import { useMutation, useQuery } from "convex/react";

import { cn, ui_create_auto_complete_off_value } from "@/lib/utils.ts";
import { app_convex_api, type app_convex_Doc } from "@/lib/app-convex-client.ts";
import { ThreadListItemByIndexProvider, useAssistantApi, useAssistantState } from "@assistant-ui/react";

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
	index: number;
	archived: boolean;
	searchQuery: string;
	threadsById: Map<string, app_convex_Doc<"threads">>;
};

function AiChatThreadsListItem(props: AiChatThreadsListItem_Props) {
	const { index, archived, searchQuery, threadsById } = props;

	return (
		<ThreadListItemByIndexProvider index={index} archived={archived}>
			<AiChatThreadsListItemInner searchQuery={searchQuery} threadsById={threadsById} />
		</ThreadListItemByIndexProvider>
	);
}

type AiChatThreadsListItemInner_Props = {
	searchQuery: string;
	threadsById: Map<string, app_convex_Doc<"threads">>;
};

function AiChatThreadsListItemInner(props: AiChatThreadsListItemInner_Props) {
	const { searchQuery, threadsById } = props;
	const api = useAssistantApi();
	const isMain = useAssistantState(({ threads, threadListItem }) => threads.mainThreadId === threadListItem.id);
	const threadTitle = useAssistantState(({ threadListItem }) => threadListItem.title) || "New Chat";
	const threadRemoteId = useAssistantState(({ threadListItem }) => threadListItem.remoteId);
	const isArchived = useAssistantState(({ threadListItem }) => threadListItem.status === "archived");
	const matchesSearch = !searchQuery || threadTitle.toLowerCase().includes(searchQuery.toLowerCase());

	const threadDoc = threadRemoteId ? threadsById.get(threadRemoteId) : undefined;
	const threadUpdateMutation = useMutation(app_convex_api.ai_chat.thread_update);

	const handleSelect = () => {
		api.threadListItem().switchTo();
	};

	const handleStarToggle = () => {
		if (!threadDoc) return;
		threadUpdateMutation({
			threadId: threadDoc._id,
			starred: !threadDoc.starred,
		}).catch((error) => {
			console.error("Failed to update thread starred status:", error);
		});
	};

	const handleArchiveToggle = () => {
		if (isArchived) {
			api.threadListItem().unarchive();
		} else {
			api.threadListItem().archive();
		}
	};

	const isStarred = threadDoc?.starred === true;
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
					disabled={!threadDoc}
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
	threadsById: Map<string, app_convex_Doc<"threads">>;
};

function AiChatThreadsListList(props: AiChatThreadsListList_Props) {
	const { archived, searchQuery, threadsById } = props;
	const threadIds = useAssistantState(({ threads }) => threads.threadIds);
	const archivedThreadIds = useAssistantState(({ threads }) => threads.archivedThreadIds);
	const itemCount = archived ? archivedThreadIds.length : threadIds.length;
	const itemIndices = useMemo(() => Array.from({ length: itemCount }, (_, index) => index), [itemCount]);

	return (
		<div className={cn("AiChatThreadsListList" satisfies AiChatThreadsListList_ClassNames)}>
			{itemIndices.map((index) => (
				<AiChatThreadsListItem
					key={`${archived ? "archived" : "active"}-${index}`}
					index={index}
					archived={archived}
					searchQuery={searchQuery}
					threadsById={threadsById}
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
	threadsById: Map<string, app_convex_Doc<"threads">>;
};

function AiChatThreadsList(props: AiChatThreadsList_Props) {
	const { ref, id, className, archived, searchQuery, threadsById, ...rest } = props;

	return (
		<div
			ref={ref}
			id={id}
			className={cn("AiChatThreadsList" satisfies AiChatThreadsList_ClassNames, className)}
			{...rest}
		>
			<AiChatThreadsListList archived={archived} searchQuery={searchQuery} threadsById={threadsById} />
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
	const api = useAssistantApi();
	const threadsList = useQuery(app_convex_api.ai_chat.threads_list, {
		paginationOpts: {
			numItems: 20,
			cursor: null,
		},
		includeArchived: true,
	});
	const threadsPage = threadsList?.page?.threads;
	const threadsById = useMemo(() => {
		if (!threadsPage) {
			return new Map<string, app_convex_Doc<"threads">>();
		}

		return new Map<string, app_convex_Doc<"threads">>(threadsPage.map((thread) => [thread._id, thread]));
	}, [threadsPage]);

	const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
		setSearchQuery(event.target.value);
	};

	const handleArchivedChange = (event: ChangeEvent<HTMLInputElement>) => {
		setShowArchived(event.target.checked);
	};

	const handleNewChat = () => {
		api.threads().switchToNewThread();
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
			<AiChatThreadsList archived={showArchived} searchQuery={searchQuery} threadsById={threadsById} />
		</div>
	);
}
// #endregion root
