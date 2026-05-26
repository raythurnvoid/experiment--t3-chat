import "./file-editor-rich-text-tools-math-toggle.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import { SigmaIcon } from "lucide-react";
import { memo } from "react";
import { useEditorState, type Editor } from "@tiptap/react";

export type FileEditorRichTextToolsMathToggle_ClassNames =
	| "FileEditorRichTextToolsMathToggle"
	| "FileEditorRichTextToolsMathToggle-active";

export type FileEditorRichTextToolsMathToggle_Props = {
	editor: Editor;
};

type FileEditorRichTextToolsMathToggleInner_Props = FileEditorRichTextToolsMathToggle_Props & {
	isActive: boolean;
};

const FileEditorRichTextToolsMathToggleInner = memo(function FileEditorRichTextToolsMathToggleInner(
	props: FileEditorRichTextToolsMathToggleInner_Props,
) {
	const { editor, isActive } = props;

	const handleClick = useFn(() => {
		if (isActive) {
			editor.chain().focus().unsetLatex().run();
		} else {
			const { from, to } = editor.state.selection;
			const latex = editor.state.doc.textBetween(from, to);

			if (!latex) return;

			editor.chain().focus().setLatex({ latex }).run();
		}
	});

	return (
		<div className={cn("FileEditorRichTextToolsMathToggle" satisfies FileEditorRichTextToolsMathToggle_ClassNames)}>
			<MyIconButton
				variant="ghost"
				tooltip={isActive ? "Remove math formatting" : "Apply math formatting"}
				onClick={handleClick}
				className={cn(
					isActive &&
						("FileEditorRichTextToolsMathToggle-active" satisfies FileEditorRichTextToolsMathToggle_ClassNames),
				)}
			>
				<MyIconButtonIcon>
					<SigmaIcon strokeWidth={2.3} />
				</MyIconButtonIcon>
			</MyIconButton>
		</div>
	);
});

export const FileEditorRichTextToolsMathToggle = memo(function FileEditorRichTextToolsMathToggle(
	props: FileEditorRichTextToolsMathToggle_Props,
) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = props;

	// Subscribe to the derived math state so mark changes rerender immediately.
	const isActive = useEditorState({
		editor,
		selector: ({ editor }) => {
			return editor.isActive("math");
		},
	});

	return <FileEditorRichTextToolsMathToggleInner editor={editor} isActive={isActive} />;
});
