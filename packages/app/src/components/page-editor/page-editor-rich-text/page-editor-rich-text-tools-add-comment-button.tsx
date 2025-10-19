import "./page-editor-rich-text-tools-add-comment-button.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MessageSquarePlus } from "lucide-react";
import { EditorBubbleItem, useEditor } from "novel";
import { cn } from "@/lib/utils.ts";

export type PageEditorRichTextToolsAddCommentButton_ClassNames =
	| "PageEditorRichTextToolsAddCommentButton"
	| "PageEditorRichTextToolsAddCommentButton-active";

export type PageEditorRichTextToolsAddCommentButton_Props = {};

export function PageEditorRichTextToolsAddCommentButton(props: PageEditorRichTextToolsAddCommentButton_Props) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = useEditor();
	if (!editor) return null;

	return (
		<div
			className={cn(
				"PageEditorRichTextToolsAddCommentButton" satisfies PageEditorRichTextToolsAddCommentButton_ClassNames,
			)}
		>
			<EditorBubbleItem
				onSelect={() => {
					editor.chain().focus().addPendingComment().run();
				}}
			>
				<MyIconButton
					variant="ghost"
					tooltip="Add Comment"
					className={cn(
						editor.isActive("liveblocksCommentMark") &&
							("PageEditorRichTextToolsAddCommentButton-active" satisfies PageEditorRichTextToolsAddCommentButton_ClassNames),
					)}
				>
					<MyIconButtonIcon>
						<MessageSquarePlus />
					</MyIconButtonIcon>
				</MyIconButton>
			</EditorBubbleItem>
		</div>
	);
}
