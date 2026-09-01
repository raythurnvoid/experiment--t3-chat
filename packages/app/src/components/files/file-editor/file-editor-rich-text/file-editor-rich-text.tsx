import "./file-editor-rich-text.css";
import { memo, useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import {
	EditorContent,
	EditorRoot,
	type EditorContentProps,
	ImageResizer,
	handleCommandNavigation,
	EditorBubble,
} from "novel";
import { Editor, useEditorState } from "@tiptap/react";
import { toast } from "sonner";
import { useFileEditorRichTextExtension } from "@/lib/file-editor-rich-text-extension.ts";
import type { YjsSyncStatus } from "@liveblocks/core";
import { EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { defaultExtensions, nonCollaborativeExtensions } from "./extensions.ts";
import { FileEditorRichTextToolsColorSelector } from "./file-editor-rich-text-tools-color-selector.tsx";
import { FileEditorRichTextToolsLinkSetter } from "./file-editor-rich-text-tools-link-setter.tsx";
import { FileEditorRichTextToolsNodeSelector } from "./file-editor-rich-text-tools-node-selector.tsx";
import { FileEditorRichTextToolsMathToggle } from "./file-editor-rich-text-tools-math-toggle.tsx";
import { FileEditorRichTextToolsTextStyles } from "./file-editor-rich-text-tools-text-styles.tsx";
import { FileEditorRichTextToolsSlashCommand } from "./file-editor-rich-text-tools-slash-command.tsx";
import { FileEditorRichTextToolsTable } from "./file-editor-rich-text-tools-table.tsx";
import { FileEditorRichTextToolsHistoryButtons } from "./file-editor-rich-text-tools-history-buttons.tsx";
import { MySeparator } from "@/components/my-separator.tsx";
import {
	file_editor_rich_text_handle_media_drop,
	file_editor_rich_text_handle_media_paste,
	file_editor_rich_text_upload_media_files,
} from "./file-editor-rich-text-media-upload.ts";
import {
	FileEditorRichTextMediaEmbedPicker,
	file_editor_rich_text_MediaInsertExtension,
} from "./file-editor-rich-text-media-insert.tsx";
import { FileEditorRichTextAnchoredComments } from "./file-editor-rich-text-comments.tsx";
import { FileEditorSnapshotsModal } from "../file-editor-snapshots-modal.tsx";
import { AI_NAME } from "./constants.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { check_element_is_in_allowed_areas, cn } from "@/lib/utils.ts";
import type { AppClassName, AppElementId } from "@/lib/dom-utils.ts";
import { app_fetch_ai_docs_contextual_prompt } from "@/lib/fetch.ts";
import { MyBadge } from "@/components/my-badge.tsx";
import { app_convex, app_convex_api } from "@/lib/app-convex-client.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_PresenceStore,
	files_YJS_DOC_KEYS,
	files_get_utf8_byte_size,
	files_yjs_reconcile_branch_with_local_text,
} from "@/lib/files.ts";
import {
	files_tiptap_markdown_to_json,
	files_yjs_doc_get_text,
	files_yjs_doc_update_from_text,
} from "../../../../../shared/files-tiptap.ts";
import { files_yjs_doc_clone } from "../../../../../shared/files-yjs.ts";
import { Doc as YDoc } from "yjs";
import { usePromiseValue } from "@/lib/async.ts";
import { MySpinner } from "@/components/my-spinner.tsx";
import {
	file_editor_SIZE_MEASURE_CHARS,
	file_editor_get_size_badge_text,
	file_editor_get_size_error_message,
	file_editor_get_size_status_message,
} from "@/lib/file-editor.ts";
import { file_editor_rich_text_SizeLimitExtension } from "@/lib/file-editor-rich-text-size-limit-extension.ts";
import { file_editor_rich_text_MediaExtension } from "./file-editor-rich-text-media-extension.ts";
import { MyButton, MyButtonIcon, type MyButton_Props } from "@/components/my-button.tsx";
import { MyFloatingSurface } from "@/components/my-floating-surface.tsx";
import { FileEditorRichTextToolsInlineAi } from "./file-editor-rich-text-tools-inline-ai.tsx";
import { FileEditorRichTextToolsComment } from "./file-editor-rich-text-tools-comment.tsx";
import { Save, Sparkles } from "lucide-react";
import { FileEditorRichTextDragHandle } from "./file-editor-rich-text-drag-handle.tsx";
import type { EditorBubbleProps } from "../../../../../vendor/novel/packages/headless/src/components/editor-bubble.tsx";
import { bubbleMenuReevaluateVisibility } from "../../../../../vendor/tiptap/packages/extension-bubble-menu/src/index.ts";
import { useDebounce, useFn, useRenderPromise, useStateRef } from "../../../../hooks/utils-hooks.ts";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { useFilesYjs } from "@/hooks/files-hooks.ts";
import type { files_yjs_EditBlockReason } from "@/lib/files-yjs-provider.ts";
import { files_get_thread_ids_from_editor_state } from "../../../../../shared/files-tiptap-comments.ts";
import { global_event_listen_all } from "../../../../lib/global-event.tsx";
import { FileEditorRichTextSkeleton } from "./file-editor-rich-text-skeleton.tsx";

type SyncStatus = YjsSyncStatus;

// #region toolbar
type FileEditorRichTextToolbarActions_ClassNames =
	| "FileEditorRichTextToolbarActions"
	| "FileEditorRichTextToolbarActions-status-badge"
	| "FileEditorRichTextToolbarActions-word-count-badge"
	| "FileEditorRichTextToolbarActions-word-count-badge-hidden"
	| "FileEditorRichTextToolbarActions-size-badge";

/**
 * Shared between the toolbar, which measures the content size, and the editor plugin that
 * rejects growth once the content is over the cap. A ref keeps the measurement out of the
 * editor's render path.
 */
type FileEditorRichTextSizeRef = { current: { isOverCap: boolean } };

type FileEditorRichTextToolbarActions_Props = {
	editor: Editor;
	nodeId: app_convex_Id<"files_nodes">;
	editable: boolean;
	sessionId: string;
	sizeRef: FileEditorRichTextSizeRef;
	syncChanged: boolean;
	syncStatus: SyncStatus;
	toolbarPortalHost: HTMLElement;
};

type FileEditorRichTextToolbarTools_Props = {
	editor: Editor;
	editable: boolean;
};

const FileEditorRichTextToolbarTools = memo(function FileEditorRichTextToolbarTools(
	props: FileEditorRichTextToolbarTools_Props,
) {
	const { editor, editable } = props;

	if (!editable) {
		return null;
	}

	return (
		<>
			<FileEditorRichTextToolsHistoryButtons editor={editor} />
			<MySeparator orientation="vertical" />
			<FileEditorRichTextToolsNodeSelector editor={editor} setDecorationHighlightOnOpen={true} />
			<MySeparator orientation="vertical" />
			<FileEditorRichTextToolsLinkSetter editor={editor} setDecorationHighlightOnOpen={true} />
			<MySeparator orientation="vertical" />
			<FileEditorRichTextToolsMathToggle editor={editor} />
			<MySeparator orientation="vertical" />
			<FileEditorRichTextToolsTextStyles editor={editor} />
			<MySeparator orientation="vertical" />
			<FileEditorRichTextToolsColorSelector editor={editor} setDecorationHighlightOnOpen={true} />
			<MySeparator orientation="vertical" />
			<FileEditorRichTextToolsTable editor={editor} />
			<MySeparator orientation="vertical" />
		</>
	);
});

type FileEditorRichTextToolbarStatus_Props = {
	editor: Editor;
	editable: boolean;
	getCurrentText: () => string;
	nodeId: app_convex_Id<"files_nodes">;
	sessionId: string;
	sizeRef: FileEditorRichTextSizeRef;
	syncChanged: boolean;
	syncStatus: SyncStatus;
};

const FileEditorRichTextToolbarStatus = memo(function FileEditorRichTextToolbarStatus(
	props: FileEditorRichTextToolbarStatus_Props,
) {
	const { editor, editable, getCurrentText, nodeId, sessionId, sizeRef, syncChanged, syncStatus } = props;

	const wordsCount = useEditorState({
		editor,
		selector: ({ editor: currentEditor }) => currentEditor.storage.characterCount.words(),
	});

	// The character count is a cheap lower bound on the Markdown byte size, so serializing the
	// whole document only starts once it is big enough to get near the cap. Serializing a document
	// that big is expensive, so it is debounced and runs when typing pauses, not on every keystroke.
	const charactersCount = useEditorState({
		editor,
		selector: ({ editor: currentEditor }) => currentEditor.storage.characterCount.characters() as number,
	});
	const isWorthMeasuring = charactersCount >= file_editor_SIZE_MEASURE_CHARS;
	const debouncedCharactersCount = useDebounce(charactersCount, 500);

	const [byteSize, setByteSize] = useState<number | null>(null);

	useEffect(() => {
		if (!isWorthMeasuring) {
			setByteSize(null);
			sizeRef.current.isOverCap = false;
			return;
		}

		const nextByteSize = files_get_utf8_byte_size(getCurrentText());
		setByteSize(nextByteSize);
		sizeRef.current.isOverCap = nextByteSize > files_MAX_TEXT_CONTENT_BYTES;
		// `getCurrentText` is a `useFn` wrapper: stable identity, always calling the latest
		// closure. It stays out of the deps because it says nothing about when to re-measure —
		// the debounced character count is what decides that.
	}, [debouncedCharactersCount, isWorthMeasuring, sizeRef]);

	const sizeBadge = file_editor_get_size_badge_text(byteSize);

	return (
		<>
			<MyBadge
				variant="secondary"
				className={cn(
					"FileEditorRichTextToolbarActions-status-badge" satisfies FileEditorRichTextToolbarActions_ClassNames,
				)}
			>
				{/*
					If syncChanged it's false then force to show "Saved" because when the
					editor is mounted the liveblocks syncStatus is stuck to "synchronizing"
					*/}
				{syncStatus === "synchronizing" && syncChanged ? "Unsaved" : "Saved"}
			</MyBadge>
			<MyBadge
				variant="secondary"
				className={cn(
					wordsCount
						? ("FileEditorRichTextToolbarActions-word-count-badge" satisfies FileEditorRichTextToolbarActions_ClassNames)
						: ("FileEditorRichTextToolbarActions-word-count-badge-hidden" satisfies FileEditorRichTextToolbarActions_ClassNames),
				)}
			>
				{wordsCount} Words
			</MyBadge>
			{sizeBadge && (
				<MyBadge
					variant={sizeBadge.isOverCap ? "destructive" : "secondary"}
					className={cn(
						"FileEditorRichTextToolbarActions-size-badge" satisfies FileEditorRichTextToolbarActions_ClassNames,
					)}
				>
					{sizeBadge.label}
				</MyBadge>
			)}
			{/*
				The badge is silent, and over the cap the editor stops accepting input, so without
				this a screen reader user just sees the keyboard stop working.
				*/}
			<span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{file_editor_get_size_status_message({ byteSize, blocks: "editing" })}
			</span>
			<FileEditorSnapshotsModal
				nodeId={nodeId}
				sessionId={sessionId}
				editable={editable}
				getCurrentText={getCurrentText}
			/>
		</>
	);
});

const FileEditorRichTextToolbarActions = memo(function FileEditorRichTextToolbarActions(
	props: FileEditorRichTextToolbarActions_Props,
) {
	const { editor, nodeId, editable, sessionId, sizeRef, syncChanged, syncStatus, toolbarPortalHost } = props;

	const getCurrentText = useFn(() => {
		const markdown = editor.getMarkdown();
		// Match files_yjs_doc_get_text: non-empty file content ends with one `\n`,
		// so the snapshot preview does not show a fake final-newline diff.
		return markdown === "" || markdown.endsWith("\n") ? markdown : markdown + "\n";
	});

	return createPortal(
		<div
			role="group"
			aria-label="Rich text editor actions"
			className={cn("FileEditorRichTextToolbarActions" satisfies FileEditorRichTextToolbarActions_ClassNames)}
		>
			<FileEditorRichTextToolbarTools editor={editor} editable={editable} />
			<FileEditorRichTextToolbarStatus
				editor={editor}
				editable={editable}
				getCurrentText={getCurrentText}
				nodeId={nodeId}
				sessionId={sessionId}
				sizeRef={sizeRef}
				syncChanged={syncChanged}
				syncStatus={syncStatus}
			/>
		</div>,
		toolbarPortalHost,
	);
});
// #endregion toolbar

// #region top sticky floating container
type FileEditorRichTextTopStickyFloatingContainer_ClassNames = "FileEditorRichTextTopStickyFloatingContainer";

type FileEditorRichTextTopStickyFloatingContainer_Props = {
	topStickyFloatingSlot: React.ReactNode;
};

const FileEditorRichTextTopStickyFloatingContainer = memo(function FileEditorRichTextTopStickyFloatingContainer(
	props: FileEditorRichTextTopStickyFloatingContainer_Props,
) {
	const { topStickyFloatingSlot } = props;

	return (
		<div
			className={cn(
				"FileEditorRichTextTopStickyFloatingContainer" satisfies FileEditorRichTextTopStickyFloatingContainer_ClassNames,
			)}
		>
			{topStickyFloatingSlot}
		</div>
	);
});
// #endregion top sticky floating container

// #region bubble content actions
export type FileEditorRichTextBubbleContentActions_ClassNames =
	| "FileEditorRichTextBubbleContentActions"
	| "FileEditorRichTextBubbleContentActions-button"
	| "FileEditorRichTextBubbleContentActions-icon";

type FileEditorRichTextBubbleContentActions_Props = {
	editor: Editor;
	nodeId: app_convex_Id<"files_nodes">;
	/** See `FileEditorRichTextToolsComment_Props`; the bubble threads both comment props through. */
	disabledReason: string | null;
	commitComment?: (threadId: string) => Promise<boolean>;
	/** `null` hides the Ask AI action: the inline AI extension runs on Yjs. */
	onClickAi: MyButton_Props["onClick"] | null;
};

const FileEditorRichTextBubbleContentActions = memo(function FileEditorRichTextBubbleContentActions(
	props: FileEditorRichTextBubbleContentActions_Props,
) {
	const { editor, nodeId, disabledReason, commitComment, onClickAi } = props;

	const handleActionMouseDown = useFn<MyButton_Props["onMouseDown"]>((event) => {
		// Keep the editor selection alive while the bubble action handles the click.
		event.preventDefault();
	});

	const handleActionPointerDown = useFn<MyButton_Props["onPointerDown"]>((event) => {
		// Keep the editor selection alive while the bubble action handles the click.
		event.preventDefault();
	});

	return (
		<div
			className={cn(
				"FileEditorRichTextBubbleContentActions" satisfies FileEditorRichTextBubbleContentActions_ClassNames,
			)}
		>
			{onClickAi != null && (
				<MyButton
					variant="floating"
					className={cn(
						"FileEditorRichTextBubbleContentActions-button" satisfies FileEditorRichTextBubbleContentActions_ClassNames,
					)}
					onPointerDown={handleActionPointerDown}
					onMouseDown={handleActionMouseDown}
					onClick={onClickAi}
				>
					<MyButtonIcon
						className={cn(
							"FileEditorRichTextBubbleContentActions-icon" satisfies FileEditorRichTextBubbleContentActions_ClassNames,
						)}
					>
						<Sparkles />
					</MyButtonIcon>
					Ask AI
				</MyButton>
			)}
			<FileEditorRichTextToolsNodeSelector editor={editor} buttonVariant="floating" />
			<FileEditorRichTextToolsLinkSetter editor={editor} buttonVariant="floating" />
			<FileEditorRichTextToolsMathToggle editor={editor} buttonVariant="floating" />
			<FileEditorRichTextToolsTextStyles editor={editor} buttonVariant="floating" />
			<FileEditorRichTextToolsColorSelector editor={editor} buttonVariant="floating" />
			<FileEditorRichTextToolsComment
				editor={editor}
				fileNodeId={nodeId}
				disabledReason={disabledReason}
				commitComment={commitComment}
				buttonVariant="floating"
			/>
		</div>
	);
});
// #endregion bubble content actions

// #region bubble content
export type FileEditorRichTextBubbleContent_ClassNames = "FileEditorRichTextBubbleContent";

type FileEditorRichTextBubbleContent_Props = {
	editor: Editor;
	nodeId: app_convex_Id<"files_nodes">;
	/** See `FileEditorRichTextToolsComment_Props`; the bubble threads both comment props through. */
	disabledReason: string | null;
	commitComment?: (threadId: string) => Promise<boolean>;
	openAi: boolean;
	portalElement: HTMLElement | null;
	onPortalRef: (inst: HTMLDivElement | null) => void;
	onClickAi: MyButton_Props["onClick"] | null;
	onDiscardAi: () => void;
};

const FileEditorRichTextBubbleContent = memo(function FileEditorRichTextBubbleContent(
	props: FileEditorRichTextBubbleContent_Props,
) {
	const { editor, nodeId, disabledReason, commitComment, openAi, portalElement, onPortalRef, onClickAi, onDiscardAi } =
		props;

	return (
		<MyFloatingSurface
			ref={onPortalRef}
			className={cn("FileEditorRichTextBubbleContent" satisfies FileEditorRichTextBubbleContent_ClassNames)}
		>
			{openAi && <FileEditorRichTextToolsInlineAi editor={editor} onDiscard={onDiscardAi} />}
			{!openAi && portalElement ? (
				<FileEditorRichTextBubbleContentActions
					editor={editor}
					nodeId={nodeId}
					disabledReason={disabledReason}
					commitComment={commitComment}
					onClickAi={onClickAi}
				/>
			) : null}
		</MyFloatingSurface>
	);
});
// #endregion bubble content

// #region bubble

// Derived from Liveblocks:
// liveblocks\examples\nextjs-tiptap-novel\src\components\editor\generative\generative-menu-switch.tsx

export type FileEditorRichTextBubble_ClassNames = "FileEditorRichTextBubble" | "FileEditorRichTextBubble-rendered";

export type FileEditorRichTextBubble_Props = {
	editor: Editor;
	nodeId: app_convex_Id<"files_nodes">;
	/** See `FileEditorRichTextToolsComment_Props`; the bubble threads both comment props through. */
	disabledReason: string | null;
	commitComment?: (threadId: string) => Promise<boolean>;
	/** Ask AI runs on the Yjs-backed inline AI extension, so the non-collaborative editor hides it. */
	showAiAction: boolean;
};

/**
 * Bubble menu visibility rules (TipTap/Novel + local overrides).
 *
 * The bubble is configured to hide when:
 * - The user interacts outside the editor/bubble (global `pointerdown`)
 * - The current selection is collapsed / empty (TipTap/Novel `shouldShow`)
 * - The user presses Escape while no bubble popover is open (Escape handlers hide the bubble)
 * - A primary pointer selection gesture is still active on the editor (after `pointerdown` on the
 *   editor surface until `pointerup` / `pointercancel`, or until `window` `blur` clears the gate)
 *
 * It prevents the default behavior from closing when:
 * - Focus moves inside the bubble itself (TipTap `isChildOfMenu`)
 * - The user interacts with portaled/hoisted popovers opened from the bubble (`isElContainedInManagedAreas`)
 * - The user presses Escape to close a popover in the bubble (popover closes, bubble stays visible)
 */
export const FileEditorRichTextBubble = memo(function FileEditorRichTextBubble(props: FileEditorRichTextBubble_Props) {
	const { editor, nodeId, disabledReason, commitComment, showAiAction } = props;

	const bubbleSurfaceRef = useRef<HTMLDivElement>(null);
	const isShownRef = useRef(false);
	/**
	 * Keep this true until the current editor pointer gesture ends.
	 */
	const isPointerSelectingRef = useRef(false);

	const [portalElement, setPortalElement] = useState<HTMLElement | null>(null);
	/**
	 * A ref because the bubble listeners are registered once on mount and would
	 * otherwise keep reading the value captured on the first render.
	 */
	const [renderedRef, setRendered, rendered] = useStateRef(true);

	const [openAi, setOpenAi] = useState(false);

	const renderPromise = useRenderPromise();

	/**
	 * The container for the tiptap hoisted elements.
	 * Used by the bubble to allow it to close when clicking on
	 * focusable elements in the file because it checks for the parent
	 * element to contain the focus relatedTarget and if the bubble
	 * is hoisted in the body, the body will always contain the focus relatedTarget
	 * preventing the bubble from closing.
	 */
	const hoistingContainer = document.getElementById("app_tiptap_hoisting_container" satisfies AppElementId);

	const updateBubbleMenuPosition = useFn(() => {
		editor.view.dispatch(editor.state.tr.setMeta("bubbleMenu", "updatePosition"));
	});

	const shouldShow = useFn<NonNullable<EditorBubbleProps["shouldShow"]>>((params) => {
		// Close the bubble if nothing is focused.
		if (document.activeElement === document.body) {
			return false;
		}

		// Leverage the fact that shouldShow is called only when the selection
		// changes in the editor (and when the bubble menui plugin is registered)
		// so if the focus moves into an element that
		// is "allowed" and should not cause the bubble to close, we keep it open.
		// Here we keep it open if the focus goes into an hoisted element or inside
		// the bubble itself.
		// We should not check if the focus is in the editor otherwise we end-up
		// showing the bubble everytime the selection is in the editor.
		if (
			check_element_is_in_allowed_areas(document.activeElement, {
				allowedAreas: [bubbleSurfaceRef.current],
				restrictionScope: document.getElementById("root" satisfies AppElementId),
			})
		) {
			return true;
		}

		// Keep the bubble hidden until pointerup ends the gesture.
		if (isPointerSelectingRef.current) {
			return false;
		}

		const novelResult = EditorBubble.novelShouldShowImpl(params);

		return novelResult;
	});

	const handleHide = useFn<NonNullable<EditorBubbleProps["options"]>["onHide"]>(() => {
		isShownRef.current = false;

		// Reset rendered state so it's already `true` on show
		setRendered(true);

		setOpenAi(false);

		FileEditorRichText.clearDecorationHighlightProperly(editor);
	});

	const handleShow = useFn<NonNullable<EditorBubbleProps["options"]>["onShow"]>(() => {
		isShownRef.current = true;

		editor.commands.setDecorationHighlight();
	});

	// Handle Escape while focus stays inside the bubble.
	const handleKeyDown = useFn<EditorBubbleProps["onKeyDown"]>((event) => {
		if (event.key === "Escape" && event.currentTarget.contains(event.target as HTMLElement)) {
			setRendered(false);
			editor.commands.focus();
		}
	});

	const handleClickAi = useFn<MyButton_Props["onClick"]>(() => {
		setOpenAi(true);

		// Recalculate the bubble menu position after the AI component is rendered
		renderPromise
			.wait()
			.then(() => {
				updateBubbleMenuPosition();
			})
			.catch((error) => {
				console.error("[FileEditorRichText.handleClickAi] Error updating bubble menu position", { error });
			});
	});

	const handleDiscardAi = useFn(() => {
		setOpenAi(false);
	});

	const handlePortalElementRef = useFn((inst: HTMLDivElement | null) => {
		setPortalElement(inst);
	});

	// Set up bubble-menu listeners on mount.
	useEffect(() => {
		// Mount once to avoid duplicate TipTap plugin setup.
		const mountTask = () => {
			const rootElement = document.getElementById("root" satisfies AppElementId);

			// Register Escape handling for the editor bubble.
			const bubbleEscPluginKey = new PluginKey("FileEditorRichTextBubble_escape_key_handler");
			const plugin = new Plugin({
				props: {
					handleKeyDown: (_view, event) => {
						if (event.key !== "Escape") {
							return false;
						}

						setRendered(false);
						editor.commands.focus();

						return true;
					},
				},
			});

			editor.registerPlugin(plugin);

			// Reapply the highlight when the bubble is shown.
			const handleSelectionUpdate = () => {
				// Skip while a pointer gesture is in flight. `isShownRef` stays true until the
				// bubble actually hides, so without this a double-click made while the bubble is
				// open re-decorates from inside ProseMirror's mousedown handling, mutating the DOM
				// under a live native selection. It buys nothing: the decoration only paints when
				// the editor is not focused, and `handleShow` reapplies it once the gesture ends.
				if (isPointerSelectingRef.current) {
					return;
				}

				if (
					isShownRef.current &&
					renderedRef.current &&
					!editor.state.selection.empty &&
					editor.state.selection.from !== editor.state.selection.to
				) {
					editor.chain().clearDecorationHighlight().setDecorationHighlight().run();
				}
			};
			editor.on("selectionUpdate", handleSelectionUpdate);

			// Clear the pointer gate on lift, cancel, or blur.
			const clearPointerSelectingEndListeners = global_event_listen_all(["pointerup", "pointercancel", "blur"], () => {
				const wasSelecting = isPointerSelectingRef.current;
				isPointerSelectingRef.current = false;

				// Re-check bubble visibility on pointerup so it can show after the gesture ends.
				if (wasSelecting) {
					bubbleMenuReevaluateVisibility(editor);
				}
			});

			// Track editor pointer gestures.
			const clearEventListeners = global_event_listen_all(
				["keydown", "pointerdown"],
				(event) => {
					if (
						event.type === "pointerdown" &&
						event instanceof PointerEvent &&
						event.isPrimary &&
						(event.pointerType !== "mouse" || event.button === 0)
					) {
						const target = event.target;
						if (
							target instanceof Node &&
							editor.view.dom.contains(target) &&
							!bubbleSurfaceRef.current?.contains(target)
						) {
							isPointerSelectingRef.current = true;
						}
					}

					// Dismiss only while the bubble is visible.
					if (!isShownRef.current) {
						return;
					}

					const targetIsInManagedAreas = check_element_is_in_allowed_areas(event.target as HTMLElement, {
						allowedAreas: [bubbleSurfaceRef.current, editor.view.dom],
						restrictionScope: rootElement,
					});

					const activeElementIsInManagedAreasOnPointerDown =
						event instanceof PointerEvent
							? check_element_is_in_allowed_areas(document.activeElement, {
									allowedAreas: [bubbleSurfaceRef.current, editor.view.dom],
									restrictionScope: rootElement,
								})
							: undefined;

					const focusMovingOutOfManagedAreasOnPointerDown =
						event instanceof PointerEvent
							? activeElementIsInManagedAreasOnPointerDown === true && targetIsInManagedAreas === false
							: undefined;

					if (
						(event instanceof KeyboardEvent && event.key === "Escape" && targetIsInManagedAreas) ||
						(event instanceof PointerEvent && focusMovingOutOfManagedAreasOnPointerDown === true)
					) {
						setRendered(false);
						FileEditorRichText.clearDecorationHighlightProperly(editor);

						if (event instanceof KeyboardEvent) {
							event.preventDefault();
						}
					}
				},
				{ capture: true },
			);

			return () => {
				clearPointerSelectingEndListeners();

				editor.unregisterPlugin(bubbleEscPluginKey);
				editor.off("selectionUpdate", handleSelectionUpdate);
				clearEventListeners();
			};
		};
		let cleanup: ReturnType<typeof mountTask> | undefined = undefined;
		const timeoutId = setTimeout(() => {
			cleanup = mountTask();
		});

		return () => {
			clearTimeout(timeoutId);
			cleanup?.();
		};
	}, []);

	const bubbleOptions = {
		placement: "bottom-start",
		flip: false,
		shift: {
			padding: 120,
		},
		onHide: handleHide,
		onShow: handleShow,
	} satisfies NonNullable<EditorBubbleProps["options"]>;

	return hoistingContainer ? (
		<EditorBubble
			ref={bubbleSurfaceRef}
			className={cn(
				"FileEditorRichTextBubble" satisfies FileEditorRichTextBubble_ClassNames,
				rendered && ("FileEditorRichTextBubble-rendered" satisfies FileEditorRichTextBubble_ClassNames),
			)}
			appendTo={hoistingContainer}
			shouldShow={shouldShow}
			options={bubbleOptions}
			onKeyDown={handleKeyDown}
		>
			<FileEditorRichTextBubbleContent
				editor={editor}
				nodeId={nodeId}
				disabledReason={disabledReason}
				commitComment={commitComment}
				openAi={openAi}
				portalElement={portalElement}
				onPortalRef={handlePortalElementRef}
				onClickAi={showAiAction ? handleClickAi : null}
				onDiscardAi={handleDiscardAi}
			/>
		</EditorBubble>
	) : null;
});
// #endregion bubble

// #region anchored comments layer
type FileEditorRichTextAnchoredCommentsLayer_Props = {
	commentsPortalHost: HTMLElement | null;
	editor: Editor;
	editable: boolean;
	isEditorReady: boolean;
};

const FileEditorRichTextAnchoredCommentsLayer = memo(function FileEditorRichTextAnchoredCommentsLayer(
	props: FileEditorRichTextAnchoredCommentsLayer_Props,
) {
	const { commentsPortalHost, editor, editable, isEditorReady } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const threadIdsKey = useEditorState({
		editor,
		selector: ({ editor: currentEditor }) =>
			files_get_thread_ids_from_editor_state(currentEditor.state).toSorted().join("\n"),
	});

	const threadIds = threadIdsKey ? threadIdsKey.split("\n") : [];

	const threadsQuery = useStableQuery(
		app_convex_api.chat_messages.chat_messages_threads_list,
		threadIds.length > 0
			? {
					membershipId,
					threadIds,
					isArchived: false,
				}
			: "skip",
	);

	useEffect(() => {
		if (!isEditorReady || !threadsQuery || threadIds.length === 0) {
			return;
		}

		const activeThreadIds = new Set(threadsQuery.threads.map((thread) => thread.id as string));
		const threadsToUpdate = threadIds.map((threadId) => ({
			threadId,
			orphan: !activeThreadIds.has(threadId),
		}));

		if (threadsToUpdate.length > 0) {
			editor.commands.command(({ commands }) => {
				threadsToUpdate.forEach(({ threadId, orphan }) => {
					commands.markCommentAsOrphan({ threadId, orphan });
				});
				return true;
			});
		}
	}, [editor, isEditorReady, threadIds, threadsQuery]);

	if (!commentsPortalHost) {
		return null;
	}

	return createPortal(
		<FileEditorRichTextAnchoredComments editor={editor} editable={editable} threads={threadsQuery?.threads} />,
		commentsPortalHost,
	);
});
// #endregion anchored comments layer

// #region root
export type FileEditorRichText_ClassNames =
	| "FileEditorRichText"
	| "FileEditorRichText-visible"
	| "FileEditorRichText-load-error"
	| "FileEditorRichText-push-refused"
	| "FileEditorRichText-refusal"
	| "FileEditorRichText-editor-content-root"
	| "FileEditorRichText-editor-content-container"
	| "FileEditorRichText-editor-content"
	| "FileEditorRichText-status-badge"
	| "FileEditorRichText-word-count-badge"
	| "FileEditorRichText-word-count-badge-hidden";

type FileEditorRichTextInner_Props = {
	filesYjs: NonNullable<ReturnType<typeof useFilesYjs>>;
	nodeId: app_convex_Id<"files_nodes">;
	editable: boolean;
	presenceStore: files_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	topStickyFloatingSlot?: React.ReactNode;
};

function FileEditorRichTextInner(props: FileEditorRichTextInner_Props) {
	const { filesYjs, nodeId, editable, presenceStore, commentsPortalHost, toolbarPortalHost, topStickyFloatingSlot } =
		props;

	const { membershipId } = AppTenantProvider.useContext();

	const [editor, setEditor] = useState<Editor | null>(null);

	const isEditorReady = filesYjs.syncStatus === "synchronizing" || filesYjs.syncStatus === "synchronized";

	const liveblocks = useFileEditorRichTextExtension({
		field: files_YJS_DOC_KEYS.richText,
		presenceStore,
		yjsProvider: filesYjs.yjsProvider,
		ai: {
			name: AI_NAME,
			resolveContextualPrompt: async ({ prompt, context, previous, signal }: any) => {
				const result = await app_fetch_ai_docs_contextual_prompt({
					input: { prompt, context, previous, membershipId, requestId: crypto.randomUUID() },
					signal,
				});

				if (result._yay) {
					return result._yay.payload;
				} else {
					throw new Error("[FileEditorRichText.resolveContextualPrompt] Failed to resolve contextual prompt", {
						cause: result._nay,
					});
				}
			},
		},
	});

	const sizeRef = useRef({ isOverCap: false });

	const getIsOverCap = useFn(() => sizeRef.current.isOverCap);

	const sizeLimit = file_editor_rich_text_SizeLimitExtension.configure({ getIsOverCap });

	const media = file_editor_rich_text_MediaExtension.configure({ membershipId });

	const imageUploadInputRef = useRef<HTMLInputElement>(null);
	const videoUploadInputRef = useRef<HTMLInputElement>(null);
	const [embedPickerAnchorRect, setEmbedPickerAnchorRect] = useState<{
		x: number;
		y: number;
		width: number;
		height: number;
	} | null>(null);

	// Click the input synchronously: the browser only opens a file dialog while the user
	// gesture that ran the slash command is still active.
	const pickMediaUploadFile = useFn((kind: "image" | "video") => {
		(kind === "image" ? imageUploadInputRef : videoUploadInputRef).current?.click();
	});

	const openEmbedExistingPicker = useFn(() => {
		if (!editor) {
			return;
		}

		// Anchor the picker to the caret; the slash item already deleted the "/..." text.
		const caretRect = editor.view.coordsAtPos(editor.state.selection.from);
		setEmbedPickerAnchorRect({
			x: caretRect.left,
			y: caretRect.top,
			width: 1,
			height: caretRect.bottom - caretRect.top,
		});
	});

	const handleEmbedPickerClose = useFn(() => {
		setEmbedPickerAnchorRect(null);
	});

	const handleMediaUploadInputChange = useFn((event: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.currentTarget.files ?? []);
		// Reset so picking the same file twice in a row still fires a change event.
		event.currentTarget.value = "";
		if (files.length === 0 || !editor || !editable) {
			return;
		}

		file_editor_rich_text_upload_media_files({
			view: editor.view,
			files,
			source: "file",
			membershipId,
			documentNodeId: nodeId,
		});
	});

	const mediaInsert = file_editor_rich_text_MediaInsertExtension.configure({
		pickUploadFile: pickMediaUploadFile,
		openEmbedExistingPicker,
	});

	const extensions = [
		...defaultExtensions,
		FileEditorRichTextToolsSlashCommand.slashCommand,
		liveblocks,
		sizeLimit,
		media,
		mediaInsert,
	];

	const handleCreate: EditorContentProps["onCreate"] = ({ editor }) => {
		setEditor(editor);
	};

	// Same pattern as the comments composer: the editor instance is created once, so a later answer
	// to "may this user write here" has to go through `setEditable`.
	useEffect(() => {
		if (editor) {
			editor.setEditable(editable, false);
		}
	}, [editor, editable]);

	/**
	 * Reject content that would push the document over the size cap. Every keystroke in this
	 * editor persists, so pasted and dropped content has to be checked before it lands.
	 * The size is measured exactly here rather than read from `sizeRef`, which is debounced:
	 * a paste is a one-off user action, so one serialization is affordable and never stale.
	 */
	const checkIncomingContentFitsSizeCap = useFn((incomingText: string) => {
		if (!editor || !incomingText) {
			return true;
		}

		const nextByteSize = files_get_utf8_byte_size(editor.getMarkdown()) + files_get_utf8_byte_size(incomingText);
		if (nextByteSize <= files_MAX_TEXT_CONTENT_BYTES) {
			return true;
		}

		toast.error(file_editor_get_size_error_message(nextByteSize));
		return false;
	});

	const pushRefusedMessage =
		filesYjs.pushRefusedReason === "read_only"
			? "This file became read-only, so your unsaved changes were not saved. The saved version was reloaded."
			: filesYjs.pushRefusedReason === "permission"
				? "You no longer have permission to edit this file. Your unsaved changes were not saved."
				: filesYjs.pushRefusedReason === "other"
					? "Your latest changes were not saved. The server refused the update. New edits will retry it. If this message stays, copy your changes and reload."
					: null;

	return (
		<>
			{/* Keep this outside the root div: the root stays display:none until the editor is
			    ready, and the load failure must also be visible over the loading skeleton. */}
			{filesYjs.loadFailed && (
				<div className={"FileEditorRichText-load-error" satisfies FileEditorRichText_ClassNames} role="alert">
					Can't load this document right now. Retrying — check your connection.
				</div>
			)}
			{/* Network and rate-limit errors keep retrying and do not reach this alert. Show the
			    final server refusal so the user knows why the edits stopped. */}
			{!filesYjs.loadFailed && pushRefusedMessage && (
				<div className={"FileEditorRichText-push-refused" satisfies FileEditorRichText_ClassNames} role="alert">
					{pushRefusedMessage}
				</div>
			)}
			<div
				className={cn(
					"FileEditorRichText" satisfies FileEditorRichText_ClassNames,
					// Due to some weird combination of things, if the EditorContent component is not rendered
					// it results in it creating the TipTap Editor instance twice causing issues when
					// the server-owned Yjs state hydrates, therefore the component has to be rendered but
					// hidden via CSS to prevent incomplete content from showing while all the things are loading.
					isEditorReady && ("FileEditorRichText-visible" satisfies FileEditorRichText_ClassNames),
				)}
			>
				<input
					ref={imageUploadInputRef}
					type="file"
					accept="image/*"
					multiple
					aria-hidden="true"
					tabIndex={-1}
					style={{ display: "none" }}
					onChange={handleMediaUploadInputChange}
				/>
				<input
					ref={videoUploadInputRef}
					type="file"
					accept="video/*"
					multiple
					aria-hidden="true"
					tabIndex={-1}
					style={{ display: "none" }}
					onChange={handleMediaUploadInputChange}
				/>
				{editor && embedPickerAnchorRect && (
					<FileEditorRichTextMediaEmbedPicker
						editor={editor}
						membershipId={membershipId}
						anchorRect={embedPickerAnchorRect}
						onClose={handleEmbedPickerClose}
					/>
				)}
				{editor && (
					<FileEditorRichTextToolbarActions
						editor={editor}
						nodeId={nodeId}
						editable={editable}
						sessionId={presenceStore.localSessionId}
						sizeRef={sizeRef}
						syncChanged={filesYjs.syncChanged}
						syncStatus={filesYjs.syncStatus}
						toolbarPortalHost={toolbarPortalHost}
					/>
				)}
				<FileEditorRichTextTopStickyFloatingContainer topStickyFloatingSlot={topStickyFloatingSlot} />
				<EditorContent
					className={cn("FileEditorRichText-editor-content-root" satisfies FileEditorRichText_ClassNames)}
					injectCSS={false}
					editorContainerProps={{
						className: cn("FileEditorRichText-editor-content-container" satisfies FileEditorRichText_ClassNames),
					}}
					editorProps={{
						attributes: {
							class: cn(
								"app-doc" satisfies AppClassName,
								"FileEditorRichText-editor-content" satisfies FileEditorRichText_ClassNames,
							),
						},
						handleDOMEvents: {
							keydown: (_view, event) => handleCommandNavigation(event),
						},
						// ProseMirror treats true as handled. A settled read-only view skips these handlers on
						// its own, but the view's read-only gate lands one `setEditable` effect later than the
						// React render, so block a paste or drop that arrives in that window here and in
						// `handleDrop` below.
						handlePaste: (view, event) => {
							if (!editable) {
								return true;
							}
							if (checkIncomingContentFitsSizeCap(event.clipboardData?.getData("text/plain") ?? "") === false) {
								return true;
							}
							return file_editor_rich_text_handle_media_paste({ view, event, membershipId, documentNodeId: nodeId });
						},
						handleDrop: (view, event, _slice, moved) => {
							if (!editable) {
								return true;
							}
							// `moved` is an internal drag, so the content is only relocated, not added.
							if (
								!moved &&
								checkIncomingContentFitsSizeCap(event.dataTransfer?.getData("text/plain") ?? "") === false
							) {
								return true;
							}
							return file_editor_rich_text_handle_media_drop({
								view,
								event,
								moved,
								membershipId,
								documentNodeId: nodeId,
							});
						},
					}}
					extensions={extensions}
					editable={editable}
					immediatelyRender={false}
					onCreate={handleCreate}
					slotAfter={
						editor && editable ? (
							<>
								<ImageResizer />
								<FileEditorRichTextToolsSlashCommand />
								<FileEditorRichTextDragHandle editor={editor} />
								<FileEditorRichTextBubble editor={editor} nodeId={nodeId} disabledReason={null} showAiAction={true} />
							</>
						) : null
					}
				></EditorContent>
			</div>
			{editor && (
				<FileEditorRichTextAnchoredCommentsLayer
					commentsPortalHost={commentsPortalHost}
					editor={editor}
					editable={editable}
					isEditorReady={isEditorReady}
				/>
			)}
			{!isEditorReady && <FileEditorRichTextSkeleton />}
		</>
	);
}

