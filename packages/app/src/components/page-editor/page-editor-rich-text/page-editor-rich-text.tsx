import "./page-editor-rich-text.css";
import { useState, useEffect, useRef, useEffectEvent } from "react";
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
import { Editor } from "@tiptap/react";
import { useLiveblocksExtension } from "@liveblocks/react-tiptap";
import type { YjsSyncStatus } from "@liveblocks/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { defaultExtensions } from "./extensions.ts";
import { PageEditorRichTextToolsColorSelector } from "./page-editor-rich-text-tools-color-selector.tsx";
import { PageEditorRichTextToolsLinkSetter } from "./page-editor-rich-text-tools-link-setter.tsx";
import { PageEditorRichTextToolsNodeSelector } from "./page-editor-rich-text-tools-node-selector.tsx";
import { PageEditorRichTextToolsMathToggle } from "./page-editor-rich-text-tools-math-toggle.tsx";
import { PageEditorRichTextToolsTextStyles } from "./page-editor-rich-text-tools-text-styles.tsx";
import { PageEditorRichTextToolsSlashCommand } from "./page-editor-rich-text-tools-slash-command.tsx";
import { PageEditorRichTextToolsHistoryButtons } from "./page-editor-rich-text-tools-history-buttons.tsx";
import { MySeparator } from "@/components/my-separator.tsx";
import { uploadFn } from "./image-upload.ts";
import { PageEditorRichTextAnchoredComments } from "./page-editor-rich-text-comments.tsx";
import PageEditorSnapshotsModal from "../page-editor-snapshots-modal.tsx";
import { AI_NAME } from "./constants.ts";
import {
	ai_chat_HARDCODED_ORG_ID,
	ai_chat_HARDCODED_PROJECT_ID,
	check_element_is_in_allowed_areas,
	cn,
} from "@/lib/utils.ts";
import type { AppClassName, AppElementId } from "@/lib/dom-utils.ts";
import { app_fetch_ai_docs_contextual_prompt } from "@/lib/fetch.ts";
import { MyBadge } from "@/components/my-badge.tsx";
import { PageEditorSkeleton } from "../page-editor-skeleton.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { pages_get_rich_text_initial_content, pages_PresenceStore, pages_YJS_DOC_KEYS } from "@/lib/pages.ts";
import { MyButton, MyButtonIcon, type MyButton_Props } from "@/components/my-button.tsx";
import { PageEditorRichTextToolsInlineAi } from "./page-editor-rich-text-tools-inline-ai.tsx";
import { PageEditorRichTextToolsComment } from "./page-editor-rich-text-tools-comment.tsx";
import { Sparkles, MessageSquarePlus } from "lucide-react";
import { PageEditorRichTextDragHandle } from "./page-editor-rich-text-drag-handle.tsx";
import type { EditorBubbleProps } from "../../../../vendor/novel/packages/headless/src/components/editor-bubble.tsx";
import { useLiveRef, useRenderPromise } from "../../../hooks/utils-hooks.ts";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { usePagesYjs, type pages_Yjs } from "@/hooks/pages-hooks.ts";
import { getThreadIdsFromEditorState } from "@liveblocks/react-tiptap";
import { global_event_listen_all } from "../../../lib/global-event.tsx";

type SyncStatus = YjsSyncStatus;

// #region toolbar
export type PageEditorRichTextToolbar_ClassNames =
	| "PageEditorRichTextToolbar"
	| "PageEditorRichTextToolbar-scrollable-area"
	| "PageEditorRichTextToolbar-status-badge"
	| "PageEditorRichTextToolbar-word-count-badge"
	| "PageEditorRichTextToolbar-word-count-badge-hidden";

export type PageEditorRichTextToolbar_Props = {
	editor: Editor;
	syncStatus: SyncStatus;
	syncChanged: boolean;
	charsCount: number;
	pageId: app_convex_Id<"pages">;
	sessionId: string;
};

