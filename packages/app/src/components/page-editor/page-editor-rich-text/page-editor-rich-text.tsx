import "./page-editor-rich-text.css";
import { useState, useEffect, useRef, useLayoutEffect } from "react";
import {
	EditorContent,
	EditorRoot,
	useEditor,
	type EditorContentProps,
	DragHandle,
	ImageResizer,
	handleCommandNavigation,
	handleImageDrop,
	handleImagePaste,
	EditorBubble,
} from "novel";
import { Editor } from "@tiptap/react";
import { useLiveblocksExtension, useIsEditorReady } from "@liveblocks/react-tiptap";
import { useSyncStatus } from "@liveblocks/react/suspense";
import { defaultExtensions } from "./extensions.ts";
import { PageEditorRichTextToolsColorSelector } from "./page-editor-rich-text-tools-color-selector.tsx";
import { PageEditorRichTextToolsLinkSetter } from "./page-editor-rich-text-tools-link-setter.tsx";
import { PageEditorRichTextToolsNodeSelector } from "./page-editor-rich-text-tools-node-selector.tsx";
import { PageEditorRichTextToolsMathToggle } from "./page-editor-rich-text-tools-math-toggle.tsx";
import { PageEditorRichTextToolsTextStyles } from "./page-editor-rich-text-tools-text-styles.tsx";
import { PageEditorRichTextToolsAddCommentButton } from "./page-editor-rich-text-tools-add-comment-button.tsx";
import { PageEditorRichTextToolsSlashCommand } from "./page-editor-rich-text-tools-slash-command.tsx";
import { PageEditorRichTextToolsHistoryButtons } from "./page-editor-rich-text-tools-history-buttons.tsx";
import { MySeparator } from "@/components/my-separator.tsx";
import NotificationsPopover from "./notifications-popover.tsx";
import { uploadFn } from "./image-upload.ts";
import { Threads } from "./threads.tsx";
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
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { PageEditorRichTextToolsInlineAi } from "./page-editor-rich-text-tools-inline-ai.tsx";
import { Sparkles } from "lucide-react";

type SyncStatus = ReturnType<typeof useSyncStatus>;

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

// #region PageEditorRichTextInner
type PageEditorRichTextInner_ClassNames =
	| "PageEditorRichTextInner"
	| "PageEditorRichTextInner-visible"
	| "PageEditorRichTextInner-editor-container"
	| "PageEditorRichTextInner-editor-wrapper"
	| "PageEditorRichTextInner-editor-content"
	| "PageEditorRichTextInner-threads-container"
	| "PageEditorRichTextInner-status-badge"
	| "PageEditorRichTextInner-word-count-badge"
	| "PageEditorRichTextInner-word-count-badge-hidden";

type PageEditorRichTextInner_Props = {
	className?: string;
	pageId: string;
	headerSlot?: React.ReactNode;
};

function PageEditorRichTextInner(props: PageEditorRichTextInner_Props) {
	const { className, pageId, headerSlot } = props;

	const [editor, setEditor] = useState<Editor | null>(null);

	const [openAi, setOpenAi] = useState(false);

	const [charsCount, setCharsCount] = useState<number>(0);

	const saveOnDbDebounce = useRef<ReturnType<typeof setTimeout>>(null);

	const updateAndSyncToMonaco = useAction(app_convex_api.ai_docs_temp.update_page_and_sync_to_monaco);

	const liveblocks = useLiveblocksExtension({
		initialContent: pages_get_rich_text_initial_content(),
		field: pages_YJS_DOC_KEYS.richText,
		comments: true,
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

	const extensions = [...defaultExtensions, PageEditorRichTextToolsSlashCommand.slashCommand, liveblocks];

	const syncStatus = useSyncStatus({ smooth: true });
	const oldSyncValue = useRef(syncStatus);
	const [syncChanged, setSyncChanged] = useState(false);
	const isEditorReady = useIsEditorReady();

	const currentMarkdownContent = useRef<string | null>(null);

	const handleCreate = ({ editor }: { editor: Editor }) => {
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
					<DragHandle editor={editor}>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							fill="none"
							viewBox="0 0 24 24"
							strokeWidth="1.5"
							stroke="currentColor"
						>
							<path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9h16.5m-16.5 6.75h16.5" />
						</svg>
					</DragHandle>
				)}
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
					slotBefore={
						/* Status Bar */
						<PageEditorRichTextToolbar
							charsCount={charsCount}
							syncStatus={syncStatus}
							syncChanged={syncChanged}
							pageId={pageId}
						/>
					}
					slotAfter={<ImageResizer />}
				>
					<div className={cn("PageEditorRichTextInner-threads-container" satisfies PageEditorRichTextInner_ClassNames)}>
						<Threads />
					</div>

					<PageEditorRichTextToolsSlashCommand />

					<PageEditorRichTextBubble open={openAi} onOpenChange={setOpenAi} />
				</EditorContent>
			</div>
			{!isEditorReady && <PageEditorSkeleton />}
		</>
	);
}
// #endregion PageEditorRichTextInner

