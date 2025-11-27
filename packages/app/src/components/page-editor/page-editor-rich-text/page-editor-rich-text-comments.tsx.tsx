import { useThreads } from "@liveblocks/react/suspense";
import { AnchoredThreads } from "@liveblocks/react-tiptap";
import { cn } from "@/lib/utils.ts";
import type { Editor } from "@tiptap/react";

export type PageEditorRichTextAnchoredComments_ClassNames = "PageEditorRichTextAnchoredComments";

export type PageEditorRichTextAnchoredComments_Props = {
	editor: Editor;
};

export function PageEditorRichTextAnchoredComments(props: PageEditorRichTextAnchoredComments_Props) {
	const { editor } = props;

	const { threads } = useThreads({ query: { resolved: false } });

	// {isMobile ? (
	// 	<FloatingThreads editor={editor} threads={threads} style={{ width: "350px" }} />
	// )

	return (
		<AnchoredThreads
			className={cn("PageEditorRichTextAnchoredComments" satisfies PageEditorRichTextAnchoredComments_ClassNames)}
			editor={editor}
			threads={threads}
			style={{ width: "350px" }}
		/>
	);
}
