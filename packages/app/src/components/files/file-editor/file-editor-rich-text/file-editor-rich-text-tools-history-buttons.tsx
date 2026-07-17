import "./file-editor-rich-text-tools-history-buttons.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import { Redo, Undo } from "lucide-react";
import { memo } from "react";
import { useEditorState, type Editor } from "@tiptap/react";

// #region undo
export type FileEditorRichTextToolsHistoryUndoButton_ClassNames = "FileEditorRichTextToolsHistoryUndoButton";

type FileEditorRichTextToolsHistoryUndoButton_Props = {
	editor: Editor;
	disabled: boolean;
};

const FileEditorRichTextToolsHistoryUndoButton = memo(function FileEditorRichTextToolsHistoryUndoButton(
	props: FileEditorRichTextToolsHistoryUndoButton_Props,
) {
	const { editor, disabled } = props;

	const handleClick = useFn(() => {
		editor.chain().focus().undo().run();
	});

	return (
		<MyIconButton
			variant="ghost-highlightable"
			tooltip="Undo (Ctrl+Z)"
			disabled={disabled}
			onClick={handleClick}
			className={cn(
				"FileEditorRichTextToolsHistoryUndoButton" satisfies FileEditorRichTextToolsHistoryUndoButton_ClassNames,
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
export type FileEditorRichTextToolsHistoryRedoButton_ClassNames = "FileEditorRichTextToolsHistoryRedoButton";

type FileEditorRichTextToolsHistoryRedoButton_Props = {
	editor: Editor;
	disabled: boolean;
};

const FileEditorRichTextToolsHistoryRedoButton = memo(function FileEditorRichTextToolsHistoryRedoButton(
	props: FileEditorRichTextToolsHistoryRedoButton_Props,
) {
	const { editor, disabled } = props;

	const handleClick = useFn(() => {
		editor.chain().focus().redo().run();
	});

	return (
		<MyIconButton
			variant="ghost-highlightable"
			tooltip="Redo (Ctrl+Y)"
			disabled={disabled}
			onClick={handleClick}
			className={cn(
				"FileEditorRichTextToolsHistoryRedoButton" satisfies FileEditorRichTextToolsHistoryRedoButton_ClassNames,
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
export type FileEditorRichTextToolsHistoryButtonsInner_ClassNames = "FileEditorRichTextToolsHistoryButtonsInner";

type FileEditorRichTextToolsHistoryButtonsInner_Props = {
	canRedo: boolean;
	canUndo: boolean;
	editor: Editor;
};

const FileEditorRichTextToolsHistoryButtonsInner = memo(function FileEditorRichTextToolsHistoryButtonsInner(
	props: FileEditorRichTextToolsHistoryButtonsInner_Props,
) {
	const { canRedo, canUndo, editor } = props;

	return (
		<div
			className={cn(
				"FileEditorRichTextToolsHistoryButtonsInner" satisfies FileEditorRichTextToolsHistoryButtonsInner_ClassNames,
			)}
		>
			<FileEditorRichTextToolsHistoryUndoButton editor={editor} disabled={!canUndo} />
			<FileEditorRichTextToolsHistoryRedoButton editor={editor} disabled={!canRedo} />
		</div>
	);
});

export type FileEditorRichTextToolsHistoryButtons_Props = {
	editor: Editor;
};

export const FileEditorRichTextToolsHistoryButtons = memo(function FileEditorRichTextToolsHistoryButtons(
	props: FileEditorRichTextToolsHistoryButtons_Props,
) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = props;

	// Subscribe to the derived history state so availability changes rerender immediately.
	const editorState = useEditorState({
		editor,
		selector: ({ editor: currentEditor }) => ({
			canUndo: currentEditor.can().undo(),
			canRedo: currentEditor.can().redo(),
		}),
	});

	return (
		<FileEditorRichTextToolsHistoryButtonsInner
			canRedo={editorState.canRedo}
			canUndo={editorState.canUndo}
			editor={editor}
		/>
	);
});
// #endregion root
