import "./page-editor-rich-text-tools-text-styles.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { BoldIcon, CodeIcon, ItalicIcon, StrikethroughIcon, UnderlineIcon } from "lucide-react";
import { EditorBubbleItem, useEditor } from "novel";
import { cn } from "@/lib/utils.ts";

export type PageEditorRichTextToolsTextStyles_ClassNames =
	| "PageEditorRichTextToolsTextStyles"
	| "PageEditorRichTextToolsTextStyles-active";

type Item = {
	name: string;
	command: (editor: ReturnType<typeof useEditor>["editor"]) => void;
	isActive: (editor: ReturnType<typeof useEditor>["editor"]) => boolean;
	icon: React.ComponentType;
	tooltip: string;
};

const items: Item[] = [
	{
		name: "bold",
		command: (editor) => editor?.chain().focus().toggleBold().run(),
		isActive: (editor) => editor?.isActive("bold") ?? false,
		icon: BoldIcon,
		tooltip: "Bold",
	},
	{
		name: "italic",
		command: (editor) => editor?.chain().focus().toggleItalic().run(),
		isActive: (editor) => editor?.isActive("italic") ?? false,
		icon: ItalicIcon,
		tooltip: "Italic",
	},
	{
		name: "underline",
		command: (editor) => editor?.chain().focus().toggleUnderline().run(),
		isActive: (editor) => editor?.isActive("underline") ?? false,
		icon: UnderlineIcon,
		tooltip: "Underline",
	},
	{
		name: "strike",
		command: (editor) => editor?.chain().focus().toggleStrike().run(),
		isActive: (editor) => editor?.isActive("strike") ?? false,
		icon: StrikethroughIcon,
		tooltip: "Strikethrough",
	},
	{
		name: "code",
		command: (editor) => editor?.chain().focus().toggleCode().run(),
		isActive: (editor) => editor?.isActive("code") ?? false,
		icon: CodeIcon,
		tooltip: "Code",
	},
];

export function PageEditorRichTextToolsTextStyles() {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = useEditor();
	if (!editor) return null;

	return (
		<div className={cn("PageEditorRichTextToolsTextStyles" satisfies PageEditorRichTextToolsTextStyles_ClassNames)}>
			{items.map((item) => (
				<EditorBubbleItem key={item.name} onSelect={item.command}>
					<MyIconButton
						variant="ghost"
						tooltip={item.tooltip}
						className={cn(
							item.isActive(editor) &&
								("PageEditorRichTextToolsTextStyles-active" satisfies PageEditorRichTextToolsTextStyles_ClassNames),
						)}
					>
						<MyIconButtonIcon>
							<item.icon />
						</MyIconButtonIcon>
					</MyIconButton>
				</EditorBubbleItem>
			))}
		</div>
	);
}
