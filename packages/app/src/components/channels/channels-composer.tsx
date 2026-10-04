import "./channels-composer.css";
import { EditorContent, useEditor } from "@tiptap/react";
import { isNodeEmpty, type Editor, type FocusPosition } from "@tiptap/core";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Document } from "@tiptap/extension-document";
import { Text } from "@tiptap/extension-text";
import { memo, useEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils.ts";
import { useFn, useLiveRef } from "@/hooks/utils-hooks.ts";
import { file_quote_extension } from "@/components/file-quotes/file-quote-extension.tsx";
import {
	file_quotes_decode_draft_data,
	file_quotes_encode_draft_data,
	type file_quotes_Quote,
} from "../../../shared/file-quotes.ts";
import { files_get_tiptap_shared_extensions } from "../../../shared/files-tiptap.ts";
import {
	MyInput,
	MyInputActions,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	type MyInput_Props,
} from "../my-input.tsx";
import type { MyInputTextAreaControl_ClassNames } from "../my-input.tsx";
import { MyIconButton, MyIconButtonIcon } from "../my-icon-button.tsx";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	ChannelsMentionContext,
	channels_composer_mention_create_extension,
	channels_composer_mention_PLUGIN_KEY,
	channels_composer_channel_PLUGIN_KEY,
	type ChannelsMentionItem,
} from "./channels-composer-mention.tsx";
import {
	ChannelsComposerAttachments,
	type ChannelsComposerAttachments_Ref,
	type ChannelsComposerAttachmentTarget,
} from "./channels-composer-attachments.tsx";

// #region control
type ChannelsComposerControl_ClassNames = "ChannelsComposerControl" | "ChannelsComposerControl-editor";

export interface ChannelsComposerControl_Ref {
	getMarkdownContent: () => string;
	getDraftContent: () => string;
	getMentionUserIds: () => app_convex_Id<"users">[];
	getFileMentionIds: () => app_convex_Id<"files_nodes">[];
	getFileQuotes: () => file_quotes_Quote[];
	getAttachments: ChannelsComposerAttachments_Ref["getAttachments"];
	hasPendingUploads: () => boolean;
	resetUploads: () => void;
	insertText: (text: string) => void;
	insertQuote: (quote: file_quotes_Quote) => boolean;
	clear: () => void;
	isEmpty: () => boolean;
	focus: (position?: FocusPosition) => boolean;
}

type ChannelsComposerControl_Props = {
	ref: Ref<ChannelsComposerControl_Ref>;
	className?: string;
	initialValue?: string;
	placeholder?: string;
	autoFocus?: FocusPosition;
	disabled?: boolean;
	ariaLabel: string;
	attachmentsRef: React.RefObject<ChannelsComposerAttachments_Ref | null>;
	onChange?: () => void;
	onEnter?: () => void;
	onEscape?: () => void;
	onEmptyUp?: () => void;
	mentionItems?: readonly ChannelsMentionItem[];
	quoteRequest?: file_quotes_Quote | null;
	onQuoteInserted?: () => void;
};

