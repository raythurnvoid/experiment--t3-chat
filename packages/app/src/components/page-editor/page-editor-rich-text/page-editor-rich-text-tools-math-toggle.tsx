import "./page-editor-rich-text-tools-math-toggle.css";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { cn } from "@/lib/utils.ts";
import { SigmaIcon } from "lucide-react";
import { memo } from "react";
import { useEditorState, type Editor } from "@tiptap/react";

export type PageEditorRichTextToolsMathToggle_ClassNames =
	| "PageEditorRichTextToolsMathToggle"
	| "PageEditorRichTextToolsMathToggle-active";

export type PageEditorRichTextToolsMathToggle_Props = {
	editor: Editor;
};

type PageEditorRichTextToolsMathToggleInner_Props = PageEditorRichTextToolsMathToggle_Props & {
	isActive: boolean;
};

const PageEditorRichTextToolsMathToggleInner = memo(function PageEditorRichTextToolsMathToggleInner(
	props: PageEditorRichTextToolsMathToggleInner_Props,
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
});

export const PageEditorRichTextToolsMathToggle = memo(function PageEditorRichTextToolsMathToggle(
	props: PageEditorRichTextToolsMathToggle_Props,
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

	return <PageEditorRichTextToolsMathToggleInner editor={editor} isActive={isActive} />;
});
