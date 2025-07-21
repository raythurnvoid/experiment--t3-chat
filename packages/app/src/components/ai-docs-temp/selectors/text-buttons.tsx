"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { BoldIcon, CodeIcon, ItalicIcon, StrikethroughIcon, UnderlineIcon } from "lucide-react";
import { Editor } from "@tiptap/react";

export type SelectorItem = {
	name: string;
	icon: React.ComponentType<{ className?: string }>;
	command: (editor: Editor | null) => void;
	isActive: (editor: Editor | null) => boolean;
};

interface TextButtons_Props {
	editor: Editor | null;
}

export const TextButtons = ({ editor }: TextButtons_Props) => {
	if (!editor) return null;

	const items: SelectorItem[] = [
		{
			name: "bold",
			isActive: (editor) => editor?.isActive("bold") ?? false,
			command: (editor) => editor?.chain().focus().toggleBold().run(),
			icon: BoldIcon,
		},
		{
			name: "italic",
			isActive: (editor) => editor?.isActive("italic") ?? false,
			command: (editor) => editor?.chain().focus().toggleItalic().run(),
			icon: ItalicIcon,
		},
		{
			name: "underline",
			isActive: (editor) => editor?.isActive("underline") ?? false,
			command: (editor) => editor?.chain().focus().toggleUnderline().run(),
			icon: UnderlineIcon,
		},
		{
			name: "strikethrough",
			isActive: (editor) => editor?.isActive("strike") ?? false,
			command: (editor) => editor?.chain().focus().toggleStrike().run(),
			icon: StrikethroughIcon,
		},
		{
			name: "code",
			isActive: (editor) => editor?.isActive("code") ?? false,
			command: (editor) => editor?.chain().focus().toggleCode().run(),
			icon: CodeIcon,
		},
	];

	return (
		<div className="flex items-center">
			{items.map((item, index) => (
				<Button
					key={index}
					variant="ghost"
					size="sm"
					onClick={() => item.command(editor)}
					className={cn("h-8 px-2", item.isActive(editor) && "bg-accent text-accent-foreground")}
				>
					<item.icon className="h-4 w-4" />
				</Button>
			))}
		</div>
	);
};
