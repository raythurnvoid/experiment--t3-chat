import "./page-editor-rich-text-comment-composer.css";
import { EditorContent, useEditor } from "@tiptap/react";
import { isNodeEmpty, type Editor, type FocusPosition } from "@tiptap/core";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Document } from "@tiptap/extension-document";
import { Text } from "@tiptap/extension-text";
import { useEffect, useState, useImperativeHandle, type Ref } from "react";
import { cn } from "@/lib/utils.ts";
import { useLiveRef } from "@/hooks/utils-hooks.ts";
import { pages_get_tiptap_shared_extensions } from "../../../lib/pages.ts";
import type { MyInputTextAreaControl_ClassNames } from "../../my-input.tsx";

export type PageEditorRichTextCommentComposer_ClassNames =
	| "PageEditorRichTextCommentComposer"
	| "PageEditorRichTextCommentComposer-editor"
	| "PageEditorRichTextCommentComposer-empty-editor";

export interface PageEditorRichTextCommentComposer_Ref {
	getMarkdownContent: () => string;
	clear: () => void;
	isEmpty: () => boolean;
	focus: (position?: FocusPosition) => boolean;
}

export type PageEditorRichTextCommentComposer_Props = {
	ref?: Ref<PageEditorRichTextCommentComposer_Ref>;
	className?: string;
	initialValue?: string;
	placeholder?: string;
	autoFocus?: FocusPosition;
	disabled?: boolean;
	onChange?: () => void;
	onEnter?: () => void;
};

export function PageEditorRichTextCommentComposer(props: PageEditorRichTextCommentComposer_Props) {
	const {
		ref,
		className,
		initialValue,
		placeholder = "Add a comment",
		autoFocus = false,
		disabled = false,
		onChange,
		onEnter,
	} = props;

	const onChangeRef = useLiveRef(onChange);
	const onEnterRef = useLiveRef(onEnter);

	const [editorProps] = useState<Parameters<typeof useEditor>[0]>(() => {
		return {
			extensions: [
				Document,
				Text,
				Paragraph.extend({
					addKeyboardShortcuts() {
						return {
							// Prevent Enter to create a new paragraph
							Enter: () => {
								onEnterRef.current?.();
								return true;
							},

							// Add new paragraph on Shift + Enter
							"Shift-Enter": ({ editor }: { editor: Editor }) => {
								// Implementation from tiptap's Keymap extension
								editor.commands.first(({ commands }) => [
									() => commands.newlineInCode(),
									() => commands.createParagraphNear(),
									() => commands.liftEmptyBlock(),
									() => commands.splitBlock(),
								]);

								return true;
							},
						};
					},
				}),
				pages_get_tiptap_shared_extensions().markdown,
				Placeholder.configure({
					placeholder,
					emptyEditorClass:
						"PageEditorRichTextCommentComposer-empty-editor" satisfies PageEditorRichTextCommentComposer_ClassNames,
				}),
			],
			injectCSS: false,
			immediatelyRender: false,
			autofocus: autoFocus,
			editable: !disabled,
			editorProps: {
				attributes: {
					class: cn(
						"PageEditorRichTextCommentComposer-editor" satisfies PageEditorRichTextCommentComposer_ClassNames,
						"MyInputTextAreaControl" satisfies MyInputTextAreaControl_ClassNames,
					),
					"aria-label": placeholder,
				},
			},
			onUpdate: () => {
				onChangeRef.current?.();
			},
			onCreate: ({ editor }) => {
				try {
					if (!initialValue || !editor.markdown) return;
					editor.commands.setContent(editor.markdown.parse(initialValue));
				} catch (error) {
					console.error("Failed to parse initialValue markdown:", error);
					return undefined;
				}
			},
		};
	});

	const editor = useEditor(editorProps, []);

	// Update disabled state
	useEffect(() => {
		if (editor) {
			editor.setEditable(!disabled, false);
		}
	}, [editor, disabled]);

	useImperativeHandle(ref, () => ({
		getMarkdownContent: () => editor?.getMarkdown() ?? "",
		clear: () => void editor?.commands.clearContent(),
		isEmpty: () => {
			if (!editor) return true;
			return isNodeEmpty(editor.state.doc, { ignoreWhitespace: true });
		},
		focus: (position = "end") => {
			if (!editor) return false;
			editor.commands.focus(position);
			return true;
		},
	}));

	return (
		<div
			className={cn(
				"PageEditorRichTextCommentComposer" satisfies PageEditorRichTextCommentComposer_ClassNames,
				className,
			)}
		>
			{editor && <EditorContent editor={editor} />}
		</div>
	);
}