function PageEditorRichTextToolbar(props: PageEditorRichTextToolbar_Props) {
	const { editor, syncStatus, syncChanged, charsCount, pageId, sessionId } = props;

	const [portalElement, setPortalElement] = useState<HTMLElement | null>(null);

	return (
		<div
			ref={setPortalElement}
			role="toolbar"
			aria-label="Toolbar"
			aria-orientation="horizontal"
			className={cn("PageEditorRichTextToolbar" satisfies PageEditorRichTextToolbar_ClassNames)}
		>
			{portalElement && (
				<div className={cn("PageEditorRichTextToolbar-scrollable-area" satisfies PageEditorRichTextToolbar_ClassNames)}>
					<PageEditorRichTextToolsHistoryButtons editor={editor} />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsNodeSelector editor={editor} setDecorationHighlightOnOpen={true} />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsLinkSetter editor={editor} setDecorationHighlightOnOpen={true} />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsMathToggle editor={editor} />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsTextStyles editor={editor} />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsColorSelector editor={editor} setDecorationHighlightOnOpen={true} />
					<MySeparator orientation="vertical" />
					<MyBadge
						variant="secondary"
						className={cn("PageEditorRichTextToolbar-status-badge" satisfies PageEditorRichTextToolbar_ClassNames)}
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
							charsCount
								? ("PageEditorRichTextToolbar-word-count-badge" satisfies PageEditorRichTextToolbar_ClassNames)
								: ("PageEditorRichTextToolbar-word-count-badge-hidden" satisfies PageEditorRichTextToolbar_ClassNames),
						)}
					>
						{charsCount} Words
					</MyBadge>
					<PageEditorSnapshotsModal
						pageId={pageId}
						sessionId={sessionId}
						getCurrentMarkdown={() => editor.getMarkdown()}
					/>
				</div>
			)}
		</div>
	);
}
// #endregion toolbar

// #region top sticky floating container
type PageEditorRichTextTopStickyFloatingContainer_ClassNames = "PageEditorRichTextTopStickyFloatingContainer";

type PageEditorRichTextTopStickyFloatingContainer_Props = {
	topStickyFloatingSlot: React.ReactNode;
};

function PageEditorRichTextTopStickyFloatingContainer(props: PageEditorRichTextTopStickyFloatingContainer_Props) {
	const { topStickyFloatingSlot } = props;

	return (
		<div
			className={cn(
				"PageEditorRichTextTopStickyFloatingContainer" satisfies PageEditorRichTextTopStickyFloatingContainer_ClassNames,
			)}
		>
			{topStickyFloatingSlot}
		</div>
	);
}
// #endregion top sticky floating container

// #region bubble

// Derived from Liveblocks:
// liveblocks\examples\nextjs-tiptap-novel\src\components\editor\generative\generative-menu-switch.tsx

export type PageEditorRichTextBubble_ClassNames =
	| "PageEditorRichTextBubble"
	| "PageEditorRichTextBubble-rendered"
	| "PageEditorRichTextBubble-content"
	| "PageEditorRichTextBubble-button"
	| "PageEditorRichTextBubble-icon";

export type PageEditorRichTextBubble_Props = {
	editor: Editor;
};

/**
 * Bubble menu visibility rules (TipTap/Novel + local overrides).
 *
 * The bubble is configured to hide when:
 * - The user interacts outside the editor/bubble (global `pointerdown`)
 * - The current selection is collapsed / empty (TipTap/Novel `shouldShow`)
 * - The user presses Escape while no bubble popover is open (Escape handlers hide the bubble)
 *
 * It prevents the default behavior from closing when:
 * - Focus moves inside the bubble itself (TipTap `isChildOfMenu`)
 * - The user interacts with portaled/hoisted popovers opened from the bubble (`isElContainedInManagedAreas`)
 * - The user presses Escape to close a popover in the bubble (popover closes, bubble stays visible)
 */
