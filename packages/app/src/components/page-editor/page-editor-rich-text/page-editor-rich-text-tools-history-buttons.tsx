import "./page-editor-rich-text-tools-history-buttons.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { cn } from "@/lib/utils.ts";
import { Redo, Undo } from "lucide-react";
import { EditorBubbleItem, useEditor } from "novel";

export type PageEditorRichTextToolsHistoryButtons_ClassNames =
	| "PageEditorRichTextToolsHistoryButtons"
	| "PageEditorRichTextToolsHistoryButtons-undo"
	| "PageEditorRichTextToolsHistoryButtons-redo";

export function PageEditorRichTextToolsHistoryButtons() {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = useEditor();
	if (!editor) return null;

	const canUndo = editor.can().chain().focus().undo().run();
	const canRedo = editor.can().chain().focus().redo().run();

	const handleUndo = () => {
		editor.chain().focus().undo().run();
	};

	const handleRedo = () => {
		editor.chain().focus().redo().run();
	};

	return (
		<div
			className={cn("PageEditorRichTextToolsHistoryButtons" satisfies PageEditorRichTextToolsHistoryButtons_ClassNames)}
		>
			<EditorBubbleItem onSelect={handleUndo}>
				<MyIconButton
					variant="ghost"
					tooltip="Undo (Ctrl+Z)"
					disabled={!canUndo}
					className={cn(
						"PageEditorRichTextToolsHistoryButtons-undo" satisfies PageEditorRichTextToolsHistoryButtons_ClassNames,
					)}
				>
					<MyIconButtonIcon>
						<Undo />
					</MyIconButtonIcon>
				</MyIconButton>
			</EditorBubbleItem>
			<EditorBubbleItem onSelect={handleRedo}>
				<MyIconButton
					variant="ghost"
					tooltip="Redo (Ctrl+Y)"
					disabled={!canRedo}
					className={cn(
						"PageEditorRichTextToolsHistoryButtons-redo" satisfies PageEditorRichTextToolsHistoryButtons_ClassNames,
					)}
				>
					<MyIconButtonIcon>
						<Redo />
					</MyIconButtonIcon>
				</MyIconButton>
			</EditorBubbleItem>
		</div>
	);
}
