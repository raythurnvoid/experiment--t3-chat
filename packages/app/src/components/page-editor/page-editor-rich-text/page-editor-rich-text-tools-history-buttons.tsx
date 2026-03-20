import "./page-editor-rich-text-tools-history-buttons.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import { Redo, Undo } from "lucide-react";
import { memo } from "react";
import { useEditorState, type Editor } from "@tiptap/react";

// #region undo
export type PageEditorRichTextToolsHistoryUndoButton_ClassNames = "PageEditorRichTextToolsHistoryUndoButton";

type PageEditorRichTextToolsHistoryUndoButton_Props = {
	editor: Editor;
	disabled: boolean;
};

const PageEditorRichTextToolsHistoryUndoButton = memo(function PageEditorRichTextToolsHistoryUndoButton(
	props: PageEditorRichTextToolsHistoryUndoButton_Props,
) {
	const { editor, disabled } = props;

	const handleClick = useFn(() => {
		editor.chain().focus().undo().run();
	});

	return (
		<MyIconButton
			variant="ghost"
			tooltip="Undo (Ctrl+Z)"
			disabled={disabled}
			onClick={handleClick}
			className={cn(
				"PageEditorRichTextToolsHistoryUndoButton" satisfies PageEditorRichTextToolsHistoryUndoButton_ClassNames,
			)}
		>
			<MyIconButtonIcon>
				<Undo />
			</MyIconButtonIcon>
		</MyIconButton>
	);
});
// #endregion undo

// #region redo
export type PageEditorRichTextToolsHistoryRedoButton_ClassNames = "PageEditorRichTextToolsHistoryRedoButton";

type PageEditorRichTextToolsHistoryRedoButton_Props = {
	editor: Editor;
	disabled: boolean;
};

const PageEditorRichTextToolsHistoryRedoButton = memo(function PageEditorRichTextToolsHistoryRedoButton(
	props: PageEditorRichTextToolsHistoryRedoButton_Props,
) {
	const { editor, disabled } = props;

	const handleClick = useFn(() => {
		editor.chain().focus().redo().run();
	});

	return (
		<MyIconButton
			variant="ghost"
			tooltip="Redo (Ctrl+Y)"
			disabled={disabled}
			onClick={handleClick}
			className={cn(
				"PageEditorRichTextToolsHistoryRedoButton" satisfies PageEditorRichTextToolsHistoryRedoButton_ClassNames,
			)}
		>
			<MyIconButtonIcon>
				<Redo />
			</MyIconButtonIcon>
		</MyIconButton>
	);
});
// #endregion redo

// #region root
export type PageEditorRichTextToolsHistoryButtonsInner_ClassNames = "PageEditorRichTextToolsHistoryButtonsInner";

type PageEditorRichTextToolsHistoryButtonsInner_Props = {
	canRedo: boolean;
	canUndo: boolean;
	editor: Editor;
};

const PageEditorRichTextToolsHistoryButtonsInner = memo(function PageEditorRichTextToolsHistoryButtonsInner(
	props: PageEditorRichTextToolsHistoryButtonsInner_Props,
) {
	const { canRedo, canUndo, editor } = props;

	return (
		<div
			className={cn(
				"PageEditorRichTextToolsHistoryButtonsInner" satisfies PageEditorRichTextToolsHistoryButtonsInner_ClassNames,
			)}
		>
			<PageEditorRichTextToolsHistoryUndoButton editor={editor} disabled={!canUndo} />
			<PageEditorRichTextToolsHistoryRedoButton editor={editor} disabled={!canRedo} />
		</div>
	);
});

export type PageEditorRichTextToolsHistoryButtons_Props = {
	editor: Editor;
};

export const PageEditorRichTextToolsHistoryButtons = memo(function PageEditorRichTextToolsHistoryButtons(
	props: PageEditorRichTextToolsHistoryButtons_Props,
) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = props;

	useEditorState({
		editor,
		selector: ({ editor: currentEditor }) => ({
			doc: currentEditor.state.doc,
			selection: currentEditor.state.selection,
		}),
	});

	const canUndo = editor.can().undo();
	const canRedo = editor.can().redo();

	return <PageEditorRichTextToolsHistoryButtonsInner canRedo={canRedo} canUndo={canUndo} editor={editor} />;
});
// #endregion root