export type FileEditorRichText_CustomAttributes = {
	"data-app-set-decoration-highlight": "";
};

export type FileEditorRichText_BgColorCssVarKeys =
	| "--FileEditorRichText-text-color-bg-default"
	| "--FileEditorRichText-text-color-bg-purple"
	| "--FileEditorRichText-text-color-bg-red"
	| "--FileEditorRichText-text-color-bg-yellow"
	| "--FileEditorRichText-text-color-bg-blue"
	| "--FileEditorRichText-text-color-bg-green"
	| "--FileEditorRichText-text-color-bg-orange"
	| "--FileEditorRichText-text-color-bg-pink"
	| "--FileEditorRichText-text-color-bg-gray";

export type FileEditorRichText_FgColorCssVarKeys =
	| "--FileEditorRichText-text-color-fg-default"
	| "--FileEditorRichText-text-color-fg-purple"
	| "--FileEditorRichText-text-color-fg-red"
	| "--FileEditorRichText-text-color-fg-yellow"
	| "--FileEditorRichText-text-color-fg-blue"
	| "--FileEditorRichText-text-color-fg-green"
	| "--FileEditorRichText-text-color-fg-orange"
	| "--FileEditorRichText-text-color-fg-pink"
	| "--FileEditorRichText-text-color-fg-gray";

