import "./page-editor-rich-text-tools-math-toggle.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { cn } from "@/lib/utils.ts";
import { SigmaIcon } from "lucide-react";
import { EditorBubbleItem, useEditor } from "novel";
import { useEditorState } from "@tiptap/react";

export type PageEditorRichTextToolsMathToggle_ClassNames =
	| "PageEditorRichTextToolsMathToggle"
	| "PageEditorRichTextToolsMathToggle-active";

export function PageEditorRichTextToolsMathToggle() {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = useEditor();

	// Subscribe to editor state changes to trigger re-renders when selection changes
	useEditorState({
		editor,
		selector: ({ editor }) => {
			if (!editor) return null;
			return {
				selection: editor.state.selection,
			};
		},
	});

	if (!editor) return null;

	const isActive = editor.isActive("math");

	const handleClick = () => {
		if (isActive) {
			editor.chain().focus().unsetLatex().run();
		} else {
			const { from, to } = editor.state.selection;
			const latex = editor.state.doc.textBetween(from, to);

			if (!latex) return;

			editor.chain().focus().setLatex({ latex }).run();
		}
	};

	return (
		<div className={cn("PageEditorRichTextToolsMathToggle" satisfies PageEditorRichTextToolsMathToggle_ClassNames)}>
			<EditorBubbleItem onSelect={handleClick}>
				<MyIconButton
					variant="ghost"
					tooltip="Math"
					className={cn(
						isActive &&
							("PageEditorRichTextToolsMathToggle-active" satisfies PageEditorRichTextToolsMathToggle_ClassNames),
					)}
				>
					<MyIconButtonIcon>
						<SigmaIcon strokeWidth={2.3} />
					</MyIconButtonIcon>
				</MyIconButton>
			</EditorBubbleItem>
		</div>
	);
}
