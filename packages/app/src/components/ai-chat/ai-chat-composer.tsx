import "./ai-chat-composer.css";

import type {
	ChangeEvent,
	ComponentPropsWithRef,
	FormEvent,
	MouseEvent,
	PointerEvent as ReactPointerEvent,
	Ref,
} from "react";
import { useEffect, useId, useRef, useState } from "react";
import { ComposerAttachmentByIndexProvider, useAssistantApi, useAssistantState } from "@assistant-ui/react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { mergeAttributes, Node } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { ArrowUp, FileText, Paperclip, Square, X } from "lucide-react";

import { MyAvatar, MyAvatarFallback, MyAvatarImage } from "@/components/my-avatar.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyInput, MyInputArea, MyInputBox } from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalHeader,
	MyModalPopover,
	MyModalScrollableArea,
	MyModalTrigger,
} from "@/components/my-modal.tsx";
import { MySpinner } from "@/components/ui/my-spinner.tsx";
import { cn } from "@/lib/utils.ts";

const ai_chat_attachment_preview_max_height = 520;
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

// #region composer attachments
export type AiChatComposerAttachments_ClassNames = "AiChatComposerAttachments" | "AiChatComposerAttachments-item";

export type AiChatComposerAttachments_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
};

function AiChatComposerAttachments(props: AiChatComposerAttachments_Props) {
	const { ref, id, className, ...rest } = props;
	const attachmentCount = useAssistantState(({ composer }) => composer.attachments.length);
	const attachmentIndices = Array.from({ length: attachmentCount }, (_, index) => index);

	if (attachmentCount === 0) {
		return null;
	}

	return (
		<div
			ref={ref}
			id={id}
			className={cn("AiChatComposerAttachments" satisfies AiChatComposerAttachments_ClassNames, className)}
			{...rest}
		>
			{attachmentIndices.map((index) => (
				<ComposerAttachmentByIndexProvider key={index} index={index}>
					<div className={cn("AiChatComposerAttachments-item" satisfies AiChatComposerAttachments_ClassNames)}>
						<AiChatAttachmentTile />
					</div>
				</ComposerAttachmentByIndexProvider>
			))}
		</div>
	);
}
// #endregion composer attachments

// #region composer attachment add button
export type AiChatComposerAttachmentAddButton_ClassNames =
	| "AiChatComposerAttachmentAddButton"
	| "AiChatComposerAttachmentAddButton-input"
	| "AiChatComposerAttachmentAddButton-icon";

export type AiChatComposerAttachmentAddButton_Props = ComponentPropsWithRef<"div"> & {
	ref?: Ref<HTMLDivElement>;
	id?: string;
	className?: string;
};

function AiChatComposerAttachmentAddButton(props: AiChatComposerAttachmentAddButton_Props) {
	const { ref, id, className, ...rest } = props;
	const api = useAssistantApi();
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement | null>(null);
	const accept = useAssistantState(({ composer }) => composer.attachmentAccept);

	const handleSelectFiles = () => {
		inputRef.current?.click();
	};

	const handleFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
		const { files } = event.currentTarget;
		if (!files || files.length === 0) {
			return;
		}

		Array.from(files).forEach((file) => {
			api
				.composer()
				.addAttachment(file)
				.catch((error) => {
					console.error("Failed to add attachment:", error);
				});
		});

		event.currentTarget.value = "";
	};

	return (
		<div
			ref={ref}
			id={id}
			className={cn(
				"AiChatComposerAttachmentAddButton" satisfies AiChatComposerAttachmentAddButton_ClassNames,
				className,
			)}
			{...rest}
		>
			<MyIconButton type="button" variant="ghost" tooltip="Add attachment" onClick={handleSelectFiles}>
				<Paperclip
					className={cn(
						"AiChatComposerAttachmentAddButton-icon" satisfies AiChatComposerAttachmentAddButton_ClassNames,
					)}
				/>
			</MyIconButton>
			<input
				id={inputId}
				ref={inputRef}
				type="file"
				multiple
				accept={accept}
				className={cn("AiChatComposerAttachmentAddButton-input" satisfies AiChatComposerAttachmentAddButton_ClassNames)}
				onChange={handleFilesChange}
			/>
		</div>
	);
}
// #endregion composer attachment add button

// #region attachment tile
export type AiChatAttachmentTile_ClassNames =
	| "AiChatAttachmentTile"
	| "AiChatAttachmentTile-preview"
	| "AiChatAttachmentTile-avatar"
	| "AiChatAttachmentTile-fallback-icon"
	| "AiChatAttachmentTile-name"
	| "AiChatAttachmentTile-remove"
	| "AiChatAttachmentTile-remove-icon"
	| "AiChatAttachmentTile-spinner"
	| "AiChatAttachmentTile-modal"
	| "AiChatAttachmentTile-modal-header"
	| "AiChatAttachmentTile-modal-title"
	| "AiChatAttachmentTile-modal-image";