const ChannelsComposerControl = memo(function ChannelsComposerControl(props: ChannelsComposerControl_Props) {
	const {
		ref,
		className,
		initialValue,
		placeholder,
		autoFocus = false,
		disabled = false,
		ariaLabel,
		attachmentsRef,
		onChange,
		onEnter,
		onEscape,
		onEmptyUp,
		mentionItems,
		quoteRequest,
		onQuoteInserted,
	} = props;

	const onChangeRef = useLiveRef(onChange);
	const onEnterRef = useLiveRef(onEnter);
	const onEscapeRef = useLiveRef(onEscape);
	const onEmptyUpRef = useLiveRef(onEmptyUp);
	const mentionItemsRef = useLiveRef(mentionItems);
	const attachmentsRefRef = useLiveRef(attachmentsRef);
	const getMentionItems = useFn(() => mentionItemsRef.current ?? []);
	const mentionsEnabled = useFn(() => mentionItemsRef.current !== undefined);

	const [editorProps] = useState<Parameters<typeof useEditor>[0]>(() => {
		const extensions = [
			Document,
			Text,
			file_quote_extension,
			channels_composer_mention_create_extension({
				isEnabled: mentionsEnabled,
				getItems: getMentionItems,
			}),
			Paragraph.extend({
				addKeyboardShortcuts() {
					return {
						// Prevent Enter to create a new paragraph
						Enter: ({ editor }) => {
							if (
								channels_composer_mention_PLUGIN_KEY.getState(editor.state)?.active ||
								channels_composer_channel_PLUGIN_KEY.getState(editor.state)?.active
							)
								return false;
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
				handleDOMEvents: {
					keydown: (view, event) => {
						if (
							event.isComposing ||
							channels_composer_mention_PLUGIN_KEY.getState(view.state)?.active ||
							channels_composer_channel_PLUGIN_KEY.getState(view.state)?.active
						)
							return false;
						if (event.key === "Escape") {
							if (onEscapeRef.current) {
								event.stopPropagation();
								onEscapeRef.current();
							}
							// Let an outer popover use Escape when there is no reply or edit.
							return true;
						}
						if (
							event.key === "ArrowUp" &&
							onEmptyUpRef.current &&
							!attachmentsRefRef.current.current?.hasAttachments() &&
							isNodeEmpty(view.state.doc, { ignoreWhitespace: true })
						) {
							event.preventDefault();
							onEmptyUpRef.current();
							return true;
						}
						return false;
					},
				},
				attributes: {
					role: "textbox",
					"aria-multiline": "true",
					class: cn(
						"ChannelsComposerControl-editor" satisfies ChannelsComposerControl_ClassNames,
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

					// Use this editor's parser so private mention and quote nodes survive restore.
					editor.commands.setContent(initialValue, { contentType: "markdown" });
				} catch (error) {
					console.error("[ChannelsComposerControl.onCreate] Failed to set initial value:", error);
				}
			},
		};
	});

	const editor = useEditor(editorProps, []);
	const getMentionUserIds = () => {
		const ids: app_convex_Id<"users">[] = [];
		editor?.state.doc.descendants((node) => {
			if (
				node.type.name === "channelsMention" &&
				typeof node.attrs.id === "string" &&
				node.attrs.id.startsWith("user:")
			) {
				const id = node.attrs.id.slice(5) as app_convex_Id<"users">;
				if (!ids.includes(id)) ids.push(id);
			}
		});
		return ids;
	};
	const getFileMentionIds = () => {
		const ids: app_convex_Id<"files_nodes">[] = [];
		editor?.state.doc.descendants((node) => {
			if (
				node.type.name === "channelsMention" &&
				typeof node.attrs.id === "string" &&
				node.attrs.id.startsWith("file:")
			) {
				const id = node.attrs.id.slice(5) as app_convex_Id<"files_nodes">;
				if (!ids.includes(id)) ids.push(id);
			}
		});
		return ids;
	};
	const getFileQuotes = () => {
		const quotes: file_quotes_Quote[] = [];
		editor?.state.doc.descendants((node) => {
			if (node.type.name !== "fileQuote") return;
			const quote = file_quotes_decode_draft_data(node.attrs.data);
			if (quote) quotes.push(quote);
		});
		return quotes;
	};
	const insertQuote = useFn((quote: file_quotes_Quote) => {
		if (!editor?.isEditable) return false;
		return editor
			.chain()
			.focus("end")
			.insertContent([
				{ type: "fileQuote", attrs: { data: file_quotes_encode_draft_data(quote) } },
				{ type: "text", text: " " },
			])
			.run();
	});
	const insertedRequest = useRef<file_quotes_Quote | null>(null);
	useEffect(() => {
		if (editor) {
			editor.setEditable(!disabled, false);
		}
	}, [editor, disabled]);
	useEffect(() => {
		if (!quoteRequest || disabled || insertedRequest.current === quoteRequest) return;
		if (insertQuote(quoteRequest)) {
			insertedRequest.current = quoteRequest;
			onQuoteInserted?.();
		}
	}, [editor, quoteRequest, disabled, insertQuote, onQuoteInserted]);

	useImperativeHandle(ref, () => ({
		getMarkdownContent: () => {
			const ids = getMentionUserIds();
			const fileIds = getFileMentionIds();
			let quoteIndex = 0;
			return (editor?.getMarkdown() ?? "")
				.replace(
					/\[@ id="user:([^"]+)"\]/g,
					(_token, id: string) => `[@ id="user:${ids.indexOf(id as app_convex_Id<"users">)}"]`,
				)
				.replace(
					/\[@ id="file:([^"]+)"\]/g,
					(_token, id: string) => `[@ id="file:${fileIds.indexOf(id as app_convex_Id<"files_nodes">)}"]`,
				)
				.replace(/\[file-quote data="[^"]+"\]/g, () => {
					quoteIndex += 1;
					return `[file-quote id="${quoteIndex - 1}"]`;
				});
		},
		getDraftContent: () => editor?.getMarkdown() ?? "",
		getMentionUserIds,
		getFileMentionIds,
		getFileQuotes,
		getAttachments: () => attachmentsRef.current?.getAttachments() ?? [],
		hasPendingUploads: () => attachmentsRef.current?.hasPendingUploads() ?? false,
		resetUploads: () => attachmentsRef.current?.resetUploads(),
		insertQuote,
		insertText: (text) => {
			editor?.chain().focus().insertContent({ type: "text", text }).run();
		},
		clear: () => {
			attachmentsRef.current?.clear();
			editor?.commands.clearContent();
		},
		isEmpty: () => {
			if (attachmentsRef.current?.hasAttachments()) return false;
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
			className={cn("ChannelsComposerControl" satisfies ChannelsComposerControl_ClassNames, className)}
		/>
	);
});
// #endregion control

// #region root
export type ChannelsComposer_ClassNames = "ChannelsComposer";

export type ChannelsComposer_Props = {
	controlRef: Ref<ChannelsComposerControl_Ref>;
	variant?: MyInput_Props["variant"];
	className?: string;
	initialValue?: string;
	placeholder?: string;
	autoFocus?: FocusPosition;
	disabled?: boolean;
	submitTooltip: string;
	submitDisabled: boolean;
	ariaLabel: string;
	attachmentTarget?: ChannelsComposerAttachmentTarget;
	onChange?: () => void;
	onEnter?: () => void;
	onEscape?: () => void;
	onEmptyUp?: () => void;
	mentionItems?: readonly ChannelsMentionItem[];
	quoteRequest?: file_quotes_Quote | null;
	onQuoteInserted?: () => void;
};

export const ChannelsComposer = memo(function ChannelsComposer(props: ChannelsComposer_Props) {
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
		attachmentTarget,
		onChange,
		onEnter,
		onEscape,
		onEmptyUp,
		mentionItems,
		quoteRequest,
		onQuoteInserted,
	} = props;
	const attachments = useRef<ChannelsComposerAttachments_Ref>(null);
	const [pendingUploads, setPendingUploads] = useState(false);
	const attachmentsChanged = useFn(() => {
		setPendingUploads(attachments.current?.hasPendingUploads() ?? false);
		onChange?.();
	});
	const enter = useFn(() => {
		if (!attachments.current?.hasPendingUploads()) onEnter?.();
	});

	return (
		<ChannelsMentionContext value={mentionItems ?? []}>
			<MyInput
				variant={variant}
				className={cn("ChannelsComposer" satisfies ChannelsComposer_ClassNames, className)}
				onPasteCapture={(event) => {
					if (!attachmentTarget || !event.clipboardData.files.length) return;
					event.preventDefault();
					attachments.current?.addFiles(Array.from(event.clipboardData.files));
				}}
				onDragOver={(event) => {
					if (attachmentTarget && event.dataTransfer.types.includes("Files")) event.preventDefault();
				}}
				onDrop={(event) => {
					if (!attachmentTarget || !event.dataTransfer.files.length) return;
					event.preventDefault();
					attachments.current?.addFiles(Array.from(event.dataTransfer.files));
				}}
			>
				<MyInputBackground />
				<MyInputArea>
					<ChannelsComposerControl
						ref={controlRef}
						initialValue={initialValue}
						placeholder={placeholder}
						autoFocus={autoFocus}
						disabled={disabled}
						ariaLabel={ariaLabel}
						attachmentsRef={attachments}
						onChange={onChange}
						onEnter={enter}
						onEscape={onEscape}
						onEmptyUp={onEmptyUp}
						mentionItems={mentionItems}
						quoteRequest={quoteRequest}
						onQuoteInserted={onQuoteInserted}
					/>
				</MyInputArea>
				<MyInputActions>
					<MyIconButton
						type="submit"
						variant="default-embedded"
						tooltip={submitTooltip}
						disabled={submitDisabled || pendingUploads}
					>
						<MyIconButtonIcon>
							<ArrowUp />
						</MyIconButtonIcon>
					</MyIconButton>
				</MyInputActions>
				{attachmentTarget && (
					<ChannelsComposerAttachments
						ref={attachments}
						target={attachmentTarget}
						disabled={disabled ?? false}
						onChange={attachmentsChanged}
					/>
				)}
				<MyInputBox />
			</MyInput>
		</ChannelsMentionContext>
	);
});
// #endregion root
