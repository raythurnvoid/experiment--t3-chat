import { Button } from "../../../ui/button.tsx";
import { cn } from "@/lib/utils.ts";
import { MessageSquarePlus } from "lucide-react";
import { useEditor } from "novel";

export function AddCommentSelector() {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = useEditor();
	if (!editor) return null;

	return (
		<Button
			variant="ghost"
			size="sm"
			className={cn("w-12 rounded-none", {
				"text-blue-500": editor.isActive("liveblocksCommentMark"),
			})}
			onClick={() => {
				editor.chain().focus().addPendingComment().run();
			}}
		>
			<MessageSquarePlus
				className={cn("size-4", {
					"text-blue-500": editor.isActive("liveblocksCommentMark"),
				})}
			/>
		</Button>
	);
}