export type FileEditorRichText_Props = React.ComponentProps<"div"> & {
	nodeId: app_convex_Id<"files_nodes">;
	yjsLastSequenceId: app_convex_Id<"files_yjs_docs_last_sequences">;
	editable: boolean;
	editBlockReason: files_yjs_EditBlockReason | null;
	presenceStore: files_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	topStickyFloatingSlot?: React.ReactNode;
};

export function FileEditorRichText(props: FileEditorRichText_Props) {
	const {
		nodeId,
		yjsLastSequenceId,
		editable,
		editBlockReason,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		topStickyFloatingSlot,
		...rest
	} = props;

	const { membershipId } = AppTenantProvider.useContext();

	const filesYjs = useFilesYjs({
		nodeId: nodeId,
		yjsLastSequenceId,
		membershipId,
		presenceStore,
		editable,
		editBlockReason,
	});

	return (
		// remount on provider ownership to prevent stale state on file changes
		<EditorRoot key={filesYjs?.providerNodeId ?? null}>
			{filesYjs ? (
				<FileEditorRichTextInner
					filesYjs={filesYjs}
					nodeId={nodeId}
					editable={editable}
					presenceStore={presenceStore}
					commentsPortalHost={commentsPortalHost}
					toolbarPortalHost={toolbarPortalHost}
					{...rest}
					topStickyFloatingSlot={topStickyFloatingSlot}
				/>
			) : (
				<FileEditorRichTextSkeleton />
			)}
		</EditorRoot>
	);
}