export function AiChatAttachmentTile() {
	const api = useAssistantApi();
	const type = useAssistantState(({ attachment }) => attachment.type);
	const name = useAssistantState(({ attachment }) => attachment.name);
	const statusType = useAssistantState(({ attachment }) => attachment.status.type);
	const previewSrc = useAttachmentPreviewSrc();
	const isComposer = api.attachment.source === "composer";
	const isImage = type === "image";

	const handleRemove = (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		event.preventDefault();
		api
			.attachment()
			.remove()
			.catch((error) => {
				console.error("Failed to remove attachment:", error);
			});
	};

	const preview = (
		<div className={cn("AiChatAttachmentTile-preview" satisfies AiChatAttachmentTile_ClassNames)}>
			<MyAvatar className={cn("AiChatAttachmentTile-avatar" satisfies AiChatAttachmentTile_ClassNames)} size="48px">
				<MyAvatarImage src={previewSrc} alt={name} />
				<MyAvatarFallback>
					<FileText className={cn("AiChatAttachmentTile-fallback-icon" satisfies AiChatAttachmentTile_ClassNames)} />
				</MyAvatarFallback>
			</MyAvatar>
			<div className={cn("AiChatAttachmentTile-name" satisfies AiChatAttachmentTile_ClassNames)}>{name}</div>
			{statusType === "running" && (
				<MySpinner
					className={cn("AiChatAttachmentTile-spinner" satisfies AiChatAttachmentTile_ClassNames)}
					size="16px"
				/>
			)}
		</div>
	);

	return (
		<div className={cn("AiChatAttachmentTile" satisfies AiChatAttachmentTile_ClassNames)}>
			{isImage && previewSrc ? (
				<MyModal>
					<MyModalTrigger>{preview}</MyModalTrigger>
					<MyModalPopover className={cn("AiChatAttachmentTile-modal" satisfies AiChatAttachmentTile_ClassNames)}>
						<MyModalHeader
							className={cn("AiChatAttachmentTile-modal-header" satisfies AiChatAttachmentTile_ClassNames)}
						>
							<div className={cn("AiChatAttachmentTile-modal-title" satisfies AiChatAttachmentTile_ClassNames)}>
								{name}
							</div>
							<MyModalCloseTrigger />
						</MyModalHeader>
						<MyModalScrollableArea>
							<img
								className={cn("AiChatAttachmentTile-modal-image" satisfies AiChatAttachmentTile_ClassNames)}
								src={previewSrc}
								alt={name}
								style={{ maxHeight: `${ai_chat_attachment_preview_max_height}px` }}
							/>
						</MyModalScrollableArea>
					</MyModalPopover>
				</MyModal>
			) : (
				preview
			)}
			{isComposer && (
				<MyIconButton
					variant="ghost"
					tooltip="Remove attachment"
					onClick={handleRemove}
					className={cn("AiChatAttachmentTile-remove" satisfies AiChatAttachmentTile_ClassNames)}
				>
					<X className={cn("AiChatAttachmentTile-remove-icon" satisfies AiChatAttachmentTile_ClassNames)} />
				</MyIconButton>
			)}
		</div>
	);
}
// #endregion attachment tile

// #region attachment preview src
function useAttachmentPreviewSrc() {
	const file = useAssistantState(({ attachment }) => attachment.file);
	const imageContent = useAssistantState(({ attachment }) => {
		const content = attachment.content;
		const imagePart = content?.find((part) => part.type === "image");
		return imagePart?.image;
	});
	const [src, setSrc] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (file) {
			const objectUrl = URL.createObjectURL(file);
			setSrc(objectUrl);
			return () => URL.revokeObjectURL(objectUrl);
		}

		setSrc(imageContent);
		return undefined;
	}, [file, imageContent]);

	return src;
}
// #endregion attachment preview src

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

export type AiChatComposer_Props = ComponentPropsWithRef<"form"> & {
	ref?: Ref<HTMLFormElement>;
	id?: string;
	className?: string;
};

export function AiChatComposer(props: AiChatComposer_Props) {
	const { ref, id, className, ...rest } = props;
	const api = useAssistantApi();
	const text = useAssistantState(({ composer }) => composer.text);
	const isEmpty = useAssistantState(({ composer }) => composer.isEmpty);
	const canCancel = useAssistantState(({ composer }) => composer.canCancel);
	const isRunning = useAssistantState(({ thread }) => thread.isRunning);
	const [isFocused, setIsFocused] = useState(false);

	const canSend = !isRunning && !isEmpty;
	const canSendRef = useRef(canSend);
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

		api.composer().send();
	};

	const handleCancel = () => {
		if (!canCancel) {
			return;
		}

		api.thread().cancelRun();
	};

	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		handleSend();
	};

	const editor = useEditor({
		extensions: [Document, Paragraph, Text, AiChatComposerHardBreak],
		content: createDocFromText(text),
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
			api.composer().setText(nextText);
		},
		onFocus: () => {
			setIsFocused(true);
		},
		onBlur: () => {
			setIsFocused(false);
		},
	});

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
		if (editorText === text) {
			return;
		}

		editor.commands.setContent(createDocFromText(text), { emitUpdate: false });
	}, [editor, text]);

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
					<AiChatComposerAttachments />
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
				<AiChatComposerAttachmentAddButton />
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
