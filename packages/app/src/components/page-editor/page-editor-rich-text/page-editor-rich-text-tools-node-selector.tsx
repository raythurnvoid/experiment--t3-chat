import {
	CheckSquare,
	Code,
	Heading1,
	Heading2,
	Heading3,
	Heading4,
	Heading5,
	Heading6,
	ListOrdered,
	type LucideIcon,
	TextIcon,
	TextQuote,
} from "lucide-react";
import { useState } from "react";
import { useEditor } from "novel";
import { useEditorState } from "@tiptap/react";
import {
	MySelect,
	MySelectTrigger,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectPopoverScrollableArea,
	MySelectItem,
	MySelectItemIndicator,
	MySelectItemContent,
	MySelectItemContentPrimary,
	MySelectItemContentIcon,
} from "@/components/my-select.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { cn } from "@/lib/utils.ts";
import "./page-editor-rich-text-tools-node-selector.css";

type Item = {
	name: string;
	icon: LucideIcon;
	command: (editor: ReturnType<typeof useEditor>["editor"]) => void;
	isActive: (editor: ReturnType<typeof useEditor>["editor"]) => boolean;
};

const items: Item[] = [
	{
		name: "Text",
		icon: TextIcon,
		command: (editor) => editor?.chain().focus().clearNodes().run(),
		isActive: (editor) =>
			(editor?.isActive("paragraph") && !editor?.isActive("bulletList") && !editor?.isActive("orderedList")) ?? false,
	},
	{
		name: "Heading 1",
		icon: Heading1,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 1 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 1 }) ?? false,
	},
	{
		name: "Heading 2",
		icon: Heading2,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 2 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 2 }) ?? false,
	},
	{
		name: "Heading 3",
		icon: Heading3,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 3 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 3 }) ?? false,
	},
	{
		name: "Heading 4",
		icon: Heading4,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 4 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 4 }) ?? false,
	},
	{
		name: "Heading 5",
		icon: Heading5,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 5 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 5 }) ?? false,
	},
	{
		name: "Heading 6",
		icon: Heading6,
		command: (editor) => editor?.chain().focus().clearNodes().toggleHeading({ level: 6 }).run(),
		isActive: (editor) => editor?.isActive("heading", { level: 6 }) ?? false,
	},
	{
		name: "To-do List",
		icon: CheckSquare,
		command: (editor) => editor?.chain().focus().clearNodes().toggleTaskList().run(),
		isActive: (editor) => editor?.isActive("taskItem") ?? false,
	},
	{
		name: "Bullet List",
		icon: ListOrdered,
		command: (editor) => editor?.chain().focus().clearNodes().toggleBulletList().run(),
		isActive: (editor) => editor?.isActive("bulletList") ?? false,
	},
	{
		name: "Numbered List",
		icon: ListOrdered,
		command: (editor) => editor?.chain().focus().clearNodes().toggleOrderedList().run(),
		isActive: (editor) => editor?.isActive("orderedList") ?? false,
	},
	{
		name: "Quote",
		icon: TextQuote,
		command: (editor) => editor?.chain().focus().clearNodes().toggleBlockquote().run(),
		isActive: (editor) => editor?.isActive("blockquote") ?? false,
	},
	{
		name: "Code",
		icon: Code,
		command: (editor) => editor?.chain().focus().clearNodes().toggleCodeBlock().run(),
		isActive: (editor) => editor?.isActive("codeBlock") ?? false,
	},
];

export type PageEditorRichTextToolsNodeSelector_ClassNames =
	| "PageEditorRichTextToolsNodeSelector"
	| "PageEditorRichTextToolsNodeSelector-popover"
	| "PageEditorRichTextToolsNodeSelector-item"
	| "PageEditorRichTextToolsNodeSelector-icon";

export type PageEditorRichTextToolsNodeSelector_Props = {};

export function PageEditorRichTextToolsNodeSelector(props: PageEditorRichTextToolsNodeSelector_Props) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = useEditor();

	// Subscribe to editor state changes to trigger re-renders when selection changes
	useEditorState({
		editor,
		selector: ({ editor }) => {
			if (!editor) return null;
			return {
				selection: editor.state.selection,
			};
		},
	});

	const [open, setOpen] = useState(false);

	if (!editor) return null;

	const activeItem = items.filter((item) => item.isActive(editor)).pop() ?? {
		name: "Multiple",
	};

	const handleClick = (item: Item) => {
		item.command(editor);
	};

	return (
		<div className={cn("PageEditorRichTextToolsNodeSelector" satisfies PageEditorRichTextToolsNodeSelector_ClassNames)}>
			<MySelect value={activeItem.name} open={open} setOpen={setOpen}>
				<MySelectTrigger>
					<MyButton variant="ghost">
						{activeItem.name || "Select format"}
						<MySelectOpenIndicator />
					</MyButton>
				</MySelectTrigger>
				<MySelectPopover
					className={cn(
						"PageEditorRichTextToolsNodeSelector-popover" satisfies PageEditorRichTextToolsNodeSelector_ClassNames,
					)}
				>
					<MySelectPopoverScrollableArea>
						<MySelectPopoverContent>
							{items.map((item) => (
								<MySelectItem
									key={item.name}
									className={cn(
										"PageEditorRichTextToolsNodeSelector-item" satisfies PageEditorRichTextToolsNodeSelector_ClassNames,
									)}
									value={item.name}
									onClick={() => handleClick(item)}
								>
									<MySelectItemContent>
										<MySelectItemContentIcon
											className={cn(
												"PageEditorRichTextToolsNodeSelector-icon" satisfies PageEditorRichTextToolsNodeSelector_ClassNames,
											)}
										>
											<item.icon />
										</MySelectItemContentIcon>
										<MySelectItemContentPrimary>{item.name}</MySelectItemContentPrimary>
									</MySelectItemContent>

									{activeItem.name === item.name && <MySelectItemIndicator />}
								</MySelectItem>
							))}
						</MySelectPopoverContent>
					</MySelectPopoverScrollableArea>
				</MySelectPopover>
			</MySelect>
		</div>
	);
}
