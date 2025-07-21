"use client";

import {
	Check,
	CheckSquare,
	ChevronDown,
	Code,
	Heading1,
	Heading2,
	Heading3,
	ListOrdered,
	type LucideIcon,
	TextIcon,
	TextQuote,
} from "lucide-react";
import { Editor } from "@tiptap/react";

import { Button } from "@/components/ui/button";
import { PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Popover } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type SelectorItem = {
	name: string;
	icon: LucideIcon;
	command: (editor: Editor | null) => void;
	isActive: (editor: Editor | null) => boolean;
};

interface NodeSelector_Props {
	editor: Editor | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

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
		name: "Bullet List",
		icon: CheckSquare,
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

export const NodeSelector = ({ editor, open, onOpenChange }: NodeSelector_Props) => {
	if (!editor) return null;

	const activeItem = items.find((item) => item.isActive(editor)) || items[0];

	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm" className="flex h-8 items-center gap-2 px-2">
					<activeItem.icon className="h-4 w-4" />
					<span className="text-sm">{activeItem.name}</span>
					<ChevronDown className="h-4 w-4" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-48 p-1" align="start">
				{items.map((item, index) => (
					<Button
						key={index}
						variant="ghost"
						className="h-8 w-full justify-start gap-2 px-2"
						onClick={() => {
							item.command(editor);
							onOpenChange(false);
						}}
					>
						<item.icon className="h-4 w-4" />
						<span className="text-sm">{item.name}</span>
						{item.isActive(editor) && <Check className="ml-auto h-4 w-4" />}
					</Button>
				))}
			</PopoverContent>
		</Popover>
	);
};