export function PageEditorRichTextBubble(props: PageEditorRichTextBubble_Props) {
	const { editor } = props;

	const bubbleSurfaceRef = useRef<HTMLDivElement>(null);
	const isShownRef = useRef(false);

	const [portalElement, setPortalElement] = useState<HTMLElement | null>(null);
	const [rendered, setRendered] = useState(true);

	const [openComment, setOpenComment] = useState(false);
	const [openAi, setOpenAi] = useState(false);

	const renderPromise = useRenderPromise();

	/**
	 * The container for the tiptap hoisted elements.
	 * Used by the bubble to allow it to close when clicking on
	 * focusable elements in the page because it checks for the parent
	 * element to contain the focus relatedTarget and if the bubble
	 * is hoisted in the body, the body will always contain the focus relatedTarget
	 * preventing the bubble from closing.
	 */
	const hoistingContainer = document.getElementById("app_tiptap_hoisting_container" satisfies AppElementId);

	const updateBubbleMenuPosition = () => {
		editor.view.dispatch(editor.state.tr.setMeta("bubbleMenu", "updatePosition"));
	};

	const shouldShow: NonNullable<EditorBubbleProps["shouldShow"]> = (params) => {
		// Leverage the fact that shouldShow is called only when the selection
		// changes in the editor so if the focus moves into an element that
		// is "managed" and should not cause the bubble to close, we keep it open.
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

		const novelResult = EditorBubble.novelShouldShowImpl(params);

		return novelResult;
	};

	const handleHide: NonNullable<EditorBubbleProps["options"]>["onHide"] = () => {
		isShownRef.current = false;

		// Reset rendered state so it's already `true` on show
		setRendered(true);

		setOpenAi(false);
		setOpenComment(false);

		PageEditorRichText.clearDecorationHighlightProperly(editor);
	};

	const handleShow: NonNullable<EditorBubbleProps["options"]>["onShow"] = () => {
		isShownRef.current = true;

		editor.commands.setDecorationHighlight();
	};

	// handle the escape key when the bubble menu or its descendants are focused
	const handleKeyDown: EditorBubbleProps["onKeyDown"] = (event) => {
		if (event.key === "Escape" && event.currentTarget.contains(event.target as HTMLElement)) {
			setRendered(false);
			editor.commands.focus();
		}
	};

	const handleClickAi: MyButton_Props["onClick"] = () => {
		setOpenAi(true);

		// Recalculate the bubble menu position after the AI component is rendered
		renderPromise
			.wait()
			.then(() => {
				updateBubbleMenuPosition();
			})
			.catch((error) => {
				console.error("[PageEditorRichText.handleClickAi] Error updating bubble menu position", { error });
			});
	};

	const handleClickComment: MyButton_Props["onClick"] = () => {
		setOpenComment(true);

		// Recalculate the bubble menu position after the comment component is rendered
		renderPromise
			.wait()
			.then(() => {
				updateBubbleMenuPosition();
			})
			.catch((error) => {
				console.error("[PageEditorRichText.handleClickComment] Error updating bubble menu position", { error });
			});
	};

	const handleDiscardAi: () => void = () => {
		setOpenAi(false);
	};

	const handleCloseComment: () => void = () => {
		setOpenComment(false);
		setRendered(false);
	};

	// On mount
	useEffect(() => {
		const rootElement = document.getElementById("root" satisfies AppElementId);

		// Register a plugin to handle the escape key to hide the bubble menu while the focus is on the editor
		const bubbleEscPluginKey = new PluginKey("PageEditorRichTextBubble_escape_key_handler");
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

		// Listen for selection updates and reapply the decoration highlight if the bubble menu is shown
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

		// Global event listeners

		const clearEventListeners = global_event_listen_all(
			["keydown", "pointerdown"],
			(event) => {
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
					PageEditorRichText.clearDecorationHighlightProperly(editor);

					if (event instanceof KeyboardEvent) {
						event.preventDefault();
					}
				}
			},
			{ capture: true },
		);

		return () => {
			editor.unregisterPlugin(bubbleEscPluginKey);
			editor.off("selectionUpdate", handleSelectionUpdate);
			clearEventListeners();
		};
	}, []);

	return hoistingContainer ? (
		<EditorBubble
			ref={bubbleSurfaceRef}
			className={cn(
				"PageEditorRichTextBubble" satisfies PageEditorRichTextBubble_ClassNames,
				rendered && ("PageEditorRichTextBubble-rendered" satisfies PageEditorRichTextBubble_ClassNames),
			)}
			appendTo={hoistingContainer}
			shouldShow={shouldShow}
			options={{
				placement: "bottom-start",
				flip: false,
				shift: {
					padding: 120,
				},
				onHide: handleHide,
				onShow: handleShow,
			}}
			onKeyDown={handleKeyDown}
		>
			<div
				ref={(inst) => {
					setPortalElement(inst);
				}}
				className={cn("PageEditorRichTextBubble-content" satisfies PageEditorRichTextBubble_ClassNames)}
			>
				{openAi && <PageEditorRichTextToolsInlineAi editor={editor} onDiscard={handleDiscardAi} />}
				{openComment && <PageEditorRichTextToolsComment onClose={handleCloseComment} />}
				{!openAi && !openComment && portalElement && (
					<>
						<MyButton
							variant="ghost"
							className={cn("PageEditorRichTextBubble-button" satisfies PageEditorRichTextBubble_ClassNames)}
							onClick={handleClickAi}
						>
							<MyButtonIcon
								className={cn("PageEditorRichTextBubble-icon" satisfies PageEditorRichTextBubble_ClassNames)}
							>
								<Sparkles />
							</MyButtonIcon>
							Ask AI
						</MyButton>
						<MySeparator orientation="vertical" />
						<PageEditorRichTextToolsNodeSelector editor={editor} />
						<MySeparator orientation="vertical" />
						<PageEditorRichTextToolsLinkSetter editor={editor} />
						<MySeparator orientation="vertical" />
						<PageEditorRichTextToolsMathToggle editor={editor} />
						<MySeparator orientation="vertical" />
						<PageEditorRichTextToolsTextStyles editor={editor} />
						<MySeparator orientation="vertical" />
						<PageEditorRichTextToolsColorSelector editor={editor} />
						<MySeparator orientation="vertical" />
						<MyButton
							variant="ghost"
							className={cn("PageEditorRichTextBubble-button" satisfies PageEditorRichTextBubble_ClassNames)}
							onClick={handleClickComment}
						>
							<MyButtonIcon
								className={cn("PageEditorRichTextBubble-icon" satisfies PageEditorRichTextBubble_ClassNames)}
							>
								<MessageSquarePlus />
							</MyButtonIcon>
							Comment
						</MyButton>
					</>
				)}
			</div>
		</EditorBubble>
	) : null;
}
// #endregion bubble

