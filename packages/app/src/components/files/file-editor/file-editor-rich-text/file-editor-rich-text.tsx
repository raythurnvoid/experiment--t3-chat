import "./file-editor-rich-text.css";
import { memo, useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
	EditorContent,
	EditorRoot,
	type EditorContentProps,
	ImageResizer,
	handleCommandNavigation,
	handleImageDrop,
	handleImagePaste,
	EditorBubble,
} from "novel";
import { Editor, useEditorState } from "@tiptap/react";
import { toast } from "sonner";
import { useFileEditorRichTextExtension } from "@/lib/file-editor-rich-text-extension.ts";
import type { YjsSyncStatus } from "@liveblocks/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { defaultExtensions } from "./extensions.ts";
import { FileEditorRichTextToolsColorSelector } from "./file-editor-rich-text-tools-color-selector.tsx";
import { FileEditorRichTextToolsLinkSetter } from "./file-editor-rich-text-tools-link-setter.tsx";
import { FileEditorRichTextToolsNodeSelector } from "./file-editor-rich-text-tools-node-selector.tsx";
import { FileEditorRichTextToolsMathToggle } from "./file-editor-rich-text-tools-math-toggle.tsx";
import { FileEditorRichTextToolsTextStyles } from "./file-editor-rich-text-tools-text-styles.tsx";
import { FileEditorRichTextToolsSlashCommand } from "./file-editor-rich-text-tools-slash-command.tsx";
import { FileEditorRichTextToolsHistoryButtons } from "./file-editor-rich-text-tools-history-buttons.tsx";
import { MySeparator } from "@/components/my-separator.tsx";
import { uploadFn } from "./image-upload.ts";
import { FileEditorRichTextAnchoredComments } from "./file-editor-rich-text-comments.tsx";
import { FileEditorSnapshotsModal } from "../file-editor-snapshots-modal.tsx";
import { AI_NAME } from "./constants.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { check_element_is_in_allowed_areas, cn } from "@/lib/utils.ts";
import type { AppClassName, AppElementId } from "@/lib/dom-utils.ts";
import { app_fetch_ai_docs_contextual_prompt } from "@/lib/fetch.ts";
import { MyBadge } from "@/components/my-badge.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_PresenceStore,
	files_YJS_DOC_KEYS,
	files_get_utf8_byte_size,
} from "@/lib/files.ts";
import {
	file_editor_SIZE_MEASURE_CHARS,
	file_editor_get_size_badge_text,
	file_editor_get_size_error_message,
	file_editor_get_size_status_message,
} from "@/lib/file-editor.ts";
import { file_editor_rich_text_SizeLimitExtension } from "@/lib/file-editor-rich-text-size-limit-extension.ts";
import { MyButton, MyButtonIcon, type MyButton_Props } from "@/components/my-button.tsx";
import { MyFloatingSurface } from "@/components/my-floating-surface.tsx";
import { FileEditorRichTextToolsInlineAi } from "./file-editor-rich-text-tools-inline-ai.tsx";
import { FileEditorRichTextToolsComment } from "./file-editor-rich-text-tools-comment.tsx";
import { Sparkles } from "lucide-react";
import { FileEditorRichTextDragHandle } from "./file-editor-rich-text-drag-handle.tsx";
import type { EditorBubbleProps } from "../../../../../vendor/novel/packages/headless/src/components/editor-bubble.tsx";
import { bubbleMenuReevaluateVisibility } from "../../../../../vendor/tiptap/packages/extension-bubble-menu/src/index.ts";
import { useDebounce, useFn, useRenderPromise, useStateRef } from "../../../../hooks/utils-hooks.ts";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { useFilesYjs } from "@/hooks/files-hooks.ts";
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
		</>
	);
});

type FileEditorRichTextToolbarStatus_Props = {
	editor: Editor;
	editable: boolean;
	getCurrentMarkdown: () => string;
	nodeId: app_convex_Id<"files_nodes">;
	sessionId: string;
	sizeRef: FileEditorRichTextSizeRef;
	syncChanged: boolean;
	syncStatus: SyncStatus;
};

const FileEditorRichTextToolbarStatus = memo(function FileEditorRichTextToolbarStatus(
	props: FileEditorRichTextToolbarStatus_Props,
) {
	const { editor, editable, getCurrentMarkdown, nodeId, sessionId, sizeRef, syncChanged, syncStatus } = props;

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

		const nextByteSize = files_get_utf8_byte_size(getCurrentMarkdown());
		setByteSize(nextByteSize);
		sizeRef.current.isOverCap = nextByteSize > files_MAX_TEXT_CONTENT_BYTES;
		// `getCurrentMarkdown` is a `useFn` wrapper: stable identity, always calling the latest
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
				getCurrentMarkdown={getCurrentMarkdown}
			/>
		</>
	);
});