// #region PageEditorRichTextToolbar
export type PageEditorRichTextToolbar_ClassNames =
	| "PageEditorRichTextToolbar"
	| "PageEditorRichTextToolbar-scrollable-area"
	| "PageEditorRichTextToolbar-status-badge"
	| "PageEditorRichTextToolbar-word-count-badge"
	| "PageEditorRichTextToolbar-word-count-badge-hidden";

export type PageEditorRichTextToolbar_Props = {
	charsCount: number;
	syncStatus: SyncStatus;
	syncChanged: boolean;
	pageId: string;
};

function PageEditorRichTextToolbar(props: PageEditorRichTextToolbar_Props) {
	const { charsCount, syncStatus, syncChanged, pageId } = props;

	const { editor } = useEditor();

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
					<PageEditorRichTextToolsHistoryButtons />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsNodeSelector />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsLinkSetter />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsMathToggle />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsTextStyles />
					<MySeparator orientation="vertical" />
					<PageEditorRichTextToolsColorSelector portalElement={portalElement} />
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
// #endregion PageEditorRichTextToolbar

// #region PageEditorRichTextBubble

// Derived from Liveblocks:
// liveblocks\examples\nextjs-tiptap-novel\src\components\editor\generative\generative-menu-switch.tsx

export type PageEditorRichTextBubble_ClassNames =
	| "PageEditorRichTextBubble"
	| "PageEditorRichTextBubble-content"
	| "PageEditorRichTextBubble-button"
	| "PageEditorRichTextBubble-icon";

export type PageEditorRichTextBubble_Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function PageEditorRichTextBubble(props: PageEditorRichTextBubble_Props) {
	const { open, onOpenChange } = props;

	const bubbleSurfaceRef = useRef<HTMLDivElement>(null);

	const { editor } = useEditor();

	const [portalElement, setPortalElement] = useState<HTMLElement | null>(null);

	useLayoutEffect(() => {
		if (!editor) return;

		if (!open) {
			editor.chain().clearAIHighlight().run();
		}
	}, [open]);

	return (
		<EditorBubble
			ref={bubbleSurfaceRef}
			className={cn("PageEditorRichTextBubble" satisfies PageEditorRichTextBubble_ClassNames)}
			options={{
				placement: "bottom-start",
				onHide: () => {
					if (!editor) {
						return;
					}

					onOpenChange(false);
					editor.chain().clearAIHighlight().run();
				},
			}}
		>
			<div
				ref={(inst) => {
					setPortalElement(inst);
				}}
				className={cn("PageEditorRichTextBubble-content" satisfies PageEditorRichTextBubble_ClassNames)}
			>
				{open && <PageEditorRichTextToolsInlineAi open={open} onOpenChange={onOpenChange} />}
				{!open && portalElement && (
					<>
						<MyButton
							variant="ghost"
							className={cn("PageEditorRichTextBubble-button" satisfies PageEditorRichTextBubble_ClassNames)}
							onClick={() => onOpenChange(true)}
						>
							<MyButtonIcon
								className={cn("PageEditorRichTextBubble-icon" satisfies PageEditorRichTextBubble_ClassNames)}
							>
								<Sparkles />
							</MyButtonIcon>
							Ask AI
						</MyButton>
						<MySeparator orientation="vertical" />
						<PageEditorRichTextToolsNodeSelector />
						<MySeparator orientation="vertical" />
						<PageEditorRichTextToolsLinkSetter />
						<MySeparator orientation="vertical" />
						<PageEditorRichTextToolsMathToggle />
						<MySeparator orientation="vertical" />
						<PageEditorRichTextToolsTextStyles />
						<MySeparator orientation="vertical" />
						<PageEditorRichTextToolsColorSelector portalElement={portalElement} />
						<MySeparator orientation="vertical" />
						<PageEditorRichTextToolsAddCommentButton />
					</>
				)}
			</div>
		</EditorBubble>
	);
}
// #endregion PageEditorRichTextBubble
