import "./page-editor-rich-text-comment-composer.css";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
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
}

export type PageEditorRichTextCommentComposer_Props = {
	ref?: Ref<PageEditorRichTextCommentComposer_Ref>;
	className?: string;
	initialValue?: string;
	placeholder?: string;
	autoFocus?: boolean;
	disabled?: boolean;
	onChange?: (markdown: string) => void;
	onEnter?: () => void;
};

export function PageEditorRichTextCommentComposer(props: PageEditorRichTextCommentComposer_Props) {
	const {
		ref,
		className,
		initialValue,
		placeholder = "Add a comment...",
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
			immediatelyRender: false,
			autofocus: autoFocus ? "start" : false,
			editable: !disabled,
			editorProps: {
				attributes: {
					class: cn(
						"PageEditorRichTextCommentComposer-editor" satisfies PageEditorRichTextCommentComposer_ClassNames,
						"MyInputTextAreaControl" satisfies MyInputTextAreaControl_ClassNames,
					),
				},
			},
			onUpdate: ({ editor }) => {
				const markdown = editor.getMarkdown();
				onChangeRef.current?.(markdown);
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
	}));

	return (
		editor && (
			<div
				className={cn(
					"PageEditorRichTextCommentComposer" satisfies PageEditorRichTextCommentComposer_ClassNames,
					className,
				)}
			>
				<EditorContent editor={editor} />
			</div>
		)
	);
}
