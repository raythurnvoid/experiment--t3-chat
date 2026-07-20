// The composer is a plain text input. User messages must never be changed:
// no markdown parsing. The message is stored as one string, so the editor
// keeps all content in one paragraph where every newline is a hard break
// (a hard break = one "\n" in the string).

import "./ai-chat-composer.css";

import type { ComponentPropsWithRef, Ref } from "react";
import { memo, useEffect, useRef, useState } from "react";
import type { ExtractStrict } from "type-fest";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { Fragment, Slice } from "@tiptap/pm/model";
import Document from "@tiptap/extension-document";
import { HardBreak } from "@tiptap/extension-hard-break";
import Placeholder from "@tiptap/extension-placeholder";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { ArrowUp, Square } from "lucide-react";

import { MyButton } from "@/components/my-button.tsx";
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
import {
	ai_chat_MODEL_IDS,
	ai_chat_MODELS,
	ai_chat_MODE_IDS,
	ai_chat_MODE_METADATA,
	type ai_chat_ModelId,
	type ai_chat_ModeId,
} from "@/lib/ai-chat.ts";

export type AiChatComposer_ClassNames =
	| "AiChatComposer"
	| "AiChatComposer-editor"
	| "AiChatComposer-editor-area"
	| "AiChatComposer-editor-content-container"
	| "AiChatComposer-editor-content"
	| "AiChatComposer-actions"
	| "AiChatComposer-configurations"
	| "AiChatComposer-send-icon"
	| "AiChatComposer-cancel-icon";

/** Matches Windows (`\r\n`) and old Mac (`\r`) line endings. */
const CR_LINE_ENDING_RE = /\r\n?/g;

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

export type AiChatComposer_Props = Omit<
	ComponentPropsWithRef<"form">,
	ExtractStrict<keyof ComponentPropsWithRef<"form">, "onSubmit">
> & {
	ref?: Ref<HTMLFormElement>;
	id?: string;
	className?: string;

	autoFocus?: boolean;
	canCancel: boolean;
	canSend: boolean;
	isRunning: boolean;
	initialValue: string;
	selectedModelId: ai_chat_ModelId;
	selectedModeId: ai_chat_ModeId;

	onValueChange?: (value: string) => void;
	onSelectedModelIdChange: (value: ai_chat_ModelId) => void;
	onSelectedModeIdChange: (value: ai_chat_ModeId) => void;
	onSubmit: (value: string) => void;
	onCancel?: () => void;
	onInteractedOutside?: (event: FocusEvent | PointerEvent) => void;
	onClose?: (event: React.KeyboardEvent<HTMLFormElement>) => void;
};

export const AiChatComposer = memo(function AiChatComposer(props: AiChatComposer_Props) {
	const {
		ref,
		id,
		className,
		autoFocus,
		canCancel,
		canSend: canSendProp,
		isRunning,
		initialValue,
		selectedModelId,
		selectedModeId,
		onValueChange,
		onSelectedModelIdChange,
		onSelectedModeIdChange,
		onSubmit,
		onCancel,
		onInteractedOutside,
		onClose,
		...rest
	} = props;

	const placeholder = "Send a message...";

	const rootRef = useRef<HTMLFormElement | null>(null);
	const editorRef = useRef<Editor | null>(null);
	/** Pending debounce timer for syncing the editor text into React state. */
	const composerSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** Mirror of `composerText` so editor callbacks can read the latest value. */
	const composerTextRef = useRef(initialValue);

	const [composerText, setComposerText] = useState(initialValue);
	const isEmpty = composerText.trim().length === 0;

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

	const canSend = canSendProp && !isRunning && !isEmpty;

	/** Store the current text and notify the parent (used for drafts). */
	const syncComposerText = (value: string) => {
		composerTextRef.current = value;
		setComposerText(value);
		onValueChange?.(value);
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
					"aria-label": placeholder,
				},
				// The default ProseMirror plain-text paste collapses consecutive
				// newlines, dropping empty lines. Paste every newline as a hard
				// break instead, keeping the whole text in one paragraph.
				clipboardTextParser: (text, _$context, _plain, view) => {
					const schema = view.state.schema;
					const inline = [];
					for (const [index, line] of text.replace(CR_LINE_ENDING_RE, "\n").split("\n").entries()) {
						if (index > 0) {
							inline.push(schema.nodes.hardBreak.create());
						}
						if (line) {
							inline.push(schema.text(line));
						}
					}
					return Slice.maxOpen(Fragment.fromArray([schema.nodes.paragraph.createChecked(null, inline)]));
				},
				handleKeyDown: (view, event) => {
					if (event.isComposing) {
						return false;
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
		if (!canSend) {
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

		onSubmit(nextComposerText);

		// Clear the composer for the next message.
		composerTextRef.current = "";
		setComposerText("");

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
		allowedAreas: [editor?.view.dom],
		enable: Boolean(onInteractedOutside) && enableInteractedOutside,
	});

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
			className={cn("AiChatComposer" satisfies AiChatComposer_ClassNames, className)}
			onSubmit={handleSubmit}
			{...rest}
		>
			<MyInput className={"AiChatComposer-editor" satisfies AiChatComposer_ClassNames}>
				<MyInputBackground />
				<MyInputArea
					className={"AiChatComposer-editor-area" satisfies AiChatComposer_ClassNames}
					focusForwarding
					onFocusForward={handleFocusForward}
				>
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
			</div>

			<div className={"AiChatComposer-actions" satisfies AiChatComposer_ClassNames}>
				{isRunning ? (
					<MyIconButton
						type="button"
						variant="outline"
						tooltip="Stop generating"
						onClick={handleCancel}
						disabled={!canCancel}
					>
						<Square className={"AiChatComposer-cancel-icon" satisfies AiChatComposer_ClassNames} />
					</MyIconButton>
				) : (
					<MyIconButton
						type="button"
						variant="default"
						tooltip="Send message"
						data-testid="ai-chat-send-button"
						onClick={handleSend}
						disabled={!canSend}
					>
						<ArrowUp className={"AiChatComposer-send-icon" satisfies AiChatComposer_ClassNames} />
					</MyIconButton>
				)}
			</div>
		</form>
	);
});

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
