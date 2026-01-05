// The `page-editor-rich-text-tools-comment.tsx` component should be implemented in a very similar way

import {
	AnchoredThreads,
	type AnchoredThreadComponent_Props,
	AnchoredThreads_CssVars_DEFAULTS,
} from "@liveblocks/react-tiptap";
import { sx } from "@/lib/utils.ts";
import type { Editor } from "@tiptap/react";
import type { human_thread_messages_Thread } from "../../../lib/human-thread-messages.ts";
import { PageEditorCommentsThread } from "../page-editor-comments-thread.tsx";

// #region Thread
function PageEditorRichTextAnchoredCommentsThread(props: AnchoredThreadComponent_Props & { editor: Editor }) {
	const { thread, isActive, onClick, className, style } = props;

	// The open state is controlled AnchoredThreads
	return (
		<PageEditorCommentsThread thread={thread} isOpen={isActive} onClick={onClick} className={className} style={style} />
	);
}
// #endregion Thread

// #region PageEditorRichTextAnchoredComments
export type PageEditorRichTextAnchoredComments_ClassNames = "PageEditorRichTextAnchoredComments";

export type PageEditorRichTextAnchoredComments_Props = {
	editor: Editor;
	threads: human_thread_messages_Thread[];
};

export function PageEditorRichTextAnchoredComments(props: PageEditorRichTextAnchoredComments_Props) {
	const { editor, threads } = props;

	// {isMobile ? (
	// 	<FloatingThreads editor={editor} threads={threads} style={{ width: "350px" }} />
	// )

	return (
		<aside className={"PageEditorRichTextAnchoredComments" satisfies PageEditorRichTextAnchoredComments_ClassNames}>
			<AnchoredThreads
				editor={editor}
				threads={threads}
				components={{ Thread: (props) => <PageEditorRichTextAnchoredCommentsThread {...props} editor={editor} /> }}
				style={sx({
					...AnchoredThreads_CssVars_DEFAULTS,
					"--lb-tiptap-anchored-threads-active-thread-offset": "0px",
				})}
			/>
		</aside>
	);
}
// #endregion PageEditorRichTextAnchoredComments