// #region root
export type PageEditorRichText_ClassNames =
	| "PageEditorRichText"
	| "PageEditorRichText-visible"
	| "PageEditorRichText-editor-content-root"
	| "PageEditorRichText-editor-content-container"
	| "PageEditorRichText-editor-content"
	| "PageEditorRichText-status-badge"
	| "PageEditorRichText-word-count-badge"
	| "PageEditorRichText-word-count-badge-hidden";

type PageEditorRichText_Inner_Props = {
	pagesYjs: pages_Yjs;
	pageId: app_convex_Id<"pages">;
	presenceStore: pages_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	topStickyFloatingSlot?: React.ReactNode;
};

function PageEditorRichText_Inner(props: PageEditorRichText_Inner_Props) {
	const { pagesYjs, pageId, presenceStore, commentsPortalHost, topStickyFloatingSlot } = props;

	const [editor, setEditor] = useState<Editor | null>(null);
	const editorRef = useLiveRef(editor);

	const [charsCount, setCharsCount] = useState<number>(0);

	const [threadIds, setThreadIds] = useState<string[]>([]);
	const threadIdsKeyRef = useRef<string>("");

	const isEditorReady = pagesYjs.syncStatus === "synchronizing" || pagesYjs.syncStatus === "synchronized";

	const liveblocks = useLiveblocksExtension({
		initialContent: pages_get_rich_text_initial_content(),
		field: pages_YJS_DOC_KEYS.richText,
		presenceStore,
		yjsProvider: pagesYjs.yjsProvider,
		ai: {
			name: AI_NAME,
			resolveContextualPrompt: async ({ prompt, context, previous, signal }: any) => {
				const result = await app_fetch_ai_docs_contextual_prompt({
					input: { prompt, context, previous },
					signal,
				});

				if (result._yay) {
					return result._yay.payload;
				} else {
					throw new Error("[PageEditorRichText.resolveContextualPrompt] Failed to resolve contextual prompt", {
						cause: result._nay,
					});
				}
			},
		},
	});

	const extensions = [...defaultExtensions, PageEditorRichTextToolsSlashCommand.slashCommand, liveblocks];

	const threadsQuery = useStableQuery(
		app_convex_api.chat_messages.chat_messages_threads_list,
		threadIds.length > 0
			? {
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					threadIds: threadIds,
					isArchived: false,
				}
			: "skip",
	);

	const currentMarkdownContent = useRef<string | null>(null);

	const updateThreadIds = (editor: Editor) => {
		const nextThreadIds = getThreadIdsFromEditorState(editor.state).toSorted();
		const nextKey = nextThreadIds.join("\n");

		if (nextKey === threadIdsKeyRef.current) return;

		threadIdsKeyRef.current = nextKey;
		setThreadIds(nextThreadIds);
	};

	const handleThreadsQuery = useEffectEvent(() => {
		if (!editor || !isEditorReady || !threadsQuery || threadIds.length === 0) {
			return;
		}

		const activeThreadIds = new Set(threadsQuery.threads.map((thread) => thread.id as string));
		const threadsToUpdate = threadIds.map((threadId) => ({
			threadId,
			orphan: !activeThreadIds.has(threadId),
		}));

		if (threadsToUpdate.length > 0) {
			editorRef.current?.commands.command(({ commands }) => {
				threadsToUpdate.forEach(({ threadId, orphan }) => {
					commands.markCommentAsOrphan({ threadId, orphan });
				});
				return true;
			});
		}
	});

	const handleCreate: EditorContentProps["onCreate"] = ({ editor }) => {
		setEditor(editor);

		updateThreadIds(editor);
	};

	const handleUpdate: EditorContentProps["onUpdate"] = ({ editor }) => {
		setCharsCount(editor.storage.characterCount.words());

		updateThreadIds(editor);
	};

	useEffect(handleThreadsQuery, [editor, isEditorReady, threadsQuery]);

	useEffect(() => {
		if (editor && isEditorReady) {
			currentMarkdownContent.current = editor.getMarkdown();
		}
	}, [isEditorReady]);

	return (
		<>
			<div
				className={cn(
					"PageEditorRichText" satisfies PageEditorRichText_ClassNames,
					// Due to some weird combination of things, if the EditorContent component is not rendered
					// it results in it creating the TipTap Editor instance twice causing issues when
					// settings the initial content, therefore the componet has to be rendered but
					// hidden via cSS to prevent incomplete content to show while all the things are loading.
					isEditorReady && ("PageEditorRichText-visible" satisfies PageEditorRichText_ClassNames),
				)}
			>
				{editor && (
					<PageEditorRichTextToolbar
						editor={editor}
						charsCount={charsCount}
						syncStatus={pagesYjs.syncStatus}
						syncChanged={pagesYjs.syncChanged}
						pageId={pageId}
						sessionId={presenceStore.localSessionId}
					/>
				)}
				<PageEditorRichTextTopStickyFloatingContainer topStickyFloatingSlot={topStickyFloatingSlot} />
				<EditorContent
					className={cn("PageEditorRichText-editor-content-root" satisfies PageEditorRichText_ClassNames)}
					injectCSS={false}
					editorContainerProps={{
						className: cn("PageEditorRichText-editor-content-container" satisfies PageEditorRichText_ClassNames),
					}}
					editorProps={{
						attributes: {
							class: cn(
								"app-doc" satisfies AppClassName,
								"PageEditorRichText-editor-content" satisfies PageEditorRichText_ClassNames,
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
					onUpdate={handleUpdate}
					slotAfter={
						editor && (
							<>
								<ImageResizer />
								<PageEditorRichTextToolsSlashCommand />
								<PageEditorRichTextDragHandle editor={editor} />
								<PageEditorRichTextBubble editor={editor} />
							</>
						)
					}
				></EditorContent>
			</div>
			{commentsPortalHost &&
				editor &&
				createPortal(
					<PageEditorRichTextAnchoredComments editor={editor} threads={threadsQuery?.threads} />,
					commentsPortalHost,
				)}
			{!isEditorReady && <PageEditorSkeleton />}
		</>
	);
}

export type PageEditorRichText_CustomAttributes = {
	"data-app-set-decoration-highlight": "";
};

export type PageEditorRichText_BgColorCssVarKeys =
	| "--PageEditorRichText-text-color-bg-default"
	| "--PageEditorRichText-text-color-bg-purple"
	| "--PageEditorRichText-text-color-bg-red"
	| "--PageEditorRichText-text-color-bg-yellow"
	| "--PageEditorRichText-text-color-bg-blue"
	| "--PageEditorRichText-text-color-bg-green"
	| "--PageEditorRichText-text-color-bg-orange"
	| "--PageEditorRichText-text-color-bg-pink"
	| "--PageEditorRichText-text-color-bg-gray";

export type PageEditorRichText_FgColorCssVarKeys =
	| "--PageEditorRichText-text-color-fg-default"
	| "--PageEditorRichText-text-color-fg-purple"
	| "--PageEditorRichText-text-color-fg-red"
	| "--PageEditorRichText-text-color-fg-yellow"
	| "--PageEditorRichText-text-color-fg-blue"
	| "--PageEditorRichText-text-color-fg-green"
	| "--PageEditorRichText-text-color-fg-orange"
	| "--PageEditorRichText-text-color-fg-pink"
	| "--PageEditorRichText-text-color-fg-gray";

export type PageEditorRichText_Props = React.ComponentProps<"div"> & {
	pageId: app_convex_Id<"pages">;
	presenceStore: pages_PresenceStore;
	commentsPortalHost: HTMLElement | null;
	topStickyFloatingSlot?: React.ReactNode;
};

export function PageEditorRichText(props: PageEditorRichText_Props) {
	const { pageId, presenceStore, commentsPortalHost, topStickyFloatingSlot, ...rest } = props;

	const pagesYjs = usePagesYjs({
		pageId: pageId,
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		presenceStore,
	});

	return (
		// remount on pageId to prevent stale state on page changes
		<EditorRoot key={pageId}>
			{pagesYjs ? (
				<PageEditorRichText_Inner
					pagesYjs={pagesYjs}
					pageId={pageId}
					presenceStore={presenceStore}
					commentsPortalHost={commentsPortalHost}
					topStickyFloatingSlot={topStickyFloatingSlot}
					{...rest}
				/>
			) : (
				<PageEditorSkeleton />
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
PageEditorRichText.clearDecorationHighlightProperly = (editor: Editor, triggerElement?: HTMLElement | null) => {
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
				"data-app-set-decoration-highlight" satisfies keyof PageEditorRichText_CustomAttributes,
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
