// The `file-editor-rich-text-tools-comment.tsx` component should be implemented in a very similar way
import "./file-editor-rich-text-comments.css";
import { AnchoredThreads, AnchoredThreadsItem } from "@liveblocks/react-tiptap";
import type { Editor } from "@tiptap/react";
import type { chat_messages_Thread } from "../../../../lib/chat-messages.ts";
import {
	FileEditorCommentsFilterInput,
	FileEditorCommentsThread,
	type FileEditorCommentsThread_Props,
} from "../file-editor-comments-thread.tsx";
import { useState } from "react";

// #region thread
type FileEditorRichTextAnchoredCommentsThread_Props = {
	thread: FileEditorCommentsThread_Props["thread"];
	onClick: FileEditorCommentsThread_Props["onClick"];
};

function FileEditorRichTextAnchoredCommentsThread(props: FileEditorRichTextAnchoredCommentsThread_Props) {
	const { thread, onClick } = props;

	const context = AnchoredThreadsItem.useContext();

	return <FileEditorCommentsThread thread={thread} open={context.isActive} hidden={false} onClick={onClick} />;
}
// #endregion thread

// #region threads list
type FileEditorRichTextAnchoredCommentsThreadsList_Props = {
	threads: FileEditorRichTextAnchoredCommentsThread_Props["thread"][];
	onClick: (threadId: string) => void;
};

function FileEditorRichTextAnchoredCommentsThreadsList(props: FileEditorRichTextAnchoredCommentsThreadsList_Props) {
	const { threads, onClick } = props;

	const context = AnchoredThreads.useContext();

	const threadsById = new Map(threads.map((thread) => [thread.id as string, thread]));
	const orderedThreads = Array.from(context.threadPositions.keys())
		.map((threadId) => threadsById.get(threadId))
		.filter((v) => v != null);

	return (
		<>
			{orderedThreads.map((thread) => (
				<AnchoredThreadsItem
					key={thread.id}
					className={
						"FileEditorRichTextAnchoredComments-thread-container" satisfies FileEditorRichTextAnchoredComments_ClassNames
					}
					thread={thread}
				>
					<FileEditorRichTextAnchoredCommentsThread thread={thread} onClick={() => onClick(thread.id)} />
				</AnchoredThreadsItem>
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
	threads: chat_messages_Thread[] | undefined;
};

export function FileEditorRichTextAnchoredComments(props: FileEditorRichTextAnchoredComments_Props) {
	const { editor, threads } = props;

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
					No comments yet
				</div>
			) : (
				<>
					<FileEditorCommentsFilterInput
						value={query}
						ariaLabel="Search document comments"
						onValueChange={setQuery}
					/>
					<AnchoredThreads
						className={
							"FileEditorRichTextAnchoredComments-anchored-elements-container" satisfies FileEditorRichTextAnchoredComments_ClassNames
						}
						editor={editor}
						threads={filteredThreads}
					>
						<FileEditorRichTextAnchoredCommentsThreadsList threads={filteredThreads} onClick={handleThreadClick} />
					</AnchoredThreads>
				</>
			)}
		</aside>
	);
}
// #endregion root
