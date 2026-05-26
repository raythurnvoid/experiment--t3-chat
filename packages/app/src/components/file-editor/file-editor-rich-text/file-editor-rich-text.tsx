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
import { useLiveblocksExtension } from "@liveblocks/react-tiptap";
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
import { files_PresenceStore, files_YJS_DOC_KEYS } from "@/lib/files.ts";
import { MyButton, MyButtonIcon, type MyButton_Props } from "@/components/my-button.tsx";
import { FileEditorRichTextToolsInlineAi } from "./file-editor-rich-text-tools-inline-ai.tsx";
import { FileEditorRichTextToolsComment } from "./file-editor-rich-text-tools-comment.tsx";
import { Sparkles, MessageSquarePlus } from "lucide-react";
import { FileEditorRichTextDragHandle } from "./file-editor-rich-text-drag-handle.tsx";
import type { EditorBubbleProps } from "../../../../vendor/novel/packages/headless/src/components/editor-bubble.tsx";
import { bubbleMenuReevaluateVisibility } from "../../../../vendor/tiptap/packages/extension-bubble-menu/src/index.ts";
import { useFn, useRenderPromise } from "../../../hooks/utils-hooks.ts";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { useFilesYjs, type files_Yjs } from "@/hooks/files-hooks.ts";
import { getThreadIdsFromEditorState } from "@liveblocks/react-tiptap";
import { global_event_listen_all } from "../../../lib/global-event.tsx";
import { FileEditorRichTextSkeleton } from "./file-editor-rich-text-skeleton.tsx";

type SyncStatus = YjsSyncStatus;

// #region toolbar
type FileEditorRichTextToolbarActions_ClassNames =
	| "FileEditorRichTextToolbarActions"
	| "FileEditorRichTextToolbarActions-status-badge"
	| "FileEditorRichTextToolbarActions-word-count-badge"
	| "FileEditorRichTextToolbarActions-word-count-badge-hidden";

type FileEditorRichTextToolbarActions_Props = {
	editor: Editor;
	nodeId: app_convex_Id<"files_nodes">;
	sessionId: string;
	syncChanged: boolean;
	syncStatus: SyncStatus;
	toolbarPortalHost: HTMLElement;
};

type FileEditorRichTextToolbarTools_Props = {
	editor: Editor;
};