/**
 * Using `clearDecorationHighlight` can have unexpected results because DOM selection
 * can behave in unxepected ways in certain situations like when the editor is not in focus,
 * and relying on an artificial highlight using decoration also have non-trivial side effects.
 *
 * This functions aims to perform all the operations necessary to clear
 * the decoration highlight properly to deliver a good UI.
 *
 * @param editor - The TipTap editor instance
 * @param triggerElement - Optional trigger element (e.g., button) that opens the popover.
 *                         If provided and matches document.activeElement, the decoration will be cleared.
 */
FileEditorRichText.clearDecorationHighlightProperly = (editor: Editor, triggerElement?: HTMLElement | null) => {
	// TODO: this line of code below seems not necessary anymore, it's causins the selection
	// to briefly flash when closing the bubble with Esc
	//
	// if the decorations are cleared while the editor is not in focus
	// the browser will set an incorrect text selection range, therefore
	// the DOM selection needs to be removed or it will look wrong.
	// document.getSelection()?.removeAllRanges();

	setTimeout(() => {
		const hasDecorationHighlight = editor.view.dom.querySelector("[data-decoration-highlight='true']");
		if (!hasDecorationHighlight) {
			return;
		}

		const activeElement = document.activeElement;
		const isTriggerActive = triggerElement && activeElement === triggerElement;
		const elementSetDecorationHighlight =
			activeElement?.getAttribute(
				"data-app-set-decoration-highlight" satisfies keyof FileEditorRichText_CustomAttributes,
			) == null;

		if (isTriggerActive || elementSetDecorationHighlight) {
			// Do not focus the editor here, otherwise it will conflict with ariakit when opening
			// popovers while a non-collapsed selection is present in the editor.
			//
			// editor.chain().clearDecorationHighlight().focus().run();
			editor.commands.clearDecorationHighlight();
		}
	});
};
// #endregion root

