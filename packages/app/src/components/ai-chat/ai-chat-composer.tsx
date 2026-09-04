// The composer is a plain text input. User messages must never be changed:
// no markdown parsing. The message is stored as one string, so the editor
// keeps all content in one paragraph where every newline is a hard break
// (a hard break = one "\n" in the string).

import "./ai-chat-composer.css";

import type { ComponentPropsWithRef, DragEvent, Ref } from "react";
import { memo, useEffect, useRef, useState } from "react";
import type { ExtractStrict } from "type-fest";
import type { FileUIPart } from "ai";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import Document from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import Placeholder from "@tiptap/extension-placeholder";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { ArrowUp, Check, Plus, Square, X } from "lucide-react";
import { toast } from "sonner";
import { Result } from "common/errors-as-values-utils.ts";

import { MyButton } from "@/components/my-button.tsx";
import { MyChip, MyChipLabel, MyChipMedia, MyChipRemove, MyChipRow } from "@/components/my-chip.tsx";
import {
	ai_chat_composer_file_mention_create_extension,
	ai_chat_composer_file_mention_PLUGIN_KEY,
} from "@/components/ai-chat/ai-chat-composer-file-mention.tsx";
import {
	MySelect,
	MySelectItem,
	MySelectItemIndicator,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectPopoverScrollableArea,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	type MyInputArea_Props,
	type MyInputControl_ClassNames,
} from "@/components/my-input.tsx";
import {
	MySearchSelect,
	MySearchSelectItem,
	MySearchSelectList,
	MySearchSelectPopover,
	MySearchSelectPopoverContent,
	MySearchSelectPopoverScrollableArea,
	MySearchSelectSearch,
	MySearchSelectTrigger,
} from "@/components/my-search-select.tsx";
import { cn, forward_ref } from "@/lib/utils.ts";
import { files_tiptap_empty_doc_json } from "@/lib/files.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { useUiInteractedOutside } from "@/lib/ui.tsx";
import { useLiveRef } from "@/hooks/utils-hooks.ts";
import {
	ai_chat_MESSAGE_IMAGE_MAX_COUNT,
	ai_chat_MESSAGE_IMAGE_MAX_TOTAL_URL_CHARS,
	ai_chat_MESSAGE_IMAGE_MEDIA_TYPES,
	ai_chat_MODEL_IDS,
	ai_chat_MODELS,
	ai_chat_MODE_IDS,
	ai_chat_MODE_METADATA,
	ai_chat_is_message_image_media_type,
	type ai_chat_ModelId,
	type ai_chat_ModeId,
} from "@/lib/ai-chat.ts";

export type AiChatComposer_ClassNames =
	| "AiChatComposer"
	| "AiChatComposer-state-drop-target"
	| "AiChatComposer-editor"
	| "AiChatComposer-editor-area"
	| "AiChatComposer-editor-content-container"
	| "AiChatComposer-editor-content"
	| "AiChatComposer-attachments"
	| "AiChatComposer-actions"
	| "AiChatComposer-configurations"
	| "AiChatComposer-configurations-attach"
	| "AiChatComposer-configurations-attach-icon"
	| "AiChatComposer-send-icon"
	| "AiChatComposer-save-icon"
	| "AiChatComposer-cancel-icon";

/** Matches Windows (`\r\n`) and old Mac (`\r`) line endings. */
const CR_LINE_ENDING_REGEX = /\r\n?/g;

/**
 * Serialize the editor content to plain text.
 *
 * One editor line (paragraph or hard break) = one "\n".
 */
function get_composer_plain_text(editor: Editor) {
	return editor.getText({ blockSeparator: "\n" });
}

/**
 * Convert plain text to Tiptap JSON.
 *
 * One paragraph for the whole text; every newline becomes a hard break.
 */
function convert_plain_text_to_tiptap_json(text: string): JSONContent {
	if (!text) {
		return files_tiptap_empty_doc_json();
	}

	const content: JSONContent[] = [];
	for (const [index, line] of text.split("\n").entries()) {
		if (index > 0) {
			content.push({ type: "hardBreak" });
		}
		if (line) {
			content.push({ type: "text", text: line });
		}
	}

	return { type: "doc", content: [{ type: "paragraph", content }] };
}

