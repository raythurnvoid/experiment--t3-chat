import { MyIconButton } from "@/components/my-icon-button.tsx";
import { BoldIcon, CodeIcon, ItalicIcon, StrikethroughIcon, UnderlineIcon } from "lucide-react";
import { EditorBubbleItem, useEditor } from "novel";

export function TextButtons() {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = useEditor();
	if (!editor) return null;

	return (
		<div className="flex">
			<EditorBubbleItem
				onSelect={(editor) => {
					editor?.chain().focus().toggleBold().run();
				}}
			>
				<MyIconButton variant="ghost" tooltip="Bold">
					<BoldIcon className="h-4 w-4" />
				</MyIconButton>
			</EditorBubbleItem>

			<EditorBubbleItem
				onSelect={(editor) => {
					editor?.chain().focus().toggleItalic().run();
				}}
			>
				<MyIconButton variant="ghost" tooltip="Italic">
					<ItalicIcon className="h-4 w-4" />
				</MyIconButton>
			</EditorBubbleItem>

			<EditorBubbleItem
				onSelect={(editor) => {
					editor?.chain().focus().toggleUnderline().run();
				}}
			>
				<MyIconButton variant="ghost" tooltip="Underline">
					<UnderlineIcon className="h-4 w-4" />
				</MyIconButton>
			</EditorBubbleItem>

			<EditorBubbleItem
				onSelect={(editor) => {
					editor?.chain().focus().toggleStrike().run();
				}}
			>
				<MyIconButton variant="ghost" tooltip="Strikethrough">
					<StrikethroughIcon className="h-4 w-4" />
				</MyIconButton>
			</EditorBubbleItem>

			<EditorBubbleItem
				onSelect={(editor) => {
					editor?.chain().focus().toggleCode().run();
				}}
			>
				<MyIconButton variant="ghost" tooltip="Code">
					<CodeIcon className="h-4 w-4" />
				</MyIconButton>
			</EditorBubbleItem>
		</div>
	);
}
