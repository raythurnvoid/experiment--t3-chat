import "./page-editor-rich-text-tools-history-buttons.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { cn } from "@/lib/utils.ts";
import type { Editor } from "@tiptap/react";
import { Redo, Undo } from "lucide-react";

export type PageEditorRichTextToolsHistoryButtons_ClassNames =
	| "PageEditorRichTextToolsHistoryButtons"
	| "PageEditorRichTextToolsHistoryButtons-undo"
	| "PageEditorRichTextToolsHistoryButtons-redo";

export type PageEditorRichTextToolsHistoryButtons_Props = {
	editor: Editor;
};

export function PageEditorRichTextToolsHistoryButtons(props: PageEditorRichTextToolsHistoryButtons_Props) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = props;

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
			<MyIconButton
				variant="ghost"
				tooltip="Undo (Ctrl+Z)"
				disabled={!canUndo}
				onClick={handleUndo}
				className={cn(
					"PageEditorRichTextToolsHistoryButtons-undo" satisfies PageEditorRichTextToolsHistoryButtons_ClassNames,
				)}
			>
				<MyIconButtonIcon>
					<Undo />
				</MyIconButtonIcon>
			</MyIconButton>
			<MyIconButton
				variant="ghost"
				tooltip="Redo (Ctrl+Y)"
				disabled={!canRedo}
				onClick={handleRedo}
				className={cn(
					"PageEditorRichTextToolsHistoryButtons-redo" satisfies PageEditorRichTextToolsHistoryButtons_ClassNames,
				)}
			>
				<MyIconButtonIcon>
					<Redo />
				</MyIconButtonIcon>
			</MyIconButton>
		</div>
	);
}
