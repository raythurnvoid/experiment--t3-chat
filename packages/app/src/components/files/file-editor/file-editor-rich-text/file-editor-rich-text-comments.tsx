// The `file-editor-rich-text-tools-comment.tsx` component should be implemented in a very similar way
import "./file-editor-rich-text-comments.css";
import {
	FileEditorRichTextAnchoredThreads,
	FileEditorRichTextAnchoredThreadsItem,
} from "@/lib/file-editor-rich-text-anchored-threads.tsx";
import type { Editor } from "@tiptap/react";
import type { ChannelsMessage } from "@/components/channels/channels-message-window.ts";
import { useChannelsMentionPeople, useChannelsPeople } from "@/components/channels/channels-people.ts";
import type { ChannelsMentionItem } from "@/components/channels/channels-composer-mention.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	FileEditorCommentsFilterInput,
	FileEditorCommentsThread,
	type FileEditorCommentsThread_Props,
} from "../file-editor-comments-thread.tsx";
import { useState } from "react";

// #region thread
type FileEditorRichTextAnchoredCommentsThread_Props = {
	thread: FileEditorCommentsThread_Props["thread"];
	mentionItems: readonly ChannelsMentionItem[];
	onActivate: FileEditorCommentsThread_Props["onActivate"];
	onClose: () => void;
};

function FileEditorRichTextAnchoredCommentsThread(props: FileEditorRichTextAnchoredCommentsThread_Props) {
	const { thread, mentionItems, onActivate, onClose } = props;

	const context = FileEditorRichTextAnchoredThreadsItem.useContext();

	return (
		<FileEditorCommentsThread
			thread={thread}
			open={context.isActive}
			hidden={false}
			mentionItems={mentionItems}
			onActivate={onActivate}
			onToggle={(event) => {
				if (!event.currentTarget.open && context.isActive) onClose();
			}}
		/>
	);
}
// #endregion thread

// #region threads list
type FileEditorRichTextAnchoredCommentsThreadsList_Props = {
	threads: FileEditorRichTextAnchoredCommentsThread_Props["thread"][];
	mentionItems: readonly ChannelsMentionItem[];
	onClick: (threadId: string) => void;
	onClose: () => void;
};

function FileEditorRichTextAnchoredCommentsThreadsList(props: FileEditorRichTextAnchoredCommentsThreadsList_Props) {
	const { threads, mentionItems, onClick, onClose } = props;

	const context = FileEditorRichTextAnchoredThreads.useContext();

	const threadsById = new Map(threads.map((thread) => [thread.message._id as string, thread]));
	const orderedThreads = Array.from(context.threadPositions.keys())
		.map((threadId) => threadsById.get(threadId))
		.filter((v) => v != null);

	return (
		<>
			{orderedThreads.map((thread) => (
				<FileEditorRichTextAnchoredThreadsItem
					key={thread.message._id}
					className={
						"FileEditorRichTextAnchoredComments-thread-container" satisfies FileEditorRichTextAnchoredComments_ClassNames
					}
					thread={thread}
				>
					<FileEditorRichTextAnchoredCommentsThread
						thread={thread}
						mentionItems={mentionItems}
						onActivate={() => onClick(thread.message._id)}
						onClose={onClose}
					/>
				</FileEditorRichTextAnchoredThreadsItem>
			))}
		</>
	);
}
// #endregion threads list

// #region root
export type FileEditorRichTextAnchoredComments_ClassNames =
	| "FileEditorRichTextAnchoredComments"
	| "FileEditorRichTextAnchoredComments-empty"
	| "FileEditorRichTextAnchoredComments-anchored-elements-container"
	| "FileEditorRichTextAnchoredComments-thread-container";

export type FileEditorRichTextAnchoredComments_Props = {
	editor: Editor;
	fileNodeId: app_convex_Id<"files_nodes">;
	threads: ChannelsMessage[] | undefined;
};

export function FileEditorRichTextAnchoredComments(props: FileEditorRichTextAnchoredComments_Props) {
	const { editor, fileNodeId, threads } = props;
	const { people } = useChannelsPeople();
	const mentionItems = useChannelsMentionPeople({ fileNodeId }, people);

	const [query, setQuery] = useState("");

	const filteredThreads = threads ? FileEditorCommentsFilterInput.filterThreads(threads, query) : [];

	const handleThreadClick = (threadId: string) => {
		editor.commands.selectThread(threadId);
	};

	// {isMobile ? (
	// 	<FloatingThreads editor={editor} threads={threads} style={{ width: "350px" }} />
	// )

	return (
		<aside
			aria-label="Document comments"
			className={"FileEditorRichTextAnchoredComments" satisfies FileEditorRichTextAnchoredComments_ClassNames}
		>
			{!threads || threads.length === 0 ? (
				<div
					className={"FileEditorRichTextAnchoredComments-empty" satisfies FileEditorRichTextAnchoredComments_ClassNames}
				>
					No comments on selected text yet
				</div>
			) : (
				<>
					<FileEditorCommentsFilterInput value={query} ariaLabel="Search document comments" onValueChange={setQuery} />
					<FileEditorRichTextAnchoredThreads
						className={
							"FileEditorRichTextAnchoredComments-anchored-elements-container" satisfies FileEditorRichTextAnchoredComments_ClassNames
						}
						editor={editor}
						threads={filteredThreads}
					>
						<FileEditorRichTextAnchoredCommentsThreadsList
							threads={filteredThreads}
							mentionItems={mentionItems}
							onClick={handleThreadClick}
							onClose={() => editor.commands.selectThread(null)}
						/>
					</FileEditorRichTextAnchoredThreads>
				</>
			)}
		</aside>
	);
}
// #endregion root