type AiChatComposerAttachment = {
	key: string;
	part: FileUIPart;
};

/** Long-edge cap so huge photos and 4K screenshots shrink before encoding. */
const ATTACHMENT_IMAGE_MAX_DIMENSION_PX = 2048;
const ATTACHMENT_IMAGE_COMPRESSION_QUALITY = 0.8;

const next_attachment_key = ((/* iife */) => {
	let currentKey = 0;

	return function next_attachment_key() {
		currentKey += 1;
		return `attachment-${currentKey}`;
	};
})();

async function canvas_to_blob(canvas: HTMLCanvasElement, type: string) {
	return await new Promise<Blob | null>((resolve) => {
		canvas.toBlob(resolve, type, ATTACHMENT_IMAGE_COMPRESSION_QUALITY);
	});
}

async function read_blob_as_data_url(blob: Blob) {
	return await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error ?? new Error("Failed to read image data"));
		reader.readAsDataURL(blob);
	});
}

/**
 * Turn a pasted or dropped image file into a data-URL file part.
 *
 * The data URL is stored inside the chat message document, so the image is
 * downscaled and re-encoded to stay small. GIFs pass through untouched to
 * keep animation.
 */
async function prepare_attachment_file_part(file: File) {
	if (!ai_chat_is_message_image_media_type(file.type)) {
		return Result({
			_nay: {
				name: "nay",
				message: "Only PNG, JPEG, WebP, and GIF images can be attached",
			},
		});
	}

	let blob: Blob = file;
	if (file.type !== "image/gif") {
		let imageBitmap: ImageBitmap | null = null;
		try {
			// Use browser-native decoding/resampling, like the files upload path,
			// so no client-side encoder dependency is needed.
			imageBitmap = await createImageBitmap(file);
			const scale = Math.min(1, ATTACHMENT_IMAGE_MAX_DIMENSION_PX / Math.max(imageBitmap.width, imageBitmap.height));

			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(imageBitmap.width * scale));
			canvas.height = Math.max(1, Math.round(imageBitmap.height * scale));
			const context = canvas.getContext("2d");
			if (context) {
				context.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
				// WebP keeps transparency and compresses screenshots well; JPEG is
				// the fallback when the browser cannot encode WebP.
				const compressedBlob =
					(await canvas_to_blob(canvas, "image/webp")) ?? (await canvas_to_blob(canvas, "image/jpeg"));
				// Keep the original when it was not downscaled and compression is not a strict win.
				if (compressedBlob && (scale < 1 || compressedBlob.size < file.size)) {
					blob = compressedBlob;
				}
			}
		} catch (error) {
			console.warn("[AiChatComposer.prepare_attachment_file_part] Failed to compress image attachment", { error });
		} finally {
			imageBitmap?.close();
		}
	}

	const url = await read_blob_as_data_url(blob);
	return Result({
		_yay: {
			type: "file",
			mediaType: blob.type || file.type,
			...(file.name ? { filename: file.name } : {}),
			url,
		} satisfies FileUIPart,
	});
}

function drag_event_has_files(event: DragEvent<HTMLFormElement>) {
	return Array.from(event.dataTransfer.types).includes("Files");
}

export type AiChatComposer_Props = Omit<
	ComponentPropsWithRef<"form">,
	ExtractStrict<keyof ComponentPropsWithRef<"form">, "onSubmit">
