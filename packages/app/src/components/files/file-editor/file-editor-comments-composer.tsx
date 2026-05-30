import "./file-editor-comments-composer.css";
import { EditorContent, useEditor } from "@tiptap/react";
import { isNodeEmpty, type Editor, type FocusPosition } from "@tiptap/core";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Document } from "@tiptap/extension-document";
import { Text } from "@tiptap/extension-text";
import { useEffect, useState, useImperativeHandle, type Ref } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { useLiveRef } from "@/hooks/utils-hooks.ts";
import {
	files_get_tiptap_shared_extensions,
	files_tiptap_empty_doc_json,
	files_tiptap_markdown_to_json,
} from "../../../lib/files.ts";
import {
	MyInput,
	MyInputActions,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	type MyInput_Props,
} from "../../my-input.tsx";
import type { MyInputTextAreaControl_ClassNames } from "../../my-input.tsx";
import { MyIconButton, MyIconButtonIcon } from "../../my-icon-button.tsx";

// #region control
type FileEditorCommentsComposerControl_ClassNames =
	| "FileEditorCommentsComposerControl"
	| "FileEditorCommentsComposerControl-editor";

export interface FileEditorCommentsComposerControl_Ref {
	getMarkdownContent: () => string;
	clear: () => void;
	isEmpty: () => boolean;
	focus: (position?: FocusPosition) => boolean;
}

type FileEditorCommentsComposerControl_Props = {
	ref: Ref<FileEditorCommentsComposerControl_Ref>;
	className?: string;
	initialValue?: string;
	placeholder?: string;
	autoFocus?: FocusPosition;
	disabled?: boolean;
	ariaLabel: string;
	onChange?: () => void;
	onEnter?: () => void;
};

function FileEditorCommentsComposerControl(props: FileEditorCommentsComposerControl_Props) {
	const {
		ref,
		className,
		initialValue,
		placeholder,
		autoFocus = false,
		disabled = false,
		ariaLabel,
		onChange,
		onEnter,
	} = props;

	const onChangeRef = useLiveRef(onChange);
	const onEnterRef = useLiveRef(onEnter);

	const [editorProps] = useState<Parameters<typeof useEditor>[0]>(() => {
		const extensions = [
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
			files_get_tiptap_shared_extensions().markdown,
			Placeholder.configure({
				placeholder,
			}),
		];

		return {
			extensions,
			injectCSS: false,
			immediatelyRender: false,
			autofocus: autoFocus,
			editable: !disabled,
			editorProps: {
				attributes: {
					class: cn(
						"FileEditorCommentsComposerControl-editor" satisfies FileEditorCommentsComposerControl_ClassNames,
						"MyInputTextAreaControl" satisfies MyInputTextAreaControl_ClassNames,
					),
					"aria-label": ariaLabel,
				},
			},
			onUpdate: () => {
				onChangeRef.current?.();
			},
			onCreate: ({ editor }) => {
				try {
					if (!initialValue) return;

					const json = files_tiptap_markdown_to_json({
						markdown: initialValue,
						extensions,
					});

					if (json._nay) {
						console.error("[FileEditorCommentsComposerControl.onCreate] Error while setting initial value", json._nay);
						editor.commands.setContent(files_tiptap_empty_doc_json());
					} else {
						editor.commands.setContent(json._yay);
					}
				} catch (error) {
					console.error("[FileEditorCommentsComposerControl.onCreate] Failed to set initial value:", error);
				}
			},
		};
	});

	const editor = useEditor(editorProps, []);

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

	if (!editor) {
		return null;
	}

	return (
		<EditorContent
			editor={editor}
			className={cn("FileEditorCommentsComposerControl" satisfies FileEditorCommentsComposerControl_ClassNames, className)}
		/>
	);
}
// #endregion control

// #region root
export type FileEditorCommentsComposer_ClassNames = "FileEditorCommentsComposer";

export type FileEditorCommentsComposer_Props = {
	controlRef: Ref<FileEditorCommentsComposerControl_Ref>;
	variant?: MyInput_Props["variant"];
	className?: string;
	initialValue?: string;
	placeholder?: string;
	autoFocus?: FocusPosition;
	disabled?: boolean;
	submitTooltip: string;
	submitDisabled: boolean;
	ariaLabel: string;
	onChange?: () => void;
	onEnter?: () => void;
};

export function FileEditorCommentsComposer(props: FileEditorCommentsComposer_Props) {
	const {
		controlRef,
		variant,
		className,
		initialValue,
		placeholder,
		autoFocus,
		disabled,
		submitTooltip,
		submitDisabled,
		ariaLabel,
		onChange,
		onEnter,
	} = props;

	return (
		<MyInput
			variant={variant}
			className={cn("FileEditorCommentsComposer" satisfies FileEditorCommentsComposer_ClassNames, className)}
		>
			<MyInputBackground />
			<MyInputArea>
				<FileEditorCommentsComposerControl
					ref={controlRef}
					initialValue={initialValue}
					placeholder={placeholder}
					autoFocus={autoFocus}
					disabled={disabled}
					ariaLabel={ariaLabel}
					onChange={onChange}
					onEnter={onEnter}
				/>
			</MyInputArea>
			<MyInputActions>
				<MyIconButton
					type="submit"
					variant="default-embedded"
					tooltip={submitTooltip}
					disabled={submitDisabled}
				>
					<MyIconButtonIcon>
						<ArrowUp />
					</MyIconButtonIcon>
				</MyIconButton>
			</MyInputActions>
			<MyInputBox />
		</MyInput>
	);
}
// #endregion root
