import { useRef, useState } from "react";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { useGlobalEvent, useGlobalEventList } from "@/lib/global-event.tsx";
import {
	PageEditorCommentsFilterInput,
	PageEditorCommentsThread,
	type PageEditorCommentsThread_Props,
} from "./page-editor-comments-thread.tsx";

// #region thread
type PageEditorCommentsSidebarThread_Props = {
	thread: PageEditorCommentsThread_Props["thread"];
	hidden: PageEditorCommentsThread_Props["hidden"];
};

function PageEditorCommentsSidebarThread(props: PageEditorCommentsSidebarThread_Props) {
	const { thread, hidden } = props;

	const [open, setOpen] = useState(false);

	const threadEl = useRef<HTMLDetailsElement>(null);

	const handleToggle: PageEditorCommentsThread_Props["onToggle"] = (e) => {
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
		<PageEditorCommentsThread ref={threadEl} thread={thread} open={open} hidden={hidden} onToggle={handleToggle} />
	);
}
// #endregion thread

// #region root
export type PageEditorPlainTextCommentsSidebar_ClassNames =
	| "PageEditorPlainTextCommentsSidebar"
	| "PageEditorPlainTextCommentsSidebar-header"
	| "PageEditorPlainTextCommentsSidebar-filter"
	| "PageEditorPlainTextCommentsSidebar-filter-mode"
	| "PageEditorPlainTextCommentsSidebar-list"
	| "PageEditorPlainTextCommentsSidebar-empty";

export type PageEditorCommentsSidebar_Props = {
	threadIds: string[];
};

export function PageEditorCommentsSidebar(props: PageEditorCommentsSidebar_Props) {
	const { threadIds } = props;

	const [query, setFilterValue] = useState("");

	const threadsQuery = useStableQuery(
		app_convex_api.human_thread_messages.human_thread_messages_threads_list,
		threadIds.length > 0
			? {
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					threadIds,
					isArchived: false,
				}
			: "skip",
	);

	const sortedThreads = threadsQuery && threadsQuery.threads.toSorted((a, b) => b.last_message_at - a.last_message_at);

	const normalizedQuery = sortedThreads ? query.trim().toLowerCase() : null;

	const filteredThreadsIds = ((/* iife */) => {
		if (!sortedThreads) return sortedThreads;

		return new Set(PageEditorCommentsFilterInput.filterThreads(sortedThreads, query).map((thread) => thread.id));
	})();

	return (
		<aside className={"PageEditorPlainTextCommentsSidebar" satisfies PageEditorPlainTextCommentsSidebar_ClassNames}>
			<PageEditorCommentsFilterInput value={query} onValueChange={setFilterValue} />

			<div
				className={"PageEditorPlainTextCommentsSidebar-list" satisfies PageEditorPlainTextCommentsSidebar_ClassNames}
			>
				{!sortedThreads || sortedThreads.length === 0 ? (
					<div
						className={
							"PageEditorPlainTextCommentsSidebar-empty" satisfies PageEditorPlainTextCommentsSidebar_ClassNames
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
						<PageEditorCommentsSidebarThread
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
