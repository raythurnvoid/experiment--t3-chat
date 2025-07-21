"use client";

import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Editor } from "@tiptap/react";

interface AddCommentSelector_Props {
	editor: Editor | null;
}

export const AddCommentSelector = ({ editor }: AddCommentSelector_Props) => {
	if (!editor) return null;

	const handle_add_comment = () => {
		// This would integrate with Liveblocks commenting system
		// For now, we'll just focus the editor
		editor.chain().focus().run();
	};

	return (
		<Button variant="ghost" size="sm" onClick={handle_add_comment} className="flex h-8 items-center gap-2 px-2">
			<MessageSquare className="h-4 w-4" />
			<span className="text-sm">Comment</span>
		</Button>
	);
};