// #region non-collaborative toolbar
type FileEditorRichTextNonCollabToolbarActions_ClassNames =
	| "FileEditorRichTextNonCollabToolbarActions"
	| "FileEditorRichTextNonCollabToolbarActions-button"
	| "FileEditorRichTextNonCollabToolbarActions-icon"
	| "FileEditorRichTextNonCollabToolbarActions-reformat-hint"
	| "FileEditorRichTextNonCollabToolbarActions-word-count-badge"
	| "FileEditorRichTextNonCollabToolbarActions-word-count-badge-hidden"
	| "FileEditorRichTextNonCollabToolbarActions-size-badge";

type FileEditorRichTextNonCollabToolbarActions_Props = {
	editor: Editor;
	nodeId: app_convex_Id<"files_nodes">;
	editable: boolean;
	sessionId: string;
	byteSize: number;
	isSaveDisabled: boolean;
	isSaveDebouncing: boolean;
	/** The serializer's output differs from the stored bytes, so the first save reformats the file. */
	showReformatHint: boolean;
	nonCollaborativeBaseAssetId: app_convex_Id<"files_r2_assets">;
	toolbarPortalHost: HTMLElement;
	getCurrentText: () => string;
	onApplySnapshotText: (text: string) => void;
	onClickSave: () => void;
};