> & {
	ref?: Ref<HTMLFormElement>;
	id?: string;
	className?: string;

	autoFocus?: boolean;
	canCancel: boolean;
	canQueue: boolean;
	canSend: boolean;
	isQueueing: boolean;
	isQueueEditing?: boolean;
	isRunning: boolean;
	initialValue: string;
	/** Image attachments to start with: a saved draft or a message being edited. */
	initialAttachments?: readonly FileUIPart[];
	inputLabel?: string;
	submitLabel?: string;
	selectedModelId: ai_chat_ModelId;
	selectedModeId: ai_chat_ModeId;

	onValueChange?: (value: string) => void;
	onAttachmentsChange?: (attachments: FileUIPart[]) => void;
	onSelectedModelIdChange: (value: ai_chat_ModelId) => void;
	onSelectedModeIdChange: (value: ai_chat_ModeId) => void;
	/**
	 * Return `false` to keep the composer text when the message was rejected,
	 * for example when another surface filled the queue first.
	 */
	onSubmit: (value: string, attachments: FileUIPart[]) => boolean | void;
	onCancel?: () => void;
	onInteractedOutside?: (event: FocusEvent | PointerEvent) => void;
	onClose?: () => void;
};

export const AiChatComposer = memo(function AiChatComposer(props: AiChatComposer_Props) {
	const {
		ref,
		id,
		className,
		autoFocus,
		canCancel,
		canQueue,
		canSend: canSendProp,
		isQueueing,
		isQueueEditing = false,
		isRunning,
		initialValue,
		initialAttachments,
		inputLabel,
		submitLabel,
		selectedModelId,
		selectedModeId,
		onValueChange,
		onAttachmentsChange,
		onSelectedModelIdChange,
		onSelectedModeIdChange,
		onSubmit,
		onCancel,
		onInteractedOutside,
		onClose,
		onKeyDown,
		...rest
	} = props;

	const placeholder = "Send a message...";
	const textboxLabel = inputLabel ?? placeholder;
	const submitActionLabel = submitLabel ?? (isQueueing ? "Queue message" : "Send message");
	const onCloseRef = useLiveRef(onClose);

	const rootRef = useRef<HTMLFormElement | null>(null);
	const editorRef = useRef<Editor | null>(null);
	/** Pending debounce timer for syncing the editor text into React state. */
	const composerSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** Mirror of `composerText` so editor callbacks can read the latest value. */
	const composerTextRef = useRef(initialValue);

	const [composerText, setComposerText] = useState(initialValue);
	const isEmpty = composerText.trim().length === 0;

	const [attachments, setAttachments] = useState<AiChatComposerAttachment[]>(() =>
		(initialAttachments ?? []).map((part) => ({ key: next_attachment_key(), part })),
	);
	/** Mirror of `attachments` so async image processing can read the latest list. */
	const attachmentsRef = useRef(attachments);
	/** Images still being decoded and compressed; they are not in `attachments` yet. */
	const [pendingAttachmentCount, setPendingAttachmentCount] = useState(0);
	const [isDropTarget, setIsDropTarget] = useState(false);
	/** Drag enter/leave fire for every child element; count them to know when the drag really left. */
	const dragDepthRef = useRef(0);
	/** Hidden file input behind the attachments-bar plus button. */
	const attachmentsFileInputRef = useRef<HTMLInputElement | null>(null);
	const hasAttachments = attachments.length > 0;

	/**
	 * The "@" mention popup element while it is open. Held in state so the
	 * outside-interaction hook below re-reads `allowedAreas` with the popup
	 * included; the popup mounts through a portal without re-rendering the
	 * composer, so a ref would go stale.
	 */
	const [mentionPopupElement, setMentionPopupElement] = useState<HTMLElement | null>(null);

	const [modelFilter, setModelFilter] = useState("");
	const [enableInteractedOutside, setEnableInteractedOutside] = useState(false);
	const modelFilterValue = modelFilter.trim().toLowerCase();
	const selectedModelLabel = ai_chat_MODELS[selectedModelId].label;
	const filteredModels = modelFilterValue
		? ai_chat_MODEL_IDS.filter((modelItem) => {
				const modelLabel = ai_chat_MODELS[modelItem].label;
				return (
					modelItem.toLowerCase().includes(modelFilterValue) || modelLabel.toLowerCase().includes(modelFilterValue)
				);
			})
		: ai_chat_MODEL_IDS;

	// An image-only message is a valid send; attachments count as content.
	// Block submit while an image is still being prepared, so a fast Enter
	// right after a paste cannot send the message without its image.
	const canSubmit =
		(isQueueing ? canQueue : canSendProp) && (!isEmpty || hasAttachments) && pendingAttachmentCount === 0;
	const isStopAction = isRunning && !isQueueEditing && isEmpty && !hasAttachments;

	/** Store the current text and notify the parent (used for drafts). */
	const syncComposerText = (value: string) => {
		composerTextRef.current = value;
		setComposerText(value);
		onValueChange?.(value);
	};

	/** Store the current attachments and notify the parent (used for drafts and queue edits). */
	const syncAttachments = (next: AiChatComposerAttachment[]) => {
		attachmentsRef.current = next;
		setAttachments(next);
		onAttachmentsChange?.(next.map((item) => item.part));
	};

	const addAttachmentFiles = (files: File[]) => {
		setPendingAttachmentCount((count) => count + files.length);
		for (const file of files) {
			prepare_attachment_file_part(file)
				.then((result) => {
					if (result._nay) {
						toast.error(result._nay.message);
						return;
					}

					const current = attachmentsRef.current;
					if (current.length >= ai_chat_MESSAGE_IMAGE_MAX_COUNT) {
						toast.error(`You can attach up to ${ai_chat_MESSAGE_IMAGE_MAX_COUNT} images per message`);
						return;
					}
					const totalUrlChars = current.reduce((total, item) => total + item.part.url.length, 0);
					if (totalUrlChars + result._yay.url.length > ai_chat_MESSAGE_IMAGE_MAX_TOTAL_URL_CHARS) {
						toast.error("Image is too large to attach to this message");
						return;
					}

					syncAttachments([...current, { key: next_attachment_key(), part: result._yay }]);
				})
				.catch((error: unknown) => {
					console.error("[AiChatComposer.addAttachmentFiles] Unexpected error preparing image attachment", {
						error,
						fileName: file.name,
						fileType: file.type,
					});
					toast.error("Failed to attach image");
				})
				.finally(() => {
					setPendingAttachmentCount((count) => count - 1);
				});
		}
	};
	const addAttachmentFilesRef = useLiveRef(addAttachmentFiles);

	const removeAttachment = (key: string, focusEditor: boolean) => {
		syncAttachments(attachmentsRef.current.filter((item) => item.key !== key));
		// A pointer removal returns to typing. A keyboard removal keeps focus in
		// the chip row (MyChipRow moves it to a neighbor chip and falls back to
		// handleAttachmentsFocusExit).
		if (focusEditor) {
			editorRef.current?.commands.focus();
		}
	};

	const handleAttachmentsFocusExit = () => {
		editorRef.current?.commands.focus();
	};

	const handleAttachmentsAddClick = () => {
		attachmentsFileInputRef.current?.click();
	};

	const handleAttachmentsFileInputChange: ComponentPropsWithRef<"input">["onChange"] = (event) => {
		const files = Array.from(event.currentTarget.files ?? []);
		// Clear the value so picking the same file again still fires `change`.
		event.currentTarget.value = "";
		if (files.length > 0) {
			addAttachmentFiles(files);
		}
	};

	/**
	 * Editor config, created once. Only plain text extensions: paragraphs,
	 * text, and hard breaks (Shift+Enter). No marks, no markdown.
	 */
	const [editorProps] = useState<Parameters<typeof useEditor>[0]>(() => {
		const extensions = [
			Document,
			Paragraph,
			Text,
			HardBreak,
			Placeholder.configure({
				placeholder,
			}),
			// `setMentionPopupElement` has a stable identity, so capturing it in
			// this one-time config is safe.
			ai_chat_composer_file_mention_create_extension({ onPopupElementChange: setMentionPopupElement }),
		];

		return {
			autofocus: false,
			injectCSS: false,
			extensions,
			content: files_tiptap_empty_doc_json(),
			editorProps: {
				attributes: {
					class: cn(
						"app-doc" satisfies AppClassName,
						"AiChatComposer-editor-content" satisfies AiChatComposer_ClassNames,
						"MyInputControl" satisfies MyInputControl_ClassNames,
					),
					role: "textbox",
					"aria-multiline": "true",
					"aria-label": textboxLabel,
				},
				// The default ProseMirror plain-text paste collapses consecutive
				// newlines, dropping empty lines. Paste every newline as a hard
				// break instead, keeping the whole text in one paragraph.
				clipboardTextParser: (text, _$context, _plain, view) => {
					const schema = view.state.schema;
					const inline = [];
					for (const [index, line] of text.replace(CR_LINE_ENDING_REGEX, "\n").split("\n").entries()) {
						if (index > 0) {
							inline.push(schema.nodes.hardBreak.create());
						}
						if (line) {
							inline.push(schema.text(line));
						}
					}
					return Slice.maxOpen(Fragment.fromArray([schema.nodes.paragraph.createChecked(null, inline)]));
				},
				// Attach pasted images (e.g. screenshots). When the clipboard carries
				// real text too (spreadsheet cells copy as text plus an image render),
				// prefer the text and let the normal text paste run. Some apps put only
				// whitespace in text/plain when copying an image, so trim before deciding.
				handlePaste: (_view, event) => {
					const clipboardData = event.clipboardData;
					if (!clipboardData || clipboardData.files.length === 0 || clipboardData.getData("text/plain").trim()) {
						return false;
					}

					event.preventDefault();
					addAttachmentFilesRef.current(Array.from(clipboardData.files));
					return true;
				},
				handleKeyDown: (view, event) => {
					if (event.isComposing) {
						return false;
					}

					// While the "@" mention popup is open, its suggestion plugin owns
					// Enter, Escape, and the arrow keys. These view props run before
					// plugin handlers, so yield here and let the plugin forward the
					// key to the popup. The popup's renderer stops the native Escape
					// so it only closes the popup and never reaches outer handlers.
					if (
						(event.key === "Enter" || event.key === "Escape" || event.key === "ArrowUp" || event.key === "ArrowDown") &&
						Boolean(ai_chat_composer_file_mention_PLUGIN_KEY.getState(view.state)?.active)
					) {
						return false;
					}

					if (event.key === "Escape") {
						event.preventDefault();
						onCloseRef.current?.();
						return true;
					}

					// Mark a state to indicate the selection is either at the start or end of the document.
					// when pressing arrow up or down.
					if (event.key === "ArrowUp") {
						const selection = view.state.selection;
						if (
							!(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) &&
							selection.empty &&
							selection.from <= 1 &&
							view.endOfTextblock("up")
						) {
							useAppGlobalStore.setState((prev) => ({
								...prev,
								ai_chat_composer_selection_collapsed_and_at_start: true,
							}));

							// Clear the state to prevent it from leaking after the event has been handled.
							setTimeout(() => {
								useAppGlobalStore.setState((prev) => ({
									...prev,
									ai_chat_composer_selection_collapsed_and_at_start: undefined,
								}));
							});

							// Do not return `true` or tiptap will set preventDefault
							return false;
						}
					} else if (event.key === "ArrowDown") {
						const selection = view.state.selection;
						if (
							!(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) &&
							selection.empty &&
							selection.to >= view.state.doc.content.size - 1 &&
							view.endOfTextblock("down")
						) {
							useAppGlobalStore.setState((prev) => ({
								...prev,
								ai_chat_composer_selection_collapsed_and_at_end: true,
							}));

							// Clear the state to prevent it from leaking after the event has been handled.
							setTimeout(() => {
								useAppGlobalStore.setState((prev) => ({
									...prev,
									ai_chat_composer_selection_collapsed_and_at_end: undefined,
								}));
							});

							// Do not return `true` or tiptap will set preventDefault
							return false;
						}
					} else if (event.key === "Enter" && !event.shiftKey) {
						// Enter sends the message. Shift+Enter inserts a line break.
						event.preventDefault();
						rootRef.current?.requestSubmit();
						return true;
					}

					return false;
				},
			},
			onUpdate: ({ editor }) => {
				if (composerSyncTimeoutRef.current) {
					clearTimeout(composerSyncTimeoutRef.current);
				}

				const previousIsEmpty = composerTextRef.current.trim().length === 0;
				const nextIsEmpty = editor.isEmpty;

				// Update immediately when the composer goes from
				// empty to non-empty or vice versa.
				if (previousIsEmpty !== nextIsEmpty) {
					syncComposerText(get_composer_plain_text(editor));
					return;
				}

				// Otherwise sync with a small delay to avoid
				// serializing the document on every keystroke.
				composerSyncTimeoutRef.current = setTimeout(() => {
					composerSyncTimeoutRef.current = null;
					syncComposerText(get_composer_plain_text(editor));
				}, 350);
			},
		};
	});

	const editor = useEditor(editorProps);

	const handleSend = () => {
		if (!canSubmit) {
			return;
		}

		let nextComposerText = composerText;
		const currentEditor = editorRef.current ?? editor;
		// A debounced sync may still be pending: read the latest
		// text straight from the editor before sending.
		if (composerSyncTimeoutRef.current) {
			clearTimeout(composerSyncTimeoutRef.current);
			composerSyncTimeoutRef.current = null;

			if (currentEditor) {
				nextComposerText = get_composer_plain_text(currentEditor);
				syncComposerText(nextComposerText);
			}
		}

		const wasAccepted = onSubmit(
			nextComposerText,
			attachmentsRef.current.map((item) => item.part),
		);
		if (wasAccepted === false) {
			return;
		}

		// Clear the composer for the next message. Do not notify the parent:
		// the submit handler owns clearing the stored draft, like it does for text.
		composerTextRef.current = "";
		setComposerText("");
		attachmentsRef.current = [];
		setAttachments([]);

		if (currentEditor) {
			currentEditor.commands.setContent(files_tiptap_empty_doc_json(), { emitUpdate: false });
		}
	};

	const handleCancel = () => {
		if (!canCancel) {
			return;
		}

		onCancel?.();
	};

	const handleSubmit: ComponentPropsWithRef<"form">["onSubmit"] = (event) => {
		event.preventDefault();
		handleSend();
	};

	const handleDragEnter: ComponentPropsWithRef<"form">["onDragEnter"] = (event) => {
		if (!drag_event_has_files(event)) {
			return;
		}
		event.preventDefault();
		dragDepthRef.current += 1;
		setIsDropTarget(true);
	};

	const handleDragOver: ComponentPropsWithRef<"form">["onDragOver"] = (event) => {
		if (!drag_event_has_files(event)) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
	};

	const handleDragLeave: ComponentPropsWithRef<"form">["onDragLeave"] = (event) => {
		if (!drag_event_has_files(event)) {
			return;
		}
		dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
		if (dragDepthRef.current === 0) {
			setIsDropTarget(false);
		}
	};

	// Capture phase, so the drop never reaches ProseMirror's own drop handling
	// (which would try to insert the file into the text document).
	const handleDropCapture: ComponentPropsWithRef<"form">["onDropCapture"] = (event) => {
		dragDepthRef.current = 0;
		setIsDropTarget(false);

		if (!drag_event_has_files(event)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();

		const files = Array.from(event.dataTransfer.files);
		if (files.length > 0) {
			addAttachmentFiles(files);
		}
	};

	const handleKeyDown: ComponentPropsWithRef<"form">["onKeyDown"] = (event) => {
		onKeyDown?.(event);
		if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.key === "Escape") {
			event.preventDefault();
			onClose?.();
		}
	};

	const handleModelSearchChange: ComponentPropsWithRef<typeof MySearchSelectSearch>["onChange"] = (event) => {
		setModelFilter(event.currentTarget.value);
	};

	const handleFocusForward: MyInputArea_Props["onFocusForward"] = (event) => {
		event.preventDefault();
		event.detail.originalEvent.preventDefault();
		editor.commands.focus();
	};

	// Enable the outside-interaction callback one frame later, so the
	// interaction that opened the composer does not trigger it right away.
	useEffect(() => {
		setEnableInteractedOutside(false);
		if (!onInteractedOutside) {
			return;
		}

		const frameId = requestAnimationFrame(() => {
			setEnableInteractedOutside(true);
		});

		return () => {
			cancelAnimationFrame(frameId);
		};
	}, [onInteractedOutside]);

	useUiInteractedOutside(rootRef, onInteractedOutside, {
		allowedAreas: [editor?.view.dom, mentionPopupElement],
		enable: Boolean(onInteractedOutside) && enableInteractedOutside,
	});

	useEffect(() => {
		editorRef.current = editor;
	}, [editor]);

	useEffect(() => {
		return () => {
			if (composerSyncTimeoutRef.current) {
				clearTimeout(composerSyncTimeoutRef.current);
				const currentEditor = editorRef.current;
				if (currentEditor) {
					// Flush the latest text before queue editing remounts the composer.
					onValueChange?.(get_composer_plain_text(currentEditor));
				}
			}
		};
	}, []);

	// Load `initialValue` into the editor: a saved draft or a message being edited.
	useEffect(() => {
		if (!editor) {
			return;
		}

		const focusEditor = () => {
			if (autoFocus) {
				editor.commands.focus("end", { scrollIntoView: false });
			}
		};

		const editorText = get_composer_plain_text(editor);
		if (editorText === initialValue) {
			focusEditor();
			return;
		}

		editor.commands.setContent(convert_plain_text_to_tiptap_json(initialValue), { emitUpdate: false });

		focusEditor();
	}, [editor]);

	return (
		<form
			ref={(node) => {
				return forward_ref(node, ref, rootRef);
			}}
			id={id}
			className={cn(
				"AiChatComposer" satisfies AiChatComposer_ClassNames,
				isDropTarget && ("AiChatComposer-state-drop-target" satisfies AiChatComposer_ClassNames),
				className,
			)}
			data-composer-mode={isQueueEditing ? "queue-edit" : "message"}
			onSubmit={handleSubmit}
			onKeyDown={handleKeyDown}
			onDragEnter={handleDragEnter}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDropCapture={handleDropCapture}
			{...rest}
		>
			<input
				ref={attachmentsFileInputRef}
				type="file"
				accept={ai_chat_MESSAGE_IMAGE_MEDIA_TYPES.join(",")}
				multiple
				aria-hidden="true"
				tabIndex={-1}
				style={{ display: "none" }}
				onChange={handleAttachmentsFileInputChange}
			/>
			<MyInput className={"AiChatComposer-editor" satisfies AiChatComposer_ClassNames}>
				<MyInputBackground />
				<MyInputArea
					className={"AiChatComposer-editor-area" satisfies AiChatComposer_ClassNames}
					focusForwarding
					onFocusForward={handleFocusForward}
				>
					{hasAttachments && (
						<div className={"AiChatComposer-attachments" satisfies AiChatComposer_ClassNames}>
							<MyChipRow aria-label="Image attachments" onFocusExit={handleAttachmentsFocusExit}>
								{attachments.map((item) => {
									const attachmentName = item.part.filename ?? "Image";
									return (
										<li key={item.key}>
											<MyChip>
												<MyChipMedia>
													<img src={item.part.url} alt="" />
												</MyChipMedia>
												<MyChipLabel>{attachmentName}</MyChipLabel>
												<MyChipRemove
													tooltip={`Remove ${attachmentName}`}
													// event.detail is 0 for keyboard and programmatic
													// clicks, and 1+ for real pointer clicks.
													onClick={(event) => removeAttachment(item.key, event.detail > 0)}
												>
													<X />
												</MyChipRemove>
											</MyChip>
										</li>
									);
								})}
							</MyChipRow>
						</div>
					)}
					<EditorContent
						editor={editor}
						className={"AiChatComposer-editor-content-container" satisfies AiChatComposer_ClassNames}
					/>
				</MyInputArea>
				<MyInputBox />
			</MyInput>

			<div className={"AiChatComposer-configurations" satisfies AiChatComposer_ClassNames}>
				<MySelect
					value={selectedModeId}
					setValue={(value) => {
						onSelectedModeIdChange(value as ai_chat_ModeId);
					}}
				>
					<MySelectTrigger aria-label={`Chat mode: ${ai_chat_MODE_METADATA[selectedModeId].label}`}>
						<MyButton type="button" variant="outline">
							Mode: {ai_chat_MODE_METADATA[selectedModeId].label}
							<MySelectOpenIndicator />
						</MyButton>
					</MySelectTrigger>
					<MySelectPopover>
						<MySelectPopoverScrollableArea>
							<MySelectPopoverContent>
								{ai_chat_MODE_IDS.map((modeId) => {
									return (
										<MySelectItem key={modeId} value={modeId}>
											{ai_chat_MODE_METADATA[modeId].label}
											{selectedModeId === modeId && <MySelectItemIndicator />}
										</MySelectItem>
									);
								})}
							</MySelectPopoverContent>
						</MySelectPopoverScrollableArea>
					</MySelectPopover>
				</MySelect>

				<MySearchSelect
					value={selectedModelId}
					setValue={(value) => {
						onSelectedModelIdChange(value as ai_chat_ModelId);
					}}
					setOpen={(open) => {
						if (!open) {
							setModelFilter("");
						}
					}}
				>
					<MySearchSelectTrigger aria-label={`Chat model: ${selectedModelLabel}`}>
						<MyButton type="button" variant="outline">
							{selectedModelLabel}
							<MySelectOpenIndicator />
						</MyButton>
					</MySearchSelectTrigger>
					<MySearchSelectPopover>
						<MySearchSelectPopoverScrollableArea>
							<MySearchSelectPopoverContent>
								<MySearchSelectSearch placeholder="Search models…" onChange={handleModelSearchChange} />
								{filteredModels.length === 0 ? (
									<div className={"MySearchSelectEmpty"}>No results</div>
								) : (
									<MySearchSelectList>
										{filteredModels.map((modelItem) => {
											const modelLabel = ai_chat_MODELS[modelItem].label;
											return (
												<MySearchSelectItem key={modelItem} value={modelItem}>
													{modelLabel}
													{selectedModelId === modelItem && <MySelectItemIndicator />}
												</MySearchSelectItem>
											);
										})}
									</MySearchSelectList>
								)}
							</MySearchSelectPopoverContent>
						</MySearchSelectPopoverScrollableArea>
					</MySearchSelectPopover>
				</MySearchSelect>

				<MyIconButton
					className={"AiChatComposer-configurations-attach" satisfies AiChatComposer_ClassNames}
					variant="ghost-highlightable"
					tooltip="Attach images"
					onClick={handleAttachmentsAddClick}
				>
					<Plus className={"AiChatComposer-configurations-attach-icon" satisfies AiChatComposer_ClassNames} />
				</MyIconButton>
			</div>

			<div className={"AiChatComposer-actions" satisfies AiChatComposer_ClassNames}>
				<MyIconButton
					type="button"
					variant={isStopAction ? "outline" : "default"}
					tooltip={isStopAction ? "Stop generating" : submitActionLabel}
					data-testid={isStopAction ? undefined : "ai-chat-send-button"}
					onClick={isStopAction ? handleCancel : handleSend}
					disabled={isStopAction ? !canCancel : !canSubmit}
				>
					{isStopAction ? (
						<Square className={"AiChatComposer-cancel-icon" satisfies AiChatComposer_ClassNames} />
					) : isQueueEditing ? (
						<Check className={"AiChatComposer-save-icon" satisfies AiChatComposer_ClassNames} />
					) : (
						<ArrowUp className={"AiChatComposer-send-icon" satisfies AiChatComposer_ClassNames} />
					)}
				</MyIconButton>
			</div>
		</form>
	);
});

// #region tests
if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest;

	describe("convert_plain_text_to_tiptap_json", () => {
		test("maps each newline to a hard break and keeps empty lines", () => {
			expect(convert_plain_text_to_tiptap_json("test\n\n- item")).toEqual({
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [
							{ type: "text", text: "test" },
							{ type: "hardBreak" },
							{ type: "hardBreak" },
							{ type: "text", text: "- item" },
						],
					},
				],
			});
		});

		test("maps empty text to an empty doc", () => {
			expect(convert_plain_text_to_tiptap_json("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
		});
	});
}
// #endregion tests
