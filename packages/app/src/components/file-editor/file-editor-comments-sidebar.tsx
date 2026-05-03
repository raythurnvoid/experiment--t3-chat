import { useRef, useState } from "react";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { useGlobalEvent, useGlobalEventList } from "@/lib/global-event.tsx";
import {
	FileEditorCommentsFilterInput,
	FileEditorCommentsThread,
	type FileEditorCommentsThread_Props,
} from "./file-editor-comments-thread.tsx";

// #region thread
type FileEditorCommentsSidebarThread_Props = {
	thread: FileEditorCommentsThread_Props["thread"];
	hidden: FileEditorCommentsThread_Props["hidden"];
};

function FileEditorCommentsSidebarThread(props: FileEditorCommentsSidebarThread_Props) {
	const { thread, hidden } = props;

	const [open, setOpen] = useState(false);

	const threadEl = useRef<HTMLDetailsElement>(null);

	const handleToggle: FileEditorCommentsThread_Props["onToggle"] = (e) => {
		setOpen(e.currentTarget.open);
	};

	useGlobalEventList(["pointerdown", "focusin"], (e) => {
		if (threadEl.current && (!e.target || !threadEl.current.contains(e.target as Node))) {
			setOpen(false);
		}
	});

	useGlobalEvent("keydown", (e) => {
		if (e.key === "Escape") {
			setOpen(false);
		}
	});

	return (
		<FileEditorCommentsThread ref={threadEl} thread={thread} open={open} hidden={hidden} onToggle={handleToggle} />
	);
}
// #endregion thread

// #region root
export type FileEditorPlainTextCommentsSidebar_ClassNames =
	| "FileEditorPlainTextCommentsSidebar"
	| "FileEditorPlainTextCommentsSidebar-header"
	| "FileEditorPlainTextCommentsSidebar-filter"
	| "FileEditorPlainTextCommentsSidebar-filter-mode"
	| "FileEditorPlainTextCommentsSidebar-list"
	| "FileEditorPlainTextCommentsSidebar-empty";

export type FileEditorCommentsSidebar_Props = {
	threadIds: string[];
};

export function FileEditorCommentsSidebar(props: FileEditorCommentsSidebar_Props) {
	const { threadIds } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const [query, setFilterValue] = useState("");

	const threadsQuery = useStableQuery(
		app_convex_api.chat_messages.chat_messages_threads_list,
		threadIds.length > 0
			? {
					membershipId,
					threadIds,
					isArchived: false,
				}
			: "skip",
	);

	const sortedThreads = threadsQuery && threadsQuery.threads.toSorted((a, b) => b.lastMessageAt - a.lastMessageAt);

	const normalizedQuery = sortedThreads ? query.trim().toLowerCase() : null;

	const filteredThreadsIds = ((/* iife */) => {
		if (!sortedThreads) return sortedThreads;

		return new Set(FileEditorCommentsFilterInput.filterThreads(sortedThreads, query).map((thread) => thread.id));
	})();

	return (
		<aside className={"FileEditorPlainTextCommentsSidebar" satisfies FileEditorPlainTextCommentsSidebar_ClassNames}>
			<FileEditorCommentsFilterInput value={query} onValueChange={setFilterValue} />

			<div
				className={"FileEditorPlainTextCommentsSidebar-list" satisfies FileEditorPlainTextCommentsSidebar_ClassNames}
			>
				{!sortedThreads || sortedThreads.length === 0 ? (
					<div
						className={
							"FileEditorPlainTextCommentsSidebar-empty" satisfies FileEditorPlainTextCommentsSidebar_ClassNames
						}
					>
						<i>
							{sortedThreads === undefined
								? "Loading comments…"
								: normalizedQuery
									? "No comments found"
									: "No comments yet"}
						</i>
					</div>
				) : (
					sortedThreads.map((thread) => (
						<FileEditorCommentsSidebarThread
							key={`${thread.id}`}
							thread={thread}
							hidden={Boolean(filteredThreadsIds?.has(thread.id)) === false}
						/>
					))
				)}
			</div>
		</aside>
	);
}
// #endregion root
