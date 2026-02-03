import "./ai-chat-composer.css";

import type { ComponentPropsWithRef, Ref } from "react";
import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
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
import { check_element_is_in_allowed_focus_area, cn, forward_ref } from "@/lib/utils.ts";
import { pages_get_tiptap_shared_extensions, pages_tiptap_markdown_to_json } from "@/lib/pages.ts";
import type { AppClassName, AppElementId } from "@/lib/dom-utils.ts";
import { useGlobalEventList } from "@/lib/global-event.tsx";
import { use_app_global_store } from "@/lib/app-global-store.ts";

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

export type AiChatComposer_Props = Omit<ComponentPropsWithRef<"form">, "onSubmit"> & {
	ref?: Ref<HTMLFormElement>;
	id?: string;
	className?: string;

	autoFocus?: boolean;
	canCancel: boolean;
	isRunning: boolean;
	initialValue: string;

	onValueChange?: (value: string) => void;
	onSubmit: (value: string) => void;
	onCancel: () => void;
	onInteractedOutside?: (event: PointerEvent) => void;
	onClose?: (event: React.KeyboardEvent<HTMLFormElement>) => void;
};

export function AiChatComposer(props: AiChatComposer_Props) {
	const {
		ref,
		id,
		className,
		autoFocus,
		canCancel,
		isRunning,
		initialValue,
		onValueChange,
		onSubmit,
		onCancel,
		onInteractedOutside,
		onClose,
		...rest
	} = props;

	const placeholder = "Send a message...";

	const rootRef = useRef<HTMLFormElement | null>(null);
	const editorRef = useRef<Editor | null>(null);
	const composerSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const [composerText, setComposerText] = useState(initialValue);
	const isEmpty = composerText.trim().length === 0;

	const modes: AiChatComposer_Mode[] = ["Agent", "Ask", "Plan"];
	const [mode, setMode] = useState<AiChatComposer_Mode>("Agent");

	const models: AiChatComposer_Model[] = ["GPT 5.2", "Opus 4.5", "Gemini Pro 3"];
	const [model, setModel] = useState<AiChatComposer_Model>("GPT 5.2");
	const [modelFilter, setModelFilter] = useState("");
	const modelFilterValue = modelFilter.trim().toLowerCase();
	const filteredModels = modelFilterValue
		? models.filter((modelItem) => {
				return modelItem.toLowerCase().includes(modelFilterValue);
			})
		: models;

	const canSend = !isRunning && !isEmpty;

	const getMarkdownFromEditor = (currentEditor: Editor) => {
		return currentEditor.getMarkdown();
	};

	const [{ extensions, editorProps }] = useState<{
		extensions: Parameters<typeof useEditor>[0]["extensions"];
		editorProps: Parameters<typeof useEditor>[0];
	}>(() => {
		const extensions = [
			Document,
			Paragraph,
			Text,
			HardBreak,
			pages_get_tiptap_shared_extensions().markdown,
			Placeholder.configure({
				placeholder,
			}),
		];

		return {
			extensions,
			editorProps: {
				autofocus: autoFocus ? "end" : false,
				extensions,
				content: pages_tiptap_markdown_to_json({
					markdown: "",
					extensions,
				}),
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
								use_app_global_store.setState((prev) => ({
									...prev,
									ai_chat_composer_selection_collapsed_and_at_start: true,
								}));

								// Clear the state to prevent it from leaking after the event has been handled.
								setTimeout(() => {
									use_app_global_store.setState((prev) => ({
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
								use_app_global_store.setState((prev) => ({
									...prev,
									ai_chat_composer_selection_collapsed_and_at_end: true,
								}));

								// Clear the state to prevent it from leaking after the event has been handled.
								setTimeout(() => {
									use_app_global_store.setState((prev) => ({
										...prev,
										ai_chat_composer_selection_collapsed_and_at_end: undefined,
									}));
								});

								// Do not return `true` or tiptap will set preventDefault
								return false;
							}
						} else if (event.key === "Enter" && !event.shiftKey) {
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

					composerSyncTimeoutRef.current = setTimeout(() => {
						composerSyncTimeoutRef.current = null;

						const markdown = getMarkdownFromEditor(editor);
						setComposerText(markdown);
						onValueChange?.(markdown);
					}, 350);
				},
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
		if (composerSyncTimeoutRef.current) {
			clearTimeout(composerSyncTimeoutRef.current);
			composerSyncTimeoutRef.current = null;

			if (currentEditor) {
				nextComposerText = getMarkdownFromEditor(currentEditor);
				setComposerText(nextComposerText);
				onValueChange?.(nextComposerText);
			}
		}

		onSubmit(nextComposerText);

		setComposerText("");

		if (currentEditor) {
			currentEditor.commands.setContent(
				pages_tiptap_markdown_to_json({
					markdown: "",
					extensions,
				}),
				{
					emitUpdate: false,
				},
			);
		}
	};

	const handleCancel = () => {
		if (!canCancel) {
			return;
		}

		onCancel();
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

	useGlobalEventList(
		["pointerdown", "focusin"],
		(event) => {
			if (!(event instanceof PointerEvent)) {
				return;
			}

			if (!onInteractedOutside) {
				return;
			}

			if (
				check_element_is_in_allowed_focus_area(event.target, {
					allowedAreas: [rootRef.current, editor.view.dom],
					restrictionScope: document.getElementById("root" satisfies AppElementId),
				})
			) {
				return;
			}

			onInteractedOutside(event);
		},
		{ capture: true },
	);

	useEffect(() => {
		if (!editor) {
			return;
		}

		const editorMarkdown = getMarkdownFromEditor(editor);
		if (editorMarkdown === initialValue) {
			return;
		}

		editor.commands.setContent(
			pages_tiptap_markdown_to_json({
				markdown: initialValue,
				extensions,
			}),
			{ emitUpdate: false },
		);
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
			<MyInput className={cn("AiChatComposer-editor" satisfies AiChatComposer_ClassNames)} variant="surface">
				<MyInputBox />
				<MyInputArea
					className={"AiChatComposer-editor-area" satisfies AiChatComposer_ClassNames}
					focusForwarding
					onFocusForward={handleFocusForward}
				>
					<EditorContent
						editor={editor}
						className={cn("AiChatComposer-editor-content-container" satisfies AiChatComposer_ClassNames)}
					/>
				</MyInputArea>
			</MyInput>

			<div className={cn("AiChatComposer-configurations" satisfies AiChatComposer_ClassNames)}>
				<MySelect
					value={mode}
					setValue={(value) => {
						setMode(value as AiChatComposer_Mode);
					}}
				>
					<MySelectTrigger>
						<MyButton type="button" variant="outline">
							Mode: {mode}
							<MySelectOpenIndicator />
						</MyButton>
					</MySelectTrigger>
					<MySelectPopover>
						<MySelectPopoverScrollableArea>
							<MySelectPopoverContent>
								{modes.map((mote) => {
									return (
										<MySelectItem key={mote} value={mote}>
											{mote}
											{mode === mote && <MySelectItemIndicator />}
										</MySelectItem>
									);
								})}
							</MySelectPopoverContent>
						</MySelectPopoverScrollableArea>
					</MySelectPopover>
				</MySelect>

				<MySearchSelect
					defaultValue={model}
					setValue={(value) => {
						setModel(value as AiChatComposer_Model);
					}}
					setOpen={(open) => {
						if (!open) {
							setModelFilter("");
						}
					}}
				>
					<MySearchSelectTrigger>
						<MyButton type="button" variant="outline">
							{model}
							<MySelectOpenIndicator />
						</MyButton>
					</MySearchSelectTrigger>
					<MySearchSelectPopover>
						<MySearchSelectPopoverScrollableArea>
							<MySearchSelectPopoverContent>
								<MySearchSelectSearch placeholder="Search models…" onChange={handleModelSearchChange} />
								{filteredModels.length === 0 ? (
									<div className={cn("MySearchSelectEmpty")}>No results</div>
								) : (
									<MySearchSelectList>
										{filteredModels.map((modelItem) => {
											return (
												<MySearchSelectItem key={modelItem} value={modelItem}>
													{modelItem}
													{model === modelItem && <MySelectItemIndicator />}
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

type AiChatComposer_Mode = "Agent" | "Ask" | "Plan";

type AiChatComposer_Model = "GPT 5.2" | "Opus 4.5" | "Gemini Pro 3";
