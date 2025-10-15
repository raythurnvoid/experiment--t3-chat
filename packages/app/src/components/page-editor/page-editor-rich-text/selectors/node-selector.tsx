import {
	Check,
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
import { useEditor } from "novel";
import {
	MySelect,
	MySelectTrigger,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectItem,
} from "../../../my-select.tsx";
import { MyButton } from "../../../my-button.tsx";

export type SelectorItem = {
	name: string;
	icon: LucideIcon;
	command: (editor: ReturnType<typeof useEditor>["editor"]) => void;
	isActive: (editor: ReturnType<typeof useEditor>["editor"]) => boolean;
};

const items: SelectorItem[] = [
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
interface NodeSelectorProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function NodeSelector({ open, onOpenChange }: NodeSelectorProps) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = useEditor();
	if (!editor) return null;

	const activeItem = items.filter((item) => item.isActive(editor)).pop() ?? {
		name: "Multiple",
	};

	return (
		<MySelect defaultValue={activeItem.name}>
			<MySelectTrigger>
				<MyButton variant="ghost">
					{activeItem.name || "Select format"}
					<MySelectOpenIndicator />
				</MyButton>
			</MySelectTrigger>
			<MySelectPopover className="w-48 p-1">
				{items.map((item) => (
					<MySelectItem
						key={item.name}
						value={item.name}
						className="flex cursor-pointer items-center justify-between rounded-sm px-2 py-1 text-sm hover:bg-accent"
						onClick={() => {
							item.command(editor);
							onOpenChange(false);
						}}
					>
						<div className="flex items-center space-x-2">
							<div className="rounded-sm border p-1">
								<item.icon className="h-3 w-3" />
							</div>
							<span>{item.name}</span>
						</div>
						{activeItem.name === item.name && <Check className="h-4 w-4" />}
					</MySelectItem>
				))}
			</MySelectPopover>
		</MySelect>
	);
}