const FileEditorRichTextNonCollabToolbarActions = memo(function FileEditorRichTextNonCollabToolbarActions(
	props: FileEditorRichTextNonCollabToolbarActions_Props,
) {
	const {
		editor,
		nodeId,
		editable,
		sessionId,
		byteSize,
		isSaveDisabled,
		isSaveDebouncing,
		showReformatHint,
		nonCollaborativeBaseAssetId,
		toolbarPortalHost,
		getCurrentText,
		onApplySnapshotText,
		onClickSave,
	} = props;

	const wordsCount = useEditorState({
		editor,
		selector: ({ editor: currentEditor }) => currentEditor.storage.characterCount.words(),
	});

	const sizeBadge = file_editor_get_size_badge_text(byteSize);

	return createPortal(
		<div
			role="group"
			aria-label="Rich text editor actions"
			className={cn(
				"FileEditorRichTextNonCollabToolbarActions" satisfies FileEditorRichTextNonCollabToolbarActions_ClassNames,
				// Intentional style reuse: same row layout as the collaborative toolbar in this file.
				"FileEditorRichTextToolbarActions" satisfies FileEditorRichTextToolbarActions_ClassNames,
			)}
		>
			<FileEditorRichTextToolbarTools editor={editor} editable={editable} />
			{/* No sync status here: the file has no live sync, so Save is the only way out. */}
			<MyButton
				variant="ghost-highlightable"
				className={cn(
					"FileEditorRichTextNonCollabToolbarActions-button" satisfies FileEditorRichTextNonCollabToolbarActions_ClassNames,
				)}
				disabled={isSaveDisabled}
				aria-busy={isSaveDebouncing}
				onClick={onClickSave}
			>
				<MyButtonIcon
					className={cn(
						"FileEditorRichTextNonCollabToolbarActions-icon" satisfies FileEditorRichTextNonCollabToolbarActions_ClassNames,
					)}
				>
					{isSaveDebouncing ? <MySpinner aria-label="Checking" /> : <Save />}
				</MyButtonIcon>
				Save
			</MyButton>
			{/* Required warning: the first save may rewrite lines the member never touched, and
			    this is the only notice they get before it. */}
			{showReformatHint && (
				<span
					className={cn(
						"FileEditorRichTextNonCollabToolbarActions-reformat-hint" satisfies FileEditorRichTextNonCollabToolbarActions_ClassNames,
					)}
				>
					Saving from the rich editor will reformat this file's Markdown.
				</span>
			)}
			<MyBadge
				variant="secondary"
				className={cn(
					// Intentional style reuse from the collaborative toolbar in this file, next to the
					// local identity class.
					wordsCount
						? cn(
								"FileEditorRichTextNonCollabToolbarActions-word-count-badge" satisfies FileEditorRichTextNonCollabToolbarActions_ClassNames,
								"FileEditorRichTextToolbarActions-word-count-badge" satisfies FileEditorRichTextToolbarActions_ClassNames,
							)
						: cn(
								"FileEditorRichTextNonCollabToolbarActions-word-count-badge-hidden" satisfies FileEditorRichTextNonCollabToolbarActions_ClassNames,
								"FileEditorRichTextToolbarActions-word-count-badge-hidden" satisfies FileEditorRichTextToolbarActions_ClassNames,
							),
				)}
			>
				{wordsCount} Words
			</MyBadge>
			{sizeBadge && (
				<MyBadge
					variant={sizeBadge.isOverCap ? "destructive" : "secondary"}
					className={cn(
						// Intentional style reuse from the collaborative toolbar in this file, next to
						// the local identity class.
						"FileEditorRichTextNonCollabToolbarActions-size-badge" satisfies FileEditorRichTextNonCollabToolbarActions_ClassNames,
						"FileEditorRichTextToolbarActions-size-badge" satisfies FileEditorRichTextToolbarActions_ClassNames,
					)}
				>
					{sizeBadge.label}
				</MyBadge>
			)}
			{/*
				The badge is silent, so without this a screen reader user only finds out the file
				is too big when Save is rejected.
				*/}
			<span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{file_editor_get_size_status_message({ byteSize, blocks: "saving" })}
			</span>
			<FileEditorSnapshotsModal
				nodeId={nodeId}
				sessionId={sessionId}
				editable={editable}
				nonCollaborativeBaseAssetId={nonCollaborativeBaseAssetId}
				getCurrentText={getCurrentText}
				onApplySnapshotText={onApplySnapshotText}
			/>
		</div>,
		toolbarPortalHost,
	);
});
// #endregion non-collaborative toolbar

// #region non-collaborative inner

// The replace door names this exact message when `baseAssetId` no longer matches the stored
// asset. The comment save dispatches its merge retry on it.
const REPLACE_FILE_STALENESS_MESSAGE =
	"This file changed while you were saving. Copy your local changes before reloading, then try again.";

/**
 * Serialize the mounted editor the way `files_yjs_doc_get_text` writes a file: non-empty content
 * ends with exactly one `\n`. The stored bytes of a non-collaborative file come from THIS
 * serializer, so the dirty baseline, Save, and the comment save must all go through it.
 */
function serialize_editor_markdown(editor: Editor) {
	const markdown = editor.getMarkdown();
	return markdown === "" || markdown.endsWith("\n") ? markdown : markdown + "\n";
}

/**
 * Replace the whole editor document from Markdown by swapping the editor state.
 * `commands.setContent` fits the new blocks into the old document with a ProseMirror replace
 * step, and that fitting appends an empty trailing paragraph when the content ends in an atom
 * block (a trailing video embed, for example). Same rule as `headless_editor_replace_doc` in
 * `shared/files-tiptap.ts`, which is module-private.
 */
function replace_editor_document(mut_editor: Editor, markdown: string) {
	const json = files_tiptap_markdown_to_json({ markdown, extensions: nonCollaborativeExtensions });
	if (json._nay) {
		return json;
	}

	mut_editor.view.updateState(
		EditorState.create({ doc: mut_editor.schema.nodeFromJSON(json._yay), plugins: mut_editor.state.plugins }),
	);
	return json;
}

type FileEditorRichTextNonCollabInner_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	editable: boolean;
	/** The stored bytes the loader read; the mount-time baseline is re-serialized from them. */
	initialText: string;
	/** Parsed from `initialText` against the mounted extension list, so the two cannot drift. */
	initialJson: NonNullable<ReturnType<typeof files_tiptap_markdown_to_json>["_yay"]>;
	initialBaseAssetId: app_convex_Id<"files_r2_assets">;
	presenceStore: files_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	topStickyFloatingSlot?: React.ReactNode;
};

