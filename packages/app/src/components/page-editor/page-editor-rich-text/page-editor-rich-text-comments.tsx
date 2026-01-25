// The `page-editor-rich-text-tools-comment.tsx` component should be implemented in a very similar way
import "./page-editor-rich-text-comments.css";
import { AnchoredThreads, AnchoredThreadsItem } from "@liveblocks/react-tiptap";
import type { Editor } from "@tiptap/react";
import type { human_thread_messages_Thread } from "../../../lib/human-thread-messages.ts";
import {
	PageEditorCommentsFilterInput,
	PageEditorCommentsThread,
	type PageEditorCommentsThread_Props,
} from "../page-editor-comments-thread.tsx";
import { useState } from "react";

// #region thread
type PageEditorRichTextAnchoredCommentsThread_Props = {
	thread: PageEditorCommentsThread_Props["thread"];
	onClick: PageEditorCommentsThread_Props["onClick"];
};

function PageEditorRichTextAnchoredCommentsThread(props: PageEditorRichTextAnchoredCommentsThread_Props) {
	const { thread, onClick } = props;

	const context = AnchoredThreadsItem.useContext();

	return <PageEditorCommentsThread thread={thread} open={context.isActive} hidden={false} onClick={onClick} />;
}
// #endregion thread

// #region threads list
type PageEditorRichTextAnchoredCommentsThreadsList_Props = {
	threads: PageEditorRichTextAnchoredCommentsThread_Props["thread"][];
	onClick: (threadId: string) => void;
};

function PageEditorRichTextAnchoredCommentsThreadsList(props: PageEditorRichTextAnchoredCommentsThreadsList_Props) {
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
						"PageEditorRichTextAnchoredComments-thread-container" satisfies PageEditorRichTextAnchoredComments_ClassNames
					}
					thread={thread}
				>
					<PageEditorRichTextAnchoredCommentsThread thread={thread} onClick={() => onClick(thread.id)} />
				</AnchoredThreadsItem>
			))}
		</>
	);
}
// #endregion threads list

// #region root
export type PageEditorRichTextAnchoredComments_ClassNames =
	| "PageEditorRichTextAnchoredComments"
	| "PageEditorRichTextAnchoredComments-anchored-elements-container"
	| "PageEditorRichTextAnchoredComments-thread-container"
	| "PageEditorRichTextAnchoredComments-filter";

export type PageEditorRichTextAnchoredComments_Props = {
	editor: Editor;
	threads: human_thread_messages_Thread[];
};

export function PageEditorRichTextAnchoredComments(props: PageEditorRichTextAnchoredComments_Props) {
	const { editor, threads } = props;

	const [query, setQuery] = useState("");

	const filteredThreads = PageEditorCommentsFilterInput.filterThreads(threads, query);

	const handleThreadClick = (threadId: string) => {
		editor.commands.selectThread(threadId);
	};

	// {isMobile ? (
	// 	<FloatingThreads editor={editor} threads={threads} style={{ width: "350px" }} />
	// )

	return (
		<aside className={"PageEditorRichTextAnchoredComments" satisfies PageEditorRichTextAnchoredComments_ClassNames}>
			<AnchoredThreads
				className={
					"PageEditorRichTextAnchoredComments-anchored-elements-container" satisfies PageEditorRichTextAnchoredComments_ClassNames
				}
				editor={editor}
				threads={filteredThreads}
			>
				<PageEditorCommentsFilterInput
					className={
						"PageEditorRichTextAnchoredComments-filter" satisfies PageEditorRichTextAnchoredComments_ClassNames
					}
					value={query}
					onValueChange={setQuery}
				/>
				<PageEditorRichTextAnchoredCommentsThreadsList threads={filteredThreads} onClick={handleThreadClick} />
			</AnchoredThreads>
		</aside>
	);
}
// #endregion root