const FileEditorRichTextToolbarTools = memo(function FileEditorRichTextToolbarTools(
	props: FileEditorRichTextToolbarTools_Props,
) {
	const { editor } = props;

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
	getCurrentMarkdown: () => string;
	nodeId: app_convex_Id<"files_nodes">;
	sessionId: string;
	syncChanged: boolean;
	syncStatus: SyncStatus;
};

const FileEditorRichTextToolbarStatus = memo(function FileEditorRichTextToolbarStatus(
	props: FileEditorRichTextToolbarStatus_Props,
) {
	const { editor, getCurrentMarkdown, nodeId, sessionId, syncChanged, syncStatus } = props;

	const wordsCount = useEditorState({
		editor,
		selector: ({ editor: currentEditor }) => currentEditor.storage.characterCount.words(),
	});

	return (
		<>
			<MyBadge
				variant="secondary"
				className={cn("FileEditorRichTextToolbarActions-status-badge" satisfies FileEditorRichTextToolbarActions_ClassNames)}
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
			<FileEditorSnapshotsModal nodeId={nodeId} sessionId={sessionId} getCurrentMarkdown={getCurrentMarkdown} />
		</>
	);
});

const FileEditorRichTextToolbarActions = memo(function FileEditorRichTextToolbarActions(
	props: FileEditorRichTextToolbarActions_Props,
) {
	const { editor, nodeId, sessionId, syncChanged, syncStatus, toolbarPortalHost } = props;

	const getCurrentMarkdown = useFn(() => editor.getMarkdown());

	return createPortal(
		<div
			role="group"
			aria-label="Rich text editor actions"
			className={cn("FileEditorRichTextToolbarActions" satisfies FileEditorRichTextToolbarActions_ClassNames)}
		>
			<FileEditorRichTextToolbarTools editor={editor} />
			<FileEditorRichTextToolbarStatus
				editor={editor}
				getCurrentMarkdown={getCurrentMarkdown}
				nodeId={nodeId}
				sessionId={sessionId}
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

// #region bubble content

export type FileEditorRichTextBubbleContent_ClassNames = "FileEditorRichTextBubbleContent";

export type FileEditorRichTextBubbleContentDefaultActions_ClassNames =
	| "FileEditorRichTextBubbleContentDefaultActions"
	| "FileEditorRichTextBubbleContentDefaultActions-button"
	| "FileEditorRichTextBubbleContentDefaultActions-icon";

type FileEditorRichTextBubbleContentDefaultActions_Props = {
	editor: Editor;
	onClickAi: MyButton_Props["onClick"];
	onClickComment: MyButton_Props["onClick"];
};

const FileEditorRichTextBubbleContentDefaultActions = memo(function FileEditorRichTextBubbleContentDefaultActions(
	props: FileEditorRichTextBubbleContentDefaultActions_Props,
) {
	const { editor, onClickAi, onClickComment } = props;

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
				"FileEditorRichTextBubbleContentDefaultActions" satisfies FileEditorRichTextBubbleContentDefaultActions_ClassNames,
			)}
		>
			<MyButton
				variant="ghost"
				className={cn(
					"FileEditorRichTextBubbleContentDefaultActions-button" satisfies FileEditorRichTextBubbleContentDefaultActions_ClassNames,
				)}
				onPointerDown={handleActionPointerDown}
				onMouseDown={handleActionMouseDown}
				onClick={onClickAi}
			>
				<MyButtonIcon
					className={cn(
						"FileEditorRichTextBubbleContentDefaultActions-icon" satisfies FileEditorRichTextBubbleContentDefaultActions_ClassNames,
					)}
				>
					<Sparkles />
				</MyButtonIcon>
				Ask AI
			</MyButton>
			<MySeparator orientation="vertical" />
			<FileEditorRichTextToolsNodeSelector editor={editor} />
			<MySeparator orientation="vertical" />
			<FileEditorRichTextToolsLinkSetter editor={editor} />
			<MySeparator orientation="vertical" />
			<FileEditorRichTextToolsMathToggle editor={editor} />
			<MySeparator orientation="vertical" />
			<FileEditorRichTextToolsTextStyles editor={editor} />
			<MySeparator orientation="vertical" />
			<FileEditorRichTextToolsColorSelector editor={editor} />
			<MySeparator orientation="vertical" />
			<MyButton
				variant="ghost"
				className={cn(
					"FileEditorRichTextBubbleContentDefaultActions-button" satisfies FileEditorRichTextBubbleContentDefaultActions_ClassNames,
				)}
				onPointerDown={handleActionPointerDown}
				onMouseDown={handleActionMouseDown}
				onClick={onClickComment}
			>
				<MyButtonIcon
					className={cn(
						"FileEditorRichTextBubbleContentDefaultActions-icon" satisfies FileEditorRichTextBubbleContentDefaultActions_ClassNames,
					)}
				>
					<MessageSquarePlus />
				</MyButtonIcon>
				Comment
			</MyButton>
		</div>
	);
});

type FileEditorRichTextBubbleContent_Props = {
	editor: Editor;
	openAi: boolean;
	openComment: boolean;
	portalElement: HTMLElement | null;
	onPortalRef: (inst: HTMLDivElement | null) => void;
	onClickAi: MyButton_Props["onClick"];
	onClickComment: MyButton_Props["onClick"];
	onDiscardAi: () => void;
	onCloseComment: () => void;
};

const FileEditorRichTextBubbleContent = memo(function FileEditorRichTextBubbleContent(
	props: FileEditorRichTextBubbleContent_Props,
) {
	const {
		editor,
		openAi,
		openComment,
		portalElement,
		onPortalRef,
		onClickAi,
		onClickComment,
		onDiscardAi,
		onCloseComment,
	} = props;

	return (
		<div
			ref={onPortalRef}
			className={cn("FileEditorRichTextBubbleContent" satisfies FileEditorRichTextBubbleContent_ClassNames)}
		>
			{openAi && <FileEditorRichTextToolsInlineAi editor={editor} onDiscard={onDiscardAi} />}
			{openComment && <FileEditorRichTextToolsComment onClose={onCloseComment} />}
			{!openAi && !openComment && portalElement ? (
				<FileEditorRichTextBubbleContentDefaultActions
					editor={editor}
					onClickAi={onClickAi}
					onClickComment={onClickComment}
				/>
			) : null}
		</div>
	);
});
// #endregion bubble content

// #region bubble

// Derived from Liveblocks:
// liveblocks\examples\nextjs-tiptap-novel\src\components\editor\generative\generative-menu-switch.tsx

export type FileEditorRichTextBubble_ClassNames = "FileEditorRichTextBubble" | "FileEditorRichTextBubble-rendered";

export type FileEditorRichTextBubble_Props = {
	editor: Editor;
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
	const { editor } = props;

	const bubbleSurfaceRef = useRef<HTMLDivElement>(null);
	const isShownRef = useRef(false);
	/**
	 * Keep this true until the current editor pointer gesture ends.
	 */
	const isPointerSelectingRef = useRef(false);

	const [portalElement, setPortalElement] = useState<HTMLElement | null>(null);
	const [rendered, setRendered] = useState(true);

	const [openComment, setOpenComment] = useState(false);
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
		setOpenComment(false);

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

	const handleClickComment = useFn<MyButton_Props["onClick"]>(() => {
		setOpenComment(true);

		// Recalculate the bubble menu position after the comment component is rendered
		renderPromise
			.wait()
			.then(() => {
				updateBubbleMenuPosition();
			})
			.catch((error) => {
				console.error("[FileEditorRichText.handleClickComment] Error updating bubble menu position", { error });
			});
	});

	const handleDiscardAi = useFn(() => {
		setOpenAi(false);
	});

	const handleCloseComment = useFn(() => {
		setOpenComment(false);
		setRendered(false);
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
				if (
					isShownRef.current &&
					rendered &&
					!editor.state.selection.empty &&
					editor.state.selection.from !== editor.state.selection.to
				) {
					// TODO: This breaks the selection when double clicking and then dragging
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
				openAi={openAi}
				openComment={openComment}
				portalElement={portalElement}
				onPortalRef={handlePortalElementRef}
				onClickAi={handleClickAi}
				onClickComment={handleClickComment}
				onDiscardAi={handleDiscardAi}
				onCloseComment={handleCloseComment}
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
		selector: ({ editor: currentEditor }) => getThreadIdsFromEditorState(currentEditor.state).toSorted().join("\n"),
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
	filesYjs: files_Yjs;
	nodeId: app_convex_Id<"files_nodes">;
	presenceStore: files_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	topStickyFloatingSlot?: React.ReactNode;
};

function FileEditorRichTextInner(props: FileEditorRichTextInner_Props) {
	const { filesYjs, nodeId, presenceStore, commentsPortalHost, toolbarPortalHost, topStickyFloatingSlot } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const [editor, setEditor] = useState<Editor | null>(null);

	const isEditorReady = filesYjs.syncStatus === "synchronizing" || filesYjs.syncStatus === "synchronized";

	const liveblocks = useLiveblocksExtension({
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

	const extensions = [...defaultExtensions, FileEditorRichTextToolsSlashCommand.slashCommand, liveblocks];

	const handleCreate: EditorContentProps["onCreate"] = ({ editor }) => {
		setEditor(editor);
	};

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
						sessionId={presenceStore.localSessionId}
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
						handlePaste: (view, event) => handleImagePaste(view, event, uploadFn),
						handleDrop: (view, event, _slice, moved) => handleImageDrop(view, event, moved, uploadFn),
					}}
					extensions={extensions}
					immediatelyRender={false}
					onCreate={handleCreate}
					slotAfter={
						editor && (
							<>
								<ImageResizer />
								<FileEditorRichTextToolsSlashCommand />
								<FileEditorRichTextDragHandle editor={editor} />
								<FileEditorRichTextBubble editor={editor} />
							</>
						)
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
	presenceStore: files_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	topStickyFloatingSlot?: React.ReactNode;
};

export function FileEditorRichText(props: FileEditorRichText_Props) {
	const { nodeId, presenceStore, commentsPortalHost, toolbarPortalHost, topStickyFloatingSlot, ...rest } = props;

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