const FileEditorRichTextNonCollabInner = memo(function FileEditorRichTextNonCollabInner(
	props: FileEditorRichTextNonCollabInner_Props,
) {
	const {
		nodeId,
		editable,
		initialText,
		initialJson,
		initialBaseAssetId,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		topStickyFloatingSlot,
	} = props;

	const { membershipId } = AppTenantProvider.useContext();

	const [editor, setEditor] = useState<Editor | null>(null);

	const sizeRef = useRef({ isOverCap: false });

	const getIsOverCap = useFn(() => sizeRef.current.isOverCap);

	const sizeLimit = file_editor_rich_text_SizeLimitExtension.configure({ getIsOverCap });

	const media = file_editor_rich_text_MediaExtension.configure({ membershipId });

	// Save state. The baseline is the mounted serializer's output, not the stored bytes: opening
	// and closing a file then never marks it dirty, and only the first save may reformat once
	// (`showReformatHint` warns about that).
	const baselineMarkdownRef = useRef<string>(initialText);
	const [nonCollaborativeBaseAssetId, setNonCollaborativeBaseAssetId] = useState(initialBaseAssetId);
	const [dirtyCheckState, setDirtyCheckState] = useState<"clean" | "checking" | "dirty">("clean");
	const dirtyCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [isSaving, setIsSaving] = useState(false);
	const [byteSize, setByteSize] = useState(() => files_get_utf8_byte_size(initialText));
	const [showReformatHint, setShowReformatHint] = useState(false);

	const isSaveDebouncing = dirtyCheckState === "checking";
	const isSaveDisabled = !editable || isSaving || dirtyCheckState !== "dirty";
	// "checking" blocks too: typing happened moments ago, so unsaved edits may exist.
	const commentDisabledReason = dirtyCheckState === "clean" ? null : "Save your changes before adding a comment.";

	const imageUploadInputRef = useRef<HTMLInputElement>(null);
	const videoUploadInputRef = useRef<HTMLInputElement>(null);
	const [embedPickerAnchorRect, setEmbedPickerAnchorRect] = useState<{
		x: number;
		y: number;
		width: number;
		height: number;
	} | null>(null);

	// Click the input synchronously: the browser only opens a file dialog while the user
	// gesture that ran the slash command is still active.
	const pickMediaUploadFile = useFn((kind: "image" | "video") => {
		(kind === "image" ? imageUploadInputRef : videoUploadInputRef).current?.click();
	});

	const openEmbedExistingPicker = useFn(() => {
		if (!editor) {
			return;
		}

		// Anchor the picker to the caret; the slash item already deleted the "/..." text.
		const caretRect = editor.view.coordsAtPos(editor.state.selection.from);
		setEmbedPickerAnchorRect({
			x: caretRect.left,
			y: caretRect.top,
			width: 1,
			height: caretRect.bottom - caretRect.top,
		});
	});

	const handleEmbedPickerClose = useFn(() => {
		setEmbedPickerAnchorRect(null);
	});

	const handleMediaUploadInputChange = useFn((event: React.ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.currentTarget.files ?? []);
		// Reset so picking the same file twice in a row still fires a change event.
		event.currentTarget.value = "";
		if (files.length === 0 || !editor || !editable) {
			return;
		}

		file_editor_rich_text_upload_media_files({
			view: editor.view,
			files,
			source: "file",
			membershipId,
			documentNodeId: nodeId,
		});
	});

	const mediaInsert = file_editor_rich_text_MediaInsertExtension.configure({
		pickUploadFile: pickMediaUploadFile,
		openEmbedExistingPicker,
	});

	const extensions = [
		...nonCollaborativeExtensions,
		FileEditorRichTextToolsSlashCommand.slashCommand,
		sizeLimit,
		media,
		mediaInsert,
	];

	// Serialize once, refresh the size states, and compare against the baseline. Used by the
	// typing debounce and after every save-shaped operation, so there is exactly one dirty
	// computation (the comment gate reads the same state).
	const recomputeDirtyState = (currentEditor: Editor) => {
		const currentText = serialize_editor_markdown(currentEditor);
		const nextByteSize = files_get_utf8_byte_size(currentText);
		setByteSize(nextByteSize);
		sizeRef.current.isOverCap = nextByteSize > files_MAX_TEXT_CONTENT_BYTES;

		if (dirtyCheckTimeoutRef.current) {
			clearTimeout(dirtyCheckTimeoutRef.current);
			dirtyCheckTimeoutRef.current = undefined;
		}
		setDirtyCheckState(currentText !== baselineMarkdownRef.current ? "dirty" : "clean");
	};

	const handleCreate: EditorContentProps["onCreate"] = ({ editor: createdEditor }) => {
		// Serialize the freshly mounted document through the argument: the React `editor` state is
		// still null here because `setEditor` has not finished.
		const baseline = serialize_editor_markdown(createdEditor);
		baselineMarkdownRef.current = baseline;
		setByteSize(files_get_utf8_byte_size(baseline));
		sizeRef.current.isOverCap = files_get_utf8_byte_size(baseline) > files_MAX_TEXT_CONTENT_BYTES;
		setShowReformatHint(baseline !== initialText);
		setEditor(createdEditor);
	};

	const getCurrentText = useFn(() => (editor ? serialize_editor_markdown(editor) : initialText));

	const handleClickSave = useFn(() => {
		if (!editable || !editor || isSaving || dirtyCheckState !== "dirty") return;

		setIsSaving(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const textToSave = serialize_editor_markdown(editor);

			// Nothing is persisted until this point, so the cap is enforced here. The content
			// stays in the editor, so the member can trim it and save again.
			const savedByteSize = files_get_utf8_byte_size(textToSave);
			if (savedByteSize > files_MAX_TEXT_CONTENT_BYTES) {
				toast.error(file_editor_get_size_error_message(savedByteSize));
				return;
			}

			// Send the whole text and name the asset it was built on, so a save that landed
			// meanwhile is refused instead of silently overwritten.
			const replaced = await app_convex.action(app_convex_api.files_nodes_content.replace_file_content, {
				membershipId,
				nodeId,
				text: textToSave,
				baseAssetId: nonCollaborativeBaseAssetId,
			});
			if (replaced._nay) {
				console.error("[FileEditorRichTextNonCollab.handleClickSave] Error while replacing the file content", {
					nay: replaced._nay,
				});
				toast.error(replaced._nay.message);
				return;
			}

			// The save wrote a new version, and the next save has to be based on it.
			setNonCollaborativeBaseAssetId(replaced._yay.assetId);
			baselineMarkdownRef.current = textToSave;
			setShowReformatHint(false);
			// The member may have typed while the call was waiting. Recompute dirty against the
			// captured saved text instead of resetting to clean, so later typing never reads as saved.
			recomputeDirtyState(editor);
		})()
			.catch((err) => {
				console.error("[FileEditorRichTextNonCollab.handleClickSave] Save failed", err);
				toast.error(err instanceof Error ? err.message : "Failed to save");
			})
			.finally(() => {
				setIsSaving(false);
			});
	});

	// No `editable` guard here on purpose: this runs only after the backend already committed the
	// restore, so skipping the refresh when permission was removed mid-restore would leave the
	// editor showing stale content. The pre-action gate lives in the snapshots modal.
	const handleApplySnapshotText = useFn(() => {
		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			if (!editor) {
				return;
			}

			// The restore replaced the whole text, so re-read it together with the asset it now
			// lives in. That asset is the base of the next save.
			const restored = await app_convex.query(app_convex_api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId,
				nodeId,
			});
			if (restored._nay) {
				console.error(
					"[FileEditorRichTextNonCollab.handleApplySnapshotText] Error while reading the restored content",
					{
						nay: restored._nay,
					},
				);
				toast.error("Failed to refresh the editor after the restore. Reload the file.");
				return;
			}

			const replacedDoc = replace_editor_document(editor, restored._yay.text);
			if (replacedDoc._nay) {
				console.error(
					"[FileEditorRichTextNonCollab.handleApplySnapshotText] Error while parsing the restored content",
					{
						nay: replacedDoc._nay,
					},
				);
				toast.error("Failed to refresh the editor after the restore. Reload the file.");
				return;
			}

			// Same rules as mount: the baseline is the serializer's output for the restored
			// document, and the hint returns when that output differs from the stored bytes.
			const baseline = serialize_editor_markdown(editor);
			baselineMarkdownRef.current = baseline;
			setShowReformatHint(baseline !== restored._yay.text);
			setNonCollaborativeBaseAssetId(restored._yay.assetId);
			recomputeDirtyState(editor);
		})()
			.catch((err) => {
				console.error("[FileEditorRichTextNonCollab.handleApplySnapshotText] Failed to apply snapshot restore", err);
				toast.error(err instanceof Error ? err.message : "Failed to restore snapshot");
			})
			.finally(() => {});
	});

	/**
	 * The targeted comment save. The gate guarantees the editor was clean when the composer
	 * submitted, so the current document is the saved base plus only the new mark.
	 */
	const handleCommitComment = useFn(async (threadId: string): Promise<boolean> => {
		if (!editor) {
			return false;
		}

		// Block Save while the commit is in flight: both send `replace_file_content` with the same
		// base asset id, so a mid-commit Save would race it into a duplicate version and a second
		// billed save. Use an async IIFE because the React compiler has problems with try catch
		// finally blocks.
		setIsSaving(true);
		const commit = async (/* iife */) => {
			const textWithComment = serialize_editor_markdown(editor);

			const commentByteSize = files_get_utf8_byte_size(textWithComment);
			if (commentByteSize > files_MAX_TEXT_CONTENT_BYTES) {
				toast.error(file_editor_get_size_error_message(commentByteSize));
				return false;
			}

			const replaced = await app_convex.action(app_convex_api.files_nodes_content.replace_file_content, {
				membershipId,
				nodeId,
				text: textWithComment,
				baseAssetId: nonCollaborativeBaseAssetId,
			});

			if (replaced._yay) {
				setNonCollaborativeBaseAssetId(replaced._yay.assetId);
				baselineMarkdownRef.current = textWithComment;
				setShowReformatHint(false);
				recomputeDirtyState(editor);
				return true;
			}

			if (replaced._nay.message !== REPLACE_FILE_STALENESS_MESSAGE) {
				console.error("[FileEditorRichTextNonCollab.handleCommitComment] Error while saving the comment", {
					nay: replaced._nay,
				});
				toast.error(replaced._nay.message);
				return false;
			}

			// Somebody else saved between our load and this comment. Yjs is used below only as a merge
			// tool: nothing is synced and nothing is stored as Yjs. The comment mark is one small edit
			// on top of the base text we loaded, somebody else saved a different edit on top of the
			// same base, and Yjs can replay our edit onto their text.

			// The member may have typed while the save above was waiting. Merging would publish that
			// typing, so refuse; the caller takes the mark back out and the typing stays local.
			if (serialize_editor_markdown(editor) !== textWithComment) {
				toast.error("Save your changes before adding a comment.");
				return false;
			}

			const savedBaseText = baselineMarkdownRef.current;

			const fresh = await app_convex.query(app_convex_api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId,
				nodeId,
			});
			if (fresh._nay) {
				console.error("[FileEditorRichTextNonCollab.handleCommitComment] Error while re-reading the file content", {
					nay: fresh._nay,
				});
				toast.error("This file changed while you were saving. Reload the page, then add your comment again.");
				return false;
			}

			// The member may also have typed while the re-read above was waiting. Nothing is published
			// yet, so refuse the same way: the caller takes the mark back out and the typing stays.
			if (serialize_editor_markdown(editor) !== textWithComment) {
				toast.error("Save your changes before adding a comment.");
				return false;
			}

			// Both docs MUST come from the same base doc. Two docs built separately from text share no
			// history, and `files_yjs_reconcile_branch_with_local_text` would then quietly keep our
			// text and drop theirs.
			const baseYjsDoc = new YDoc();
			const baseFromText = files_yjs_doc_update_from_text({
				mut_yjsDoc: baseYjsDoc,
				text: savedBaseText,
				rootKind: "rich_text",
			});
			if (baseFromText._nay) {
				console.error("[FileEditorRichTextNonCollab.handleCommitComment] Error while building the base document", {
					nay: baseFromText._nay,
				});
				toast.error("This file changed while you were saving. Reload the page, then add your comment again.");
				return false;
			}

			// The merge runs on the shared extension list, which does not know every node the browser
			// editor can write (youtube, twitter, math). If projecting the saved base through it does
			// not give the saved base back, the merge would drop something. Refuse instead of quietly
			// rewriting the file.
			const baseRoundTrip = files_yjs_doc_get_text({ yjsDoc: baseYjsDoc, rootKind: "rich_text" });
			if (baseRoundTrip._nay || baseRoundTrip._yay !== savedBaseText) {
				toast.error("This file changed while you were saving. Reload the page, then add your comment again.");
				return false;
			}

			const freshYjsDoc = files_yjs_doc_clone({ yjsDoc: baseYjsDoc });
			const freshFromText = files_yjs_doc_update_from_text({
				mut_yjsDoc: freshYjsDoc,
				text: fresh._yay.text,
				rootKind: "rich_text",
			});
			if (freshFromText._nay) {
				console.error("[FileEditorRichTextNonCollab.handleCommitComment] Error while building the fresh document", {
					nay: freshFromText._nay,
				});
				toast.error("This file changed while you were saving. Reload the page, then add your comment again.");
				return false;
			}

			const merged = files_yjs_reconcile_branch_with_local_text({
				previousRemoteYjsDoc: baseYjsDoc,
				nextRemoteYjsDoc: freshYjsDoc,
				localText: textWithComment,
				rootKind: "rich_text",
			});
			if (merged._nay) {
				console.error("[FileEditorRichTextNonCollab.handleCommitComment] Error while merging the comment", {
					nay: merged._nay,
				});
				toast.error("This file changed while you were saving. Reload the page, then add your comment again.");
				return false;
			}

			// Retry once against the fresh asset. A second staleness refusal gets the normal message.
			const replacedMerged = await app_convex.action(app_convex_api.files_nodes_content.replace_file_content, {
				membershipId,
				nodeId,
				text: merged._yay.mergedText,
				baseAssetId: fresh._yay.assetId,
			});
			if (replacedMerged._nay) {
				console.error("[FileEditorRichTextNonCollab.handleCommitComment] Error while saving the merged comment", {
					nay: replacedMerged._nay,
				});
				toast.error(replacedMerged._nay.message);
				return false;
			}

			// The member may have typed while the merged save was waiting. Replacing the document now
			// would delete that typing, so keep the editor and the OLD base asset id as they are: the
			// editor stays dirty, and the next Save gets the normal staleness refusal instead of
			// silently overwriting the merged version.
			if (serialize_editor_markdown(editor) !== textWithComment) {
				toast.info(
					"Someone else saved this file and your comment was merged into their version. Your typing since then is not saved yet.",
				);
				return true;
			}

			// The file now also holds the other person's text; the editor must show it.
			setNonCollaborativeBaseAssetId(replacedMerged._yay.assetId);
			baselineMarkdownRef.current = merged._yay.mergedText;
			setShowReformatHint(false);

			const replacedDoc = replace_editor_document(editor, merged._yay.mergedText);
			if (replacedDoc._nay) {
				// The save DID happen, so the commit reports success; only the local view is stale.
				console.error("[FileEditorRichTextNonCollab.handleCommitComment] Error while showing the merged content", {
					nay: replacedDoc._nay,
				});
				toast.error("The comment was saved, but the editor could not show the merged file. Reload the file.");
				return true;
			}

			recomputeDirtyState(editor);
			toast.info("Someone else saved this file. Your comment was merged into their version.");
			return true;
		};

		return await commit().finally(() => {
			setIsSaving(false);
		});
	});

	// Same pattern as the comments composer: the editor instance is created once, so a later answer
	// to "may this user write here" has to go through `setEditable`.
	useEffect(() => {
		if (editor) {
			editor.setEditable(editable, false);
		}
	}, [editor, editable]);

	// The dirty check serializes the whole document, so it runs on a typing pause, not on every
	// keystroke. Same cost profile the collaborative toolbar accepts for its size badge.
	useEffect(() => {
		if (!editor) {
			return;
		}

		const handleUpdate = () => {
			setDirtyCheckState("checking");
			if (dirtyCheckTimeoutRef.current) {
				clearTimeout(dirtyCheckTimeoutRef.current);
			}
			dirtyCheckTimeoutRef.current = setTimeout(() => {
				dirtyCheckTimeoutRef.current = undefined;
				recomputeDirtyState(editor);
			}, 400);
		};

		editor.on("update", handleUpdate);
		return () => {
			editor.off("update", handleUpdate);
			clearTimeout(dirtyCheckTimeoutRef.current);
			dirtyCheckTimeoutRef.current = undefined;
		};
	}, [editor]);

	/**
	 * Reject content that would push the document over the size cap. Every save persists the whole
	 * document, so pasted and dropped content has to be checked before it lands. The size is
	 * measured exactly here rather than read from the debounced state: a paste is a one-off user
	 * action, so one serialization is affordable and never stale.
	 */
	const checkIncomingContentFitsSizeCap = useFn((incomingText: string) => {
		if (!editor || !incomingText) {
			return true;
		}

		const nextByteSize = files_get_utf8_byte_size(editor.getMarkdown()) + files_get_utf8_byte_size(incomingText);
		if (nextByteSize <= files_MAX_TEXT_CONTENT_BYTES) {
			return true;
		}

		toast.error(file_editor_get_size_error_message(nextByteSize));
		return false;
	});

	// The non-collaborative editor has no sync status; "the Tiptap instance exists" is its
	// readiness, and the same visible-class mechanism keeps the layout identical.
	const isEditorReady = editor !== null;

	return (
		<>
			<div
				className={cn(
					"FileEditorRichText" satisfies FileEditorRichText_ClassNames,
					isEditorReady && ("FileEditorRichText-visible" satisfies FileEditorRichText_ClassNames),
				)}
			>
				<input
					ref={imageUploadInputRef}
					type="file"
					accept="image/*"
					multiple
					aria-hidden="true"
					tabIndex={-1}
					style={{ display: "none" }}
					onChange={handleMediaUploadInputChange}
				/>
				<input
					ref={videoUploadInputRef}
					type="file"
					accept="video/*"
					multiple
					aria-hidden="true"
					tabIndex={-1}
					style={{ display: "none" }}
					onChange={handleMediaUploadInputChange}
				/>
				{editor && embedPickerAnchorRect && (
					<FileEditorRichTextMediaEmbedPicker
						editor={editor}
						membershipId={membershipId}
						anchorRect={embedPickerAnchorRect}
						onClose={handleEmbedPickerClose}
					/>
				)}
				{editor && (
					<FileEditorRichTextNonCollabToolbarActions
						editor={editor}
						nodeId={nodeId}
						editable={editable}
						sessionId={presenceStore.localSessionId}
						byteSize={byteSize}
						isSaveDisabled={isSaveDisabled}
						isSaveDebouncing={isSaveDebouncing}
						showReformatHint={showReformatHint}
						nonCollaborativeBaseAssetId={nonCollaborativeBaseAssetId}
						toolbarPortalHost={toolbarPortalHost}
						getCurrentText={getCurrentText}
						onApplySnapshotText={handleApplySnapshotText}
						onClickSave={handleClickSave}
					/>
				)}
				<FileEditorRichTextTopStickyFloatingContainer topStickyFloatingSlot={topStickyFloatingSlot} />
				<EditorContent
					className={cn("FileEditorRichText-editor-content-root" satisfies FileEditorRichText_ClassNames)}
					injectCSS={false}
					initialContent={initialJson}
					editorContainerProps={{
						className: cn("FileEditorRichText-editor-content-container" satisfies FileEditorRichText_ClassNames),
					}}
					editorProps={{
						attributes: {
							class: cn(
								"app-doc" satisfies AppClassName,
								"FileEditorRichText-editor-content" satisfies FileEditorRichText_ClassNames,
							),
						},
						handleDOMEvents: {
							keydown: (_view, event) => handleCommandNavigation(event),
						},
						// ProseMirror treats true as handled. A settled read-only view skips these handlers on
						// its own, but the view's read-only gate lands one `setEditable` effect later than the
						// React render, so block a paste or drop that arrives in that window here and in
						// `handleDrop` below.
						handlePaste: (view, event) => {
							if (!editable) {
								return true;
							}
							if (checkIncomingContentFitsSizeCap(event.clipboardData?.getData("text/plain") ?? "") === false) {
								return true;
							}
							return file_editor_rich_text_handle_media_paste({ view, event, membershipId, documentNodeId: nodeId });
						},
						handleDrop: (view, event, _slice, moved) => {
							if (!editable) {
								return true;
							}
							// `moved` is an internal drag, so the content is only relocated, not added.
							if (
								!moved &&
								checkIncomingContentFitsSizeCap(event.dataTransfer?.getData("text/plain") ?? "") === false
							) {
								return true;
							}
							return file_editor_rich_text_handle_media_drop({
								view,
								event,
								moved,
								membershipId,
								documentNodeId: nodeId,
							});
						},
					}}
					extensions={extensions}
					editable={editable}
					immediatelyRender={false}
					onCreate={handleCreate}
					slotAfter={
						editor && editable ? (
							<>
								<ImageResizer />
								<FileEditorRichTextToolsSlashCommand />
								<FileEditorRichTextDragHandle editor={editor} />
								<FileEditorRichTextBubble
									editor={editor}
									nodeId={nodeId}
									disabledReason={commentDisabledReason}
									commitComment={handleCommitComment}
									showAiAction={false}
								/>
							</>
						) : null
					}
				></EditorContent>
			</div>
			{editor && (
				<FileEditorRichTextAnchoredCommentsLayer
					commentsPortalHost={commentsPortalHost}
					editor={editor}
					editable={editable}
					isEditorReady={isEditorReady}
				/>
			)}
			{!isEditorReady && <FileEditorRichTextSkeleton />}
		</>
	);
});
// #endregion non-collaborative inner

