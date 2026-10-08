// The composer's "@" file mention: a suggestion popup over the shared file
// picker plus an inline chip node. The chip serializes to plain text as
// `@<path>` (file) or `@<path>/` (folder), so the sent message stays one plain
// string and the agent's path-based tools can resolve the mention.

import "./ai-chat-composer-file-mention.css";

import type { MouseEvent, Ref } from "react";
import { memo, useImperativeHandle, useRef } from "react";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { PluginKey } from "@tiptap/pm/state";
import { mergeAttributes, type Editor, type Range } from "@tiptap/core";
import { posToDOMRect, ReactRenderer } from "@tiptap/react";
import Mention from "@tiptap/extension-mention";
import { exitSuggestion, type SuggestionKeyDownProps } from "@tiptap/suggestion";

import {
	FilesNodePicker,
	type FilesNodePicker_Folder,
	type FilesNodePicker_Ref,
	type FilesNodePicker_Row,
} from "@/components/files/files-node-picker.tsx";
import type { MyFloatingSurface_ClassNames } from "@/components/my-floating-surface.tsx";
import type { MyPopoverContent_ClassNames } from "@/components/my-popover.tsx";
import { cn } from "@/lib/utils.ts";
import type { AppClassName, AppElementId } from "@/lib/dom-utils.ts";

/**
 * Plugin key for the composer's "@" suggestion. The composer's own keyboard
 * handlers read it to yield Enter/Escape/Arrow keys while the popup is open.
 */
export const ai_chat_composer_file_mention_PLUGIN_KEY = new PluginKey("aiChatComposerFileMention");

/**
 * Position the popup under the caret with a floating-ui virtual element, like
 * the official Tiptap mention example.
 */
function update_popup_position(editor: Editor, element: HTMLElement) {
	const virtualElement = {
		getBoundingClientRect: () => posToDOMRect(editor.view, editor.state.selection.from, editor.state.selection.to),
	};

	computePosition(virtualElement, element, {
		placement: "bottom-start",
		strategy: "absolute",
		middleware: [offset(4), flip(), shift()],
	})
		.then(({ x, y, strategy }) => {
			element.style.width = "max-content";
			element.style.position = strategy;
			element.style.left = `${x}px`;
			element.style.top = `${y}px`;
		})
		.catch((error: unknown) => {
			console.error("[AiChatComposerFileMention.update_popup_position] Failed to position the mention popup", {
				error,
			});
		});
}

// #region chip
export type AiChatComposerFileMention_ClassNames = "AiChatComposerFileMention";

type ai_chat_composer_file_mention_CreateOptions = {
	/**
	 * Called with the popup element while it is mounted, and with `null` when
	 * it closes. Keep it in composer state and allow it in the composer's
	 * outside-interaction check, so a click on a popup row does not count as
	 * an outside click for the message-edit composer.
	 */
	onPopupElementChange: (element: HTMLElement | null) => void;
};

/**
 * Build the configured Mention extension for one composer instance.
 */
