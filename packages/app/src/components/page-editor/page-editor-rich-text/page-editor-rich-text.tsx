import "./page-editor-rich-text.css";
import { useState, useEffect, useRef, useEffectEvent } from "react";
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
import { useLiveblocksExtension, useIsEditorReady, CommentsExtension } from "@liveblocks/react-tiptap";
import { useSyncStatus } from "@liveblocks/react/suspense";
import { useQuery } from "convex/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { defaultExtensions } from "./extensions.ts";
import { PageEditorRichTextToolsColorSelector } from "./page-editor-rich-text-tools-color-selector.tsx";
import { PageEditorRichTextToolsLinkSetter } from "./page-editor-rich-text-tools-link-setter.tsx";
import { PageEditorRichTextToolsNodeSelector } from "./page-editor-rich-text-tools-node-selector.tsx";
import { PageEditorRichTextToolsMathToggle } from "./page-editor-rich-text-tools-math-toggle.tsx";
import { PageEditorRichTextToolsTextStyles } from "./page-editor-rich-text-tools-text-styles.tsx";
import { PageEditorRichTextToolsSlashCommand } from "./page-editor-rich-text-tools-slash-command.tsx";
import { PageEditorRichTextToolsHistoryButtons } from "./page-editor-rich-text-tools-history-buttons.tsx";
import { MySeparator, type MySeparator_ClassNames } from "@/components/my-separator.tsx";
import NotificationsPopover from "./notifications-popover.tsx";
import { uploadFn } from "./image-upload.ts";
import { PageEditorRichTextAnchoredComments } from "./page-editor-rich-text-comments.tsx";
import PageEditorSnapshotsModal from "./page-editor-snapshots-modal.tsx";
import { AI_NAME } from "./constants.ts";
import { cn } from "@/lib/utils.ts";
import { app_fetch_ai_docs_contextual_prompt } from "@/lib/fetch.ts";
import { useAction } from "convex/react";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { MyBadge } from "@/components/my-badge.tsx";
import { PageEditorSkeleton } from "../page-editor-skeleton.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { pages_get_rich_text_initial_content, pages_YJS_DOC_KEYS } from "@/lib/pages.ts";
import { MyButton, MyButtonIcon, type MyButton_Props } from "@/components/my-button.tsx";
import { PageEditorRichTextToolsInlineAi } from "./page-editor-rich-text-tools-inline-ai.tsx";
import { PageEditorRichTextToolsComment } from "./page-editor-rich-text-tools-comment.tsx";
import { Sparkles, MessageSquarePlus } from "lucide-react";
import { PageEditorRichTextDragHandle } from "./page-editor-rich-text-drag-handle.tsx";
import type { EditorBubbleProps } from "../../../../vendor/novel/packages/headless/src/components/editor-bubble.tsx";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useLiveRef, useRenderPromise } from "../../../hooks/utils-hooks.ts";

type SyncStatus = ReturnType<typeof useSyncStatus>;

// #region Toolbar
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
	pageId: string;
};

function PageEditorRichTextToolbar(props: PageEditorRichTextToolbar_Props) {
	const { editor, syncStatus, syncChanged, charsCount, pageId } = props;

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
					<PageEditorRichTextToolsNodeSelector editor={editor} />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsLinkSetter editor={editor} />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsMathToggle editor={editor} />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsTextStyles editor={editor} />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsColorSelector editor={editor} portalElement={portalElement} />
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
					<PageEditorSnapshotsModal pageId={pageId} editor={editor} />
					<NotificationsPopover />
				</div>
			)}
		</div>
	);
}
// #endregion Toolbar

// #region Bubble

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