const FileEditorRichTextToolbarActions = memo(function FileEditorRichTextToolbarActions(
	props: FileEditorRichTextToolbarActions_Props,
) {
	const { editor, nodeId, editable, sessionId, sizeRef, syncChanged, syncStatus, toolbarPortalHost } = props;

	const getCurrentMarkdown = useFn(() => {
		const markdown = editor.getMarkdown();
		// Match files_yjs_doc_get_markdown: non-empty file content ends with one `\n`,
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
				getCurrentMarkdown={getCurrentMarkdown}
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
	onClickAi: MyButton_Props["onClick"];
};

const FileEditorRichTextBubbleContentActions = memo(function FileEditorRichTextBubbleContentActions(
	props: FileEditorRichTextBubbleContentActions_Props,
) {
	const { editor, nodeId, onClickAi } = props;

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
			<FileEditorRichTextToolsNodeSelector editor={editor} buttonVariant="floating" />
			<FileEditorRichTextToolsLinkSetter editor={editor} buttonVariant="floating" />
			<FileEditorRichTextToolsMathToggle editor={editor} buttonVariant="floating" />
			<FileEditorRichTextToolsTextStyles editor={editor} buttonVariant="floating" />
			<FileEditorRichTextToolsColorSelector editor={editor} buttonVariant="floating" />
			<FileEditorRichTextToolsComment editor={editor} fileNodeId={nodeId} buttonVariant="floating" />
		</div>
	);
});
// #endregion bubble content actions

// #region bubble content
export type FileEditorRichTextBubbleContent_ClassNames = "FileEditorRichTextBubbleContent";

type FileEditorRichTextBubbleContent_Props = {
	editor: Editor;
	nodeId: app_convex_Id<"files_nodes">;
	openAi: boolean;
	portalElement: HTMLElement | null;
	onPortalRef: (inst: HTMLDivElement | null) => void;
	onClickAi: MyButton_Props["onClick"];
	onDiscardAi: () => void;
};

const FileEditorRichTextBubbleContent = memo(function FileEditorRichTextBubbleContent(
	props: FileEditorRichTextBubbleContent_Props,
) {
	const { editor, nodeId, openAi, portalElement, onPortalRef, onClickAi, onDiscardAi } = props;

	return (
		<MyFloatingSurface
			ref={onPortalRef}
			className={cn("FileEditorRichTextBubbleContent" satisfies FileEditorRichTextBubbleContent_ClassNames)}
		>
			{openAi && <FileEditorRichTextToolsInlineAi editor={editor} onDiscard={onDiscardAi} />}
			{!openAi && portalElement ? (
				<FileEditorRichTextBubbleContentActions editor={editor} nodeId={nodeId} onClickAi={onClickAi} />
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
	const { editor, nodeId } = props;

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
				openAi={openAi}
				portalElement={portalElement}
				onPortalRef={handlePortalElementRef}
				onClickAi={handleClickAi}
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
	isEditorReady: boolean;
};

const FileEditorRichTextAnchoredCommentsLayer = memo(function FileEditorRichTextAnchoredCommentsLayer(
	props: FileEditorRichTextAnchoredCommentsLayer_Props,
) {
	const { commentsPortalHost, editor, isEditorReady } = props;

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
		<FileEditorRichTextAnchoredComments editor={editor} threads={threadsQuery?.threads} />,
		commentsPortalHost,
	);
});
// #endregion anchored comments layer

// #region root
export type FileEditorRichText_ClassNames =
	| "FileEditorRichText"
	| "FileEditorRichText-visible"
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

	const extensions = [...defaultExtensions, FileEditorRichTextToolsSlashCommand.slashCommand, liveblocks, sizeLimit];

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

	return (
		<>
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
							return handleImagePaste(view, event, uploadFn);
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
							return handleImageDrop(view, event, moved, uploadFn);
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
								<FileEditorRichTextBubble editor={editor} nodeId={nodeId} />
							</>
						) : null
					}
				></EditorContent>
			</div>
			{editor && (
				<FileEditorRichTextAnchoredCommentsLayer
					commentsPortalHost={commentsPortalHost}
					editor={editor}
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
	editable: boolean;
	presenceStore: files_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	topStickyFloatingSlot?: React.ReactNode;
};

export function FileEditorRichText(props: FileEditorRichText_Props) {
	const { nodeId, editable, presenceStore, commentsPortalHost, toolbarPortalHost, topStickyFloatingSlot, ...rest } =
		props;

	const { membershipId } = AppTenantProvider.useContext();

	const filesYjs = useFilesYjs({
		nodeId: nodeId,
		membershipId,
		presenceStore,
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
