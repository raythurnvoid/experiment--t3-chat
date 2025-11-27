import "./page-editor-rich-text-tools-math-toggle.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { cn } from "@/lib/utils.ts";
import { SigmaIcon } from "lucide-react";
import { useEditorState, type Editor } from "@tiptap/react";

export type PageEditorRichTextToolsMathToggle_ClassNames =
	| "PageEditorRichTextToolsMathToggle"
	| "PageEditorRichTextToolsMathToggle-active";

export type PageEditorRichTextToolsMathToggle_Props = {
	editor: Editor;
};

export function PageEditorRichTextToolsMathToggle(props: PageEditorRichTextToolsMathToggle_Props) {
	// Required to allow re-renders to access latest values via tiptap functions
	"use no memo";

	const { editor } = props;

	// Subscribe to editor state changes to trigger re-renders when selection changes
	useEditorState({
		editor,
		selector: ({ editor }) => {
			return {
				selection: editor.state.selection,
			};
		},
	});

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
			<MyIconButton
				variant="ghost"
				tooltip="Math"
				onClick={handleClick}
				className={cn(
					isActive &&
						("PageEditorRichTextToolsMathToggle-active" satisfies PageEditorRichTextToolsMathToggle_ClassNames),
				)}
			>
				<MyIconButtonIcon>
					<SigmaIcon strokeWidth={2.3} />
				</MyIconButtonIcon>
			</MyIconButton>
		</div>
	);
}