export function PageEditorRichTextBubble(props: PageEditorRichTextBubble_Props) {
	const { editor } = props;

	const bubbleSurfaceRef = useRef<HTMLDivElement>(null);
	const isShownRef = useRef(false);

	const [portalElement, setPortalElement] = useState<HTMLElement | null>(null);
	const [rendered, setRendered] = useState(true);

	const [openComment, setOpenComment] = useState(false);
	const [openAi, setOpenAi] = useState(false);

	const renderPromise = useRenderPromise();

	function updateBubbleMenuPosition() {
		editor.view.dispatch(editor.state.tr.setMeta("bubbleMenu", "updatePosition"));
	}

	const handleMount = useEffectEvent(() => {
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
				editor.commands.setDecorationHighlight();
			}
		};
		editor.on("selectionUpdate", handleSelectionUpdate);

		return () => {
			editor.unregisterPlugin(bubbleEscPluginKey);
			editor.off("selectionUpdate", handleSelectionUpdate);
		};
	});

	const handleHide: NonNullable<EditorBubbleProps["options"]>["onHide"] = () => {
		isShownRef.current = false;

		// Reset rendered state so it's already `true` on show
		setRendered(true);

		setOpenAi(false);
		setOpenComment(false);
		editor.chain().clearDecorationHighlight().focus().run();
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
			.catch(console.error);
	};

	const handleClickComment: MyButton_Props["onClick"] = () => {
		setOpenComment(true);

		// Recalculate the bubble menu position after the comment component is rendered
		renderPromise
			.wait()
			.then(() => {
				updateBubbleMenuPosition();
			})
			.catch(console.error);
	};

	const handleDiscardAi: () => void = () => {
		setOpenAi(false);
	};

	const handleCloseComment: () => void = () => {
		setOpenComment(false);
		setRendered(false);
	};

	useEffect(handleMount, []);

	return (
		<EditorBubble
			ref={bubbleSurfaceRef}
			className={cn(
				"PageEditorRichTextBubble" satisfies PageEditorRichTextBubble_ClassNames,
				rendered && ("PageEditorRichTextBubble-rendered" satisfies PageEditorRichTextBubble_ClassNames),
			)}
			options={{
				placement: "bottom-start",
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
						<PageEditorRichTextToolsColorSelector editor={editor} portalElement={portalElement} />
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
	);
}
// #endregion Bubble

// #region Inner
type PageEditorRichTextInner_ClassNames =
	| "PageEditorRichTextInner"
	| "PageEditorRichTextInner-visible"
	| "PageEditorRichTextInner-editor-container"
	| "PageEditorRichTextInner-editor-wrapper"
	| "PageEditorRichTextInner-editor-content"
	| "PageEditorRichTextInner-panel-resize-handle"
	| "PageEditorRichTextInner-threads-container"
	| "PageEditorRichTextInner-status-badge"
	| "PageEditorRichTextInner-word-count-badge"
	| "PageEditorRichTextInner-word-count-badge-hidden";

type PageEditorRichTextInner_Props = {
	className?: string;
	pageId: string;
	headerSlot?: React.ReactNode;
};

function useThreadsQuery(args: { threadIds: string[] }) {
	const threadsQuery = useQuery(
		app_convex_api.human_thread_messages.human_thread_messages_threads_list,
		args.threadIds.length > 0
			? {
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					threadIds: args.threadIds,
					isArchived: false,
				}
			: "skip",
	);

	const threadsQueryCache = useRef(threadsQuery);

	if (threadsQuery !== undefined) {
		// eslint-disable-next-line react-hooks/refs
		threadsQueryCache.current = threadsQuery;
	}

	// eslint-disable-next-line react-hooks/refs
	return threadsQuery ?? threadsQueryCache.current;
}

function PageEditorRichTextInner(props: PageEditorRichTextInner_Props) {
	const { className, pageId, headerSlot } = props;

	const [editor, setEditor] = useState<Editor | null>(null);
	const editorRef = useLiveRef(editor);

	const [charsCount, setCharsCount] = useState<number>(0);

	const saveOnDbDebounce = useRef<ReturnType<typeof setTimeout>>(null);

	const updateAndSyncToMonaco = useAction(app_convex_api.ai_docs_temp.update_page_and_sync_to_monaco);

	const [threadIds, setThreadIds] = useState<string[]>([]);

	const syncStatus = useSyncStatus({ smooth: true });
	const oldSyncValue = useRef(syncStatus);
	const [syncChanged, setSyncChanged] = useState(false);
	const isEditorReady = useIsEditorReady();

	const liveblocks = useLiveblocksExtension({
		initialContent: pages_get_rich_text_initial_content(),
		field: pages_YJS_DOC_KEYS.richText,
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
					throw new Error(`Failed to resolve contextual prompt: ${result._nay.message}`);
				}
			},
		},
	});

	const extensions = [
		...defaultExtensions,
		PageEditorRichTextToolsSlashCommand.slashCommand,
		liveblocks,
		CommentsExtension.configure({
			onThreadsChange: setThreadIds,
		}),
	];

	const threadsQuery = useThreadsQuery({ threadIds });

	const currentMarkdownContent = useRef<string | null>(null);

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
	};

	const handleUpdate: EditorContentProps["onUpdate"] = ({ editor, transaction }) => {
		setCharsCount(editor.storage.characterCount.words());

		// Detect if this is a Yjs backend update
		const isFromYjs = !!transaction.getMeta(ySyncPluginKey);

		if (!isFromYjs) {
			// Local update from this client - save to DB
			// Debounce content save to Convex (500ms)
			if (saveOnDbDebounce.current) {
				clearTimeout(saveOnDbDebounce.current);
			}

			saveOnDbDebounce.current = setTimeout(async () => {
				try {
					const markdownContent = editor.getMarkdown();

					if (currentMarkdownContent.current !== markdownContent) {
						console.debug("[PageEditorRichText] Saving markdown to DB:", {
							html: editor.getHTML(),
							markdown: markdownContent,
							transaction,
						});
						currentMarkdownContent.current = markdownContent;
						await updateAndSyncToMonaco({
							workspaceId: ai_chat_HARDCODED_ORG_ID,
							projectId: ai_chat_HARDCODED_PROJECT_ID,
							pageId: pageId!,
							textContent: markdownContent,
						});
					}
				} catch (error) {
					console.error("Failed to save text content:", error);
				}
			}, 500);
		}
	};

	useEffect(handleThreadsQuery, [editor, isEditorReady, threadsQuery]);

	useEffect(() => {
		// Cleanup save debounce on unmount
		return () => {
			if (saveOnDbDebounce.current) {
				window.clearTimeout(saveOnDbDebounce.current);
			}
		};
	}, []);

	useEffect(() => {
		if (editor && isEditorReady) {
			console.debug("[PageEditorRichText] Editor is ready");
			currentMarkdownContent.current = editor.getMarkdown();
		}
	}, [isEditorReady]);

	// Detect if the sync status changed
	useEffect(() => {
		if (isEditorReady && editor && oldSyncValue.current !== syncStatus) {
			setSyncChanged(true);
		}
	}, [syncStatus]);

	return (
		<>
			<div
				className={cn(
					"PageEditorRichTextInner" satisfies PageEditorRichTextInner_ClassNames,
					// Due to some weird combination of things, if the EditorContent component is not rendered
					// it results in it creating the TipTap Editor instance twice causing issues when
					// settings the initial content, therefore the componet has to be rendered but
					// hidden via cSS to prevent incomplete content to show while all the things are loading.
					isEditorReady && ("PageEditorRichTextInner-visible" satisfies PageEditorRichTextInner_ClassNames),
					className,
				)}
			>
				{headerSlot}
				{editor && (
					<PageEditorRichTextToolbar
						editor={editor}
						charsCount={charsCount}
						syncStatus={syncStatus}
						syncChanged={syncChanged}
						pageId={pageId}
					/>
				)}
				<PanelGroup direction="horizontal">
					<Panel collapsible={false} defaultSize={75}>
						<EditorContent
							className={cn("PageEditorRichTextInner-editor-wrapper" satisfies PageEditorRichTextInner_ClassNames)}
							editorContainerProps={{
								className: cn("PageEditorRichTextInner-editor-container" satisfies PageEditorRichTextInner_ClassNames),
							}}
							editorProps={{
								attributes: {
									class: cn("PageEditorRichTextInner-editor-content" satisfies PageEditorRichTextInner_ClassNames),
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
					</Panel>
					<PanelResizeHandle
						className={cn(
							"PageEditorRichTextInner-panel-resize-handle" satisfies PageEditorRichTextInner_ClassNames,
							"MySeparator" satisfies MySeparator_ClassNames,
							"MySeparator-vertical" satisfies MySeparator_ClassNames,
						)}
					/>
					<Panel
						className={cn("PageEditorRichTextInner-threads-container" satisfies PageEditorRichTextInner_ClassNames)}
						collapsible={false}
						defaultSize={25}
					>
						{editor && threadsQuery && (
							<PageEditorRichTextAnchoredComments editor={editor} threads={threadsQuery.threads} />
						)}
					</Panel>
				</PanelGroup>
			</div>
			{!isEditorReady && <PageEditorSkeleton />}
		</>
	);
}
// #endregion Inner

// #region PageEditorRichText
export type PageEditorRichText_ClassNames = "PageEditorRichText";

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
	pageId: string;
	headerSlot?: React.ReactNode;
};

export function PageEditorRichText(props: PageEditorRichText_Props) {
	const { className, pageId, headerSlot, ...rest } = props;

	return (
		// remount on pageId to prevent stale state on page changes
		<EditorRoot key={pageId}>
			<PageEditorRichTextInner
				className={cn("PageEditorRichText" satisfies PageEditorRichText_ClassNames, className)}
				pageId={pageId}
				headerSlot={headerSlot}
				{...rest}
			/>
		</EditorRoot>
	);
}
// #endregion PageEditorRichText
