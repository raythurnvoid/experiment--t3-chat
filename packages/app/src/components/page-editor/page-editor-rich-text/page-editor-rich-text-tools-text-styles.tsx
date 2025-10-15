import "./page-editor-rich-text-tools-text-styles.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { BoldIcon, CodeIcon, ItalicIcon, StrikethroughIcon, UnderlineIcon } from "lucide-react";
import { EditorBubbleItem, useEditor } from "novel";
import { cn } from "@/lib/utils.ts";

export type PageEditorRichTextToolsTextStyles_ClassNames = "PageEditorRichTextToolsTextStyles";

export function PageEditorRichTextToolsTextStyles() {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = useEditor();
	if (!editor) return null;

	return (
		<div className={cn("PageEditorRichTextToolsTextStyles" satisfies PageEditorRichTextToolsTextStyles_ClassNames)}>
			<EditorBubbleItem
				onSelect={(editor) => {
					editor?.chain().focus().toggleBold().run();
				}}
			>
				<MyIconButton variant="ghost" tooltip="Bold">
					<MyIconButtonIcon>
						<BoldIcon />
					</MyIconButtonIcon>
				</MyIconButton>
			</EditorBubbleItem>

			<EditorBubbleItem
				onSelect={(editor) => {
					editor?.chain().focus().toggleItalic().run();
				}}
			>
				<MyIconButton variant="ghost" tooltip="Italic">
					<MyIconButtonIcon>
						<ItalicIcon />
					</MyIconButtonIcon>
				</MyIconButton>
			</EditorBubbleItem>

			<EditorBubbleItem
				onSelect={(editor) => {
					editor?.chain().focus().toggleUnderline().run();
				}}
			>
				<MyIconButton variant="ghost" tooltip="Underline">
					<MyIconButtonIcon>
						<UnderlineIcon />
					</MyIconButtonIcon>
				</MyIconButton>
			</EditorBubbleItem>

			<EditorBubbleItem
				onSelect={(editor) => {
					editor?.chain().focus().toggleStrike().run();
				}}
			>
				<MyIconButton variant="ghost" tooltip="Strikethrough">
					<MyIconButtonIcon>
						<StrikethroughIcon />
					</MyIconButtonIcon>
				</MyIconButton>
			</EditorBubbleItem>

			<EditorBubbleItem
				onSelect={(editor) => {
					editor?.chain().focus().toggleCode().run();
				}}
			>
				<MyIconButton variant="ghost" tooltip="Code">
					<MyIconButtonIcon>
						<CodeIcon />
					</MyIconButtonIcon>
				</MyIconButton>
			</EditorBubbleItem>
		</div>
	);
}
