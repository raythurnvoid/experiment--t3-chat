import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";
import { Redo, Undo } from "lucide-react";
import { EditorBubbleItem, useEditor } from "novel";

export const HistoryButtons = () => {
	const { editor } = useEditor();
	if (!editor) return null;

	const history_items = [
		{
			name: "undo",
			icon: Undo,
			command: () => editor.chain().focus().undo().run(),
			canExecute: () => editor.can().chain().focus().undo().run(),
			shortcut: "Ctrl+Z",
		},
		{
			name: "redo",
			icon: Redo,
			command: () => editor.chain().focus().redo().run(),
			canExecute: () => editor.can().chain().focus().redo().run(),
			shortcut: "Ctrl+Y",
		},
	];

	return (
		<div className="flex">
			{history_items.map((item) => (
				<EditorBubbleItem
					key={item.name}
					onSelect={() => {
						item.command();
					}}
				>
					<Button
						size="sm"
						className="rounded-none"
						variant="ghost"
						disabled={!item.canExecute()}
						title={`${item.name} (${item.shortcut})`}
					>
						<item.icon className={cn("h-4 w-4")} />
					</Button>
				</EditorBubbleItem>
			))}
		</div>
	);
};