// #region non-collaborative root
export type FileEditorRichTextNonCollab_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	editable: boolean;
	presenceStore: files_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	topStickyFloatingSlot?: React.ReactNode;
};

/**
 * The rich editor for a file with collaboration turned off. A separate top-level component, not
 * a flag on `FileEditorRichText`: that component calls `useFilesYjs` unconditionally, and hook
 * rules forbid skipping the call, so a merged component would open a Yjs provider against a file
 * that has no Yjs document.
 */
export const FileEditorRichTextNonCollab = memo(function FileEditorRichTextNonCollab(
	props: FileEditorRichTextNonCollab_Props,
) {
	const { nodeId, editable, presenceStore, commentsPortalHost, toolbarPortalHost, topStickyFloatingSlot } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const fileContentDataPromise = useMemo(() => {
		// Collaboration off: the server sends the committed text and the asset the next save has
		// to name.
		return app_convex
			.query(app_convex_api.files_nodes_content.get_non_collaborative_file_content, { membershipId, nodeId })
			.then((result) => {
				if (result._nay) {
					console.error("[FileEditorRichTextNonCollab] Error while reading the file content", result._nay);
					return null;
				}

				// Parse against the list the editor mounts, so a document this editor cannot
				// represent is refused below before any editor exists.
				const json = files_tiptap_markdown_to_json({
					markdown: result._yay.text,
					extensions: nonCollaborativeExtensions,
				});
				if (json._nay) {
					console.error("[FileEditorRichTextNonCollab] Error while parsing the file content", json._nay);
					return null;
				}

				return { text: result._yay.text, baseAssetId: result._yay.assetId, initialJson: json._yay };
			});
	}, [membershipId, nodeId]);
	const fileContentData = usePromiseValue(fileContentDataPromise);

	// On a refused or missing read, never mount the editor over a stand-in document: a save from
	// it would overwrite the real content.
	return fileContentData === undefined ? (
		<FileEditorRichTextSkeleton />
	) : fileContentData === null ? (
		<div role="alert" className={"FileEditorRichText-refusal" satisfies FileEditorRichText_ClassNames}>
			This file's content could not be read safely, so the editor stays closed to protect it. Reload the file or contact
			support if this keeps happening.
		</div>
	) : (
		// Remount on the loaded lineage so a different stored version never reuses editor state.
		<EditorRoot key={`non_collaborative:${fileContentData.baseAssetId}`}>
			<FileEditorRichTextNonCollabInner
				nodeId={nodeId}
				editable={editable}
				initialText={fileContentData.text}
				initialJson={fileContentData.initialJson}
				initialBaseAssetId={fileContentData.baseAssetId}
				presenceStore={presenceStore}
				commentsPortalHost={commentsPortalHost}
				toolbarPortalHost={toolbarPortalHost}
				topStickyFloatingSlot={topStickyFloatingSlot}
			/>
		</EditorRoot>
	);
});
// #endregion non-collaborative root