export function ai_chat_composer_file_mention_create_extension(options: ai_chat_composer_file_mention_CreateOptions) {
	return Mention.configure({
		HTMLAttributes: { class: "AiChatComposerFileMention" satisfies AiChatComposerFileMention_ClassNames },
		// The submitted message is `editor.getText(...)`, which uses this
		// serializer. The chip shows the name, but the text carries the full
		// path token the agent's tools resolve.
		renderText({ node }) {
			return `@${node.attrs.id}`;
		},
		renderHTML({ options: nodeOptions, node }) {
			const isFolder = typeof node.attrs.id === "string" && node.attrs.id.endsWith("/");
			return [
				"span",
				mergeAttributes(nodeOptions.HTMLAttributes, { title: node.attrs.id }),
				`@${node.attrs.label ?? node.attrs.id}${isFolder ? "/" : ""}`,
			];
		},
		suggestion: {
			char: "@",
			pluginKey: ai_chat_composer_file_mention_PLUGIN_KEY,
			// The popup owns a reactive Convex subscription and filters from its
			// props, so the plugin's one-shot items snapshot stays unused.
			items: () => [],
			render: () => {
				let component: ReactRenderer<AiChatComposerFileMentionList_Ref, AiChatComposerFileMentionList_Props> | null =
					null;
				let blurEditor: Editor | null = null;

				// The plugin does not close the suggestion when the editor loses
				// focus. Clicking the popup itself never blurs the editor because
				// the popup cancels mousedown, so a blur is a real focus exit.
				const handleEditorBlur = () => {
					if (blurEditor) {
						exitSuggestion(blurEditor.view, ai_chat_composer_file_mention_PLUGIN_KEY);
					}
				};

				// `onExit` can fire more than once (Escape, blur exit, editor
				// destroy), so destroying must tolerate repeats.
				const destroy = () => {
					if (!component) {
						return;
					}

					options.onPopupElementChange(null);
					blurEditor?.off("blur", handleEditorBlur);
					blurEditor = null;
					component.element.remove();
					component.destroy();
					component = null;
				};

				return {
					onStart: (props) => {
						component = new ReactRenderer(AiChatComposerFileMentionList, {
							props: {
								editor: props.editor,
								query: props.query,
								range: props.range,
								command: props.command,
							} satisfies AiChatComposerFileMentionList_Props,
							editor: props.editor,
						});

						if (!props.clientRect) {
							return;
						}

						component.element.style.position = "absolute";
						// Mount into the app overlay container so the popup escapes the
						// composer's overflow. Component tests render without the app
						// shell, so fall back to the body.
						const container = document.getElementById("app_hoisting_container" satisfies AppElementId) ?? document.body;
						container.appendChild(component.element);
						update_popup_position(props.editor, component.element);

						blurEditor = props.editor;
						props.editor.on("blur", handleEditorBlur);
						options.onPopupElementChange(component.element);
					},
					onUpdate: (props) => {
						if (!component) {
							return;
						}

						component.updateProps({
							query: props.query,
							range: props.range,
							command: props.command,
						} satisfies Partial<AiChatComposerFileMentionList_Props>);

						if (props.clientRect) {
							update_popup_position(props.editor, component.element);
						}
					},
					onKeyDown: (props) => {
						// Return false for Escape so the plugin runs its own exit; the
						// vendored plugin skips the exit when the renderer claims the key.
						// Also stop the native event here. This Escape only closes the
						// popup, but the chat-level keydown handler treats any bubbling
						// Escape as a close command even when defaultPrevented, so it
						// would still cancel a message edit. A React-state gate in the
						// composer cannot catch this: React flushes the popup-close state
						// update before its own handlers run.
						if (props.event.key === "Escape") {
							props.event.stopPropagation();
							return false;
						}

						return component?.ref?.onKeyDown(props) ?? false;
					},
					onExit: destroy,
				};
			},
		},
	});
}
// #endregion chip

// #region list
type AiChatComposerFileMentionList_ClassNames = "AiChatComposerFileMentionList";

type AiChatComposerFileMentionList_Ref = {
	onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

type AiChatComposerFileMentionList_Props = {
	ref?: Ref<AiChatComposerFileMentionList_Ref>;
	editor: Editor;
	query: string;
	/**
	 * The "@" and the typed query in the document.
	 */
	range: Range;
	command: (attrs: { id: string; label: string }) => void;
};

// This component is private because the Tiptap extension owns its lifecycle.
// eslint-disable-next-line react-refresh/only-export-components
const AiChatComposerFileMentionList = memo(function AiChatComposerFileMentionList(
	props: AiChatComposerFileMentionList_Props,
) {
	const { ref, editor, query, range, command } = props;

	const pickerRef = useRef<FilesNodePicker_Ref>(null);

	const handlePick = (row: FilesNodePicker_Row) => {
		command({ id: row.path, label: row.name });
	};

	const handlePickFolder = (folder: FilesNodePicker_Folder) => {
		// Folder tokens carry a trailing slash so the model can tell folders
		// from files without another lookup.
		command({ id: `${folder.path}/`, label: folder.name });
	};

	const clearQuery = () => {
		// Keep the "@", so the suggestion stays open on the opened folder.
		editor.commands.deleteRange({ from: range.from + 1, to: range.to });
	};

	const handleRootMouseDown = (event: MouseEvent<HTMLDivElement>) => {
		// Keep DOM focus in the editor for every popup click. The picker keeps it for its rows, and this
		// root also covers its own padding and scrollbar.
		event.preventDefault();
	};

	useImperativeHandle(ref, () => ({
		// The picker leaves IME keys alone and swallows Enter even with no rows:
		// the composer yields while the popup is open, and letting ProseMirror
		// split the paragraph would break the one-paragraph message invariant.
		onKeyDown: ({ event }: SuggestionKeyDownProps) => pickerRef.current?.onKeyDown(event) ?? event.key === "Enter",
	}));

	return (
		<div
			className={cn(
				"AiChatComposerFileMentionList" satisfies AiChatComposerFileMentionList_ClassNames,
				"app-scrollable" satisfies AppClassName,
				"MyFloatingSurface" satisfies MyFloatingSurface_ClassNames,
				"MyPopoverContent" satisfies MyPopoverContent_ClassNames,
			)}
			onMouseDown={handleRootMouseDown}
		>
			<FilesNodePicker
				ref={pickerRef}
				variant="listbox"
				aria-label="Files and folders"
				ownerElement={editor.view.dom}
				query={query}
				select="any"
				folderRow={{ label: "Mention this folder", onPick: handlePickFolder }}
				onPick={handlePick}
				clearQuery={clearQuery}
			/>
		</div>
	);
});
// #endregion list
