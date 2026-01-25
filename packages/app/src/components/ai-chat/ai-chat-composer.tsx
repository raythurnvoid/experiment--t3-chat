import "./ai-chat-composer.css";

import type { ComponentPropsWithRef, FormEvent, PointerEvent as ReactPointerEvent, Ref } from "react";
import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { mergeAttributes, Node } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { ArrowUp, Square } from "lucide-react";

import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyInput, MyInputArea, MyInputBox } from "@/components/my-input.tsx";
import { cn } from "@/lib/utils.ts";

const ai_chat_composer_placeholder = "Send a message...";

// #region hard break extension
// Derived from `packages/app/vendor/tiptap/packages/extension-hard-break/src/hard-break.ts`
// (vendored TipTap source; keep in sync as needed)
type AiChatComposerHardBreakOptions = {
	keepMarks: boolean;
	HTMLAttributes: Record<string, unknown>;
};

const AiChatComposerHardBreak = Node.create<AiChatComposerHardBreakOptions>({
	name: "hardBreak",

	addOptions() {
		return {
			keepMarks: true,
			HTMLAttributes: {},
		};
	},

	inline: true,

	group: "inline",

	selectable: false,

	linebreakReplacement: true,

	parseHTML() {
		return [{ tag: "br" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["br", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
	},

	renderText() {
		return "\n";
	},

	addCommands() {
		return {
			setHardBreak:
				() =>
				({ commands, chain, state, editor }) => {
					return commands.first([
						() => commands.exitCode(),
						() =>
							commands.command(() => {
								const { selection, storedMarks } = state;

								if (selection.$from.parent.type.spec.isolating) {
									return false;
								}

								const { keepMarks } = this.options;
								const { splittableMarks } = editor.extensionManager;
								const marks = storedMarks || (selection.$to.parentOffset && selection.$from.marks());

								return chain()
									.insertContent({ type: this.name })
									.command(({ tr, dispatch }) => {
										if (dispatch && marks && keepMarks) {
											const filteredMarks = marks.filter((mark) => splittableMarks.includes(mark.type.name));
											tr.ensureMarks(filteredMarks);
										}

										return true;
									})
									.run();
							}),
					]);
				},
		};
	},

	addKeyboardShortcuts() {
		return {
			"Mod-Enter": () => this.editor.commands.setHardBreak(),
			"Shift-Enter": () => this.editor.commands.setHardBreak(),
		};
	},
});
// #endregion hard break extension

// #region composer
export type AiChatComposer_ClassNames =
	| "AiChatComposer"
	| "AiChatComposer-input"
	| "AiChatComposer-area"
	| "AiChatComposer-editor"
	| "AiChatComposer-editor-content"
	| "AiChatComposer-placeholder"
	| "AiChatComposer-textarea"
	| "AiChatComposer-actions"
	| "AiChatComposer-send-icon"
	| "AiChatComposer-cancel-icon";

export type AiChatComposer_Props = Omit<ComponentPropsWithRef<"form">, "onSubmit"> & {
	ref?: Ref<HTMLFormElement>;
	id?: string;
	className?: string;

	canCancel: boolean;
	isRunning: boolean;
	initialValue: string;

	onValueChange: (value: string) => void;
	onSubmit: (value: string) => void;
	onCancel: () => void;
};

export function AiChatComposer(props: AiChatComposer_Props) {
	const { ref, id, className, canCancel, isRunning, initialValue, onValueChange, onSubmit, onCancel, ...rest } = props;

	const [composerText, setComposerText] = useState(initialValue);
	const isEmpty = composerText.trim().length === 0;
	const [isFocused, setIsFocused] = useState(false);

	const canSend = !isRunning && !isEmpty;
	const canSendRef = useRef(canSend);
	const editorRef = useRef<Editor | null>(null);
	const showPlaceholder = isEmpty;

	const createDocFromText = (inputText: string) => {
		if (!inputText) {
			return { type: "doc", content: [{ type: "paragraph" }] };
		}

		const segments = inputText.split("\n");
		const content = segments.flatMap((segment, index) => {
			const nodes = [];
			if (segment.length > 0) {
				nodes.push({ type: "text", text: segment });
			}
			if (index < segments.length - 1) {
				nodes.push({ type: "hardBreak" });
			}
			return nodes;
		});

		return {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: content.length > 0 ? content : undefined,
				},
			],
		};
	};

	const getTextFromEditor = (currentEditor: Editor) => {
		return currentEditor.state.doc.textBetween(0, currentEditor.state.doc.content.size, "\n", "\n");
	};

	const handleSend = () => {
		if (!canSendRef.current) {
			return;
		}

		onSubmit(composerText);

		setComposerText("");
		canSendRef.current = false;

		const currentEditor = editorRef.current;
		if (currentEditor) {
			currentEditor.commands.setContent(createDocFromText(""), { emitUpdate: false });
		}
	};

	const handleCancel = () => {
		if (!canCancel) {
			return;
		}

		onCancel();
	};

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		handleSend();
	};

	const editor = useEditor({
		extensions: [Document, Paragraph, Text, AiChatComposerHardBreak],
		content: createDocFromText(initialValue),
		editorProps: {
			attributes: {
				class: cn("AiChatComposer-textarea" satisfies AiChatComposer_ClassNames, "MyInputTextAreaControl"),
				role: "textbox",
				"aria-multiline": "true",
				"aria-label": ai_chat_composer_placeholder,
			},
			handleKeyDown: (_view, event) => {
				if (event.isComposing || event.key !== "Enter" || event.shiftKey) {
					return false;
				}

				event.preventDefault();
				handleSend();
				return true;
			},
		},
		onUpdate: ({ editor }) => {
			const nextText = getTextFromEditor(editor);
			setComposerText(nextText);
			onValueChange(nextText);
		},
		onFocus: () => {
			setIsFocused(true);
		},
		onBlur: () => {
			setIsFocused(false);
		},
	});

	useEffect(() => {
		editorRef.current = editor;
	}, [editor]);

	const handleAreaPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!editor) {
			return;
		}

		const target = event.target as HTMLElement;
		const isEditorTarget = editor.view.dom.contains(target);
		if (isEditorTarget) {
			return;
		}

		const targetIsButton =
			target.tagName === "BUTTON" || Boolean(target.closest("button")) || target.getAttribute("role") === "button";
		const targetIsLink = target.tagName === "A" || Boolean(target.closest("a"));

		if (targetIsButton || targetIsLink) {
			return;
		}

		event.preventDefault();
		editor.commands.focus();
	};

	useEffect(() => {
		canSendRef.current = canSend;
	}, [canSend]);

	useEffect(() => {
		if (!editor) {
			return;
		}

		const editorText = getTextFromEditor(editor);
		if (editorText === initialValue) {
			return;
		}

		editor.commands.setContent(createDocFromText(initialValue), { emitUpdate: false });
	}, [editor]);

	return (
		<form
			ref={ref}
			id={id}
			className={cn("AiChatComposer" satisfies AiChatComposer_ClassNames, className)}
			onSubmit={handleSubmit}
			{...rest}
		>
			<MyInput variant="surface" className={cn("AiChatComposer-input" satisfies AiChatComposer_ClassNames)}>
				<MyInputBox />
				<MyInputArea
					className={cn("AiChatComposer-area" satisfies AiChatComposer_ClassNames)}
					focusForwarding={false}
					onPointerDown={handleAreaPointerDown}
				>
					<div className={cn("AiChatComposer-editor" satisfies AiChatComposer_ClassNames)}>
						{showPlaceholder && !isFocused && (
							<div className={cn("AiChatComposer-placeholder" satisfies AiChatComposer_ClassNames)}>
								{ai_chat_composer_placeholder}
							</div>
						)}
						<EditorContent
							editor={editor}
							className={cn("AiChatComposer-editor-content" satisfies AiChatComposer_ClassNames)}
						/>
					</div>
				</MyInputArea>
			</MyInput>
			<div className={cn("AiChatComposer-actions" satisfies AiChatComposer_ClassNames)}>
				{isRunning ? (
					<MyIconButton
						type="button"
						variant="outline"
						tooltip="Stop generating"
						onClick={handleCancel}
						disabled={!canCancel}
					>
						<Square className={cn("AiChatComposer-cancel-icon" satisfies AiChatComposer_ClassNames)} />
					</MyIconButton>
				) : (
					<MyIconButton type="submit" variant="default" tooltip="Send message" disabled={!canSend}>
						<ArrowUp className={cn("AiChatComposer-send-icon" satisfies AiChatComposer_ClassNames)} />
					</MyIconButton>
				)}
			</div>
		</form>
	);
}
// #endregion composer
