import "./page-editor-rich-text-tools-text-styles.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { BoldIcon, CodeIcon, ItalicIcon, StrikethroughIcon, UnderlineIcon } from "lucide-react";
import { useEditorState, type Editor } from "@tiptap/react";
import { cn } from "@/lib/utils.ts";

export type PageEditorRichTextToolsTextStyles_ClassNames =
	| "PageEditorRichTextToolsTextStyles"
	| "PageEditorRichTextToolsTextStyles-active";

type Item = {
	name: string;
	command: (editor: Editor) => void;
	isActive: (editor: Editor) => boolean;
	icon: React.ComponentType;
	tooltip: string;
};

const items: Item[] = [
	{
		name: "bold",
		command: (editor) => editor?.chain().focus().toggleBold().run(),
		isActive: (editor) => editor?.isActive("bold") ?? false,
		icon: BoldIcon,
		tooltip: "Bold (Ctrl+B)",
	},
	{
		name: "italic",
		command: (editor) => editor?.chain().focus().toggleItalic().run(),
		isActive: (editor) => editor?.isActive("italic") ?? false,
		icon: ItalicIcon,
		tooltip: "Italic (Ctrl+I)",
	},
	{
		name: "underline",
		command: (editor) => editor?.chain().focus().toggleUnderline().run(),
		isActive: (editor) => editor?.isActive("underline") ?? false,
		icon: UnderlineIcon,
		tooltip: "Underline (Ctrl+U)",
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
		tooltip: "Code (Ctrl+E)",
	},
];

export type PageEditorRichTextToolsTextStyles_Props = {
	editor: Editor;
};

export function PageEditorRichTextToolsTextStyles(props: PageEditorRichTextToolsTextStyles_Props) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = props;

	// Subscribe to editor state changes to trigger re-renders when selection changes
	useEditorState({
		editor,
		selector: ({ editor }) => {
			return {
				selection: editor.state.selection,
			};
		},
	});

	return (
		<div className={cn("PageEditorRichTextToolsTextStyles" satisfies PageEditorRichTextToolsTextStyles_ClassNames)}>
			{items.map((item) => (
				<MyIconButton
					key={item.name}
					variant="ghost"
					tooltip={item.tooltip}
					onClick={() => item.command(editor)}
					className={cn(
						item.isActive(editor) &&
							("PageEditorRichTextToolsTextStyles-active" satisfies PageEditorRichTextToolsTextStyles_ClassNames),
					)}
				>
					<MyIconButtonIcon>
						<item.icon />
					</MyIconButtonIcon>
				</MyIconButton>
			))}
		</div>
	);
}
