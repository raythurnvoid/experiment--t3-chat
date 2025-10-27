import "./page-editor-rich-text.css";
import { useState, useEffect, useRef } from "react";
import { EditorContent, EditorRoot, useEditor, type EditorContentProps, DragHandle } from "novel";
import { Editor, type JSONContent as TiptapJSONContent } from "@tiptap/react";
import { ImageResizer, handleCommandNavigation, handleImageDrop, handleImagePaste } from "novel";
import { Toolbar, useLiveblocksExtension, useIsEditorReady } from "@liveblocks/react-tiptap";
import { useSyncStatus } from "@liveblocks/react/suspense";
import { defaultExtensions } from "./extensions.ts";
import { PageEditorRichTextToolsColorSelector } from "./page-editor-rich-text-tools-color-selector.tsx";
import { PageEditorRichTextToolsLinkSetter } from "./page-editor-rich-text-tools-link-setter.tsx";
import { PageEditorRichTextToolsNodeSelector } from "./page-editor-rich-text-tools-node-selector.tsx";
import { PageEditorRichTextToolsMathToggle } from "./page-editor-rich-text-tools-math-toggle.tsx";
import { PageEditorRichTextToolsTextStyles } from "./page-editor-rich-text-tools-text-styles.tsx";
import { PageEditorRichTextToolsAddCommentButton } from "./page-editor-rich-text-tools-add-comment-button.tsx";
import { Separator } from "../../ui/separator.tsx";
import GenerativeMenuSwitch from "./generative/generative-menu-switch.tsx";
import NotificationsPopover from "./notifications-popover.tsx";
import { uploadFn } from "./image-upload.ts";
import { PageEditorRichTextToolsSlashCommand } from "./page-editor-rich-text-tools-slash-command.tsx";
import { Threads } from "./threads.tsx";
import PageEditorSnapshotsModal from "./page-editor-snapshots-modal.tsx";
import { AI_NAME } from "./constants.ts";
import { cn, make } from "@/lib/utils.ts";
import { PageEditorRichTextToolsHistoryButtons } from "./page-editor-rich-text-tools-history-buttons.tsx";
import { app_fetch_ai_docs_contextual_prompt } from "@/lib/fetch.ts";
import { useMutation, useConvex } from "convex/react";
import { ySyncPluginKey } from "y-prosemirror";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { MyBadge } from "@/components/my-badge.tsx";
import { PageEditorSkeleton } from "../page-editor-skeleton.tsx";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { app_fetch_create_version_snapshot } from "@/lib/fetch.ts";
import { useAuth } from "@/lib/auth.ts";
import { useWatchableValue } from "@/hooks/utils-hooks.ts";
import type { FunctionReturnType } from "convex/server";

/**
 * 5 seconds.
 */
const SNAPSHOT_DEBOUNCE_DURATION = 5000;

type SyncStatus = ReturnType<typeof useSyncStatus>;

function useStoreSnapshot(editor: Editor | null, pageId: string) {
	const auth = useAuth();

	const snapshotTimer = useRef<ReturnType<typeof setTimeout>>(null);
	const currentSnapshotContent = useRef<string | null>(null);

	const getEditorContentAsMarkdown = () => {
		if (!editor) return null;
		return editor.getMarkdown();
	};

	const updateCurrentSnapshotContent = () => {
		currentSnapshotContent.current = getEditorContentAsMarkdown();
	};

	const sendVersionSnapshot = async () => {
		const markdownContent = getEditorContentAsMarkdown();

		if (!markdownContent || markdownContent === currentSnapshotContent.current) return;

		const result = await app_fetch_create_version_snapshot({
			input: {
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				page_id: pageId,
				content: markdownContent,
			},
			keepalive: true,
			auth: auth.isAuthenticated,
		});

		if (result._nay) {
			console.error("Failed to create version snapshot:", result._nay.message);
		}
	};

	const restartTimer = () => {
		if (snapshotTimer.current) {
			clearTimeout(snapshotTimer.current);
		}

		snapshotTimer.current = setTimeout(() => {
			void sendVersionSnapshot();
		}, SNAPSHOT_DEBOUNCE_DURATION);
	};

	const cancelTimer = () => {
		if (snapshotTimer.current) {
			clearTimeout(snapshotTimer.current);
			snapshotTimer.current = null;
		}
	};

	return {
		restartTimer,
		cancelTimer,
		sendVersionSnapshot,
		updateCurrentSnapshotContent,
	};
}

const INITIAL_CONTENT = make<TiptapJSONContent>({
	text:
		"<h1>Welcome</h1>\n" + //
		"<p>You can start editing your document here.</p>",
});

export type PageEditorRichText_ClassNames = "PageEditorRichText";

export type PageEditorRichText_Props = React.ComponentProps<"div"> & {
	pageId: string;
	headerSlot?: React.ReactNode;
};

export function PageEditorRichText(props: PageEditorRichText_Props) {
	const { className, pageId, headerSlot, ...rest } = props;

	return (
		<EditorRoot>
			<PageEditorRichTextInner
				className={cn("PageEditorRichText" satisfies PageEditorRichText_ClassNames, className)}
				initialContent={INITIAL_CONTENT}
				pageId={pageId}
				headerSlot={headerSlot}
				{...rest}
			/>
		</EditorRoot>
	);
}

type PageEditorRichTextInner_ClassNames =
	| "PageEditorRichTextInner"
	| "PageEditorRichTextInner-editor-container"
	| "PageEditorRichTextInner-editor-wrapper"
	| "PageEditorRichTextInner-editor-content"
	| "PageEditorRichTextInner-toolbar"
	| "PageEditorRichTextInner-threads-container"
	| "PageEditorRichTextInner-status-badge"
	| "PageEditorRichTextInner-word-count-badge"
	| "PageEditorRichTextInner-word-count-badge-hidden";

type PageEditorRichTextInner_Props = {
	className?: string;
	initialContent?: TiptapJSONContent;
	pageId: string;
	headerSlot?: React.ReactNode;
};

function PageEditorRichTextInner(props: PageEditorRichTextInner_Props) {
	const { className, initialContent, pageId, headerSlot } = props;

	const [editor, setEditor] = useState<Editor | null>(null);

	const storeSnapshotController = useStoreSnapshot(editor, pageId);

	const [openAi, setOpenAi] = useState(false);
	const [openNode, setOpenNode] = useState(false);
	const [openColor, setOpenColor] = useState(false);
	const [openLink, setOpenLink] = useState(false);

	const [charsCount, setCharsCount] = useState<number>(0);
	const [contentLoaded, setContentLoaded] = useState(false);

	const saveOnDbDebounce = useRef<ReturnType<typeof setTimeout>>(null);

	const updateAndBroadcastMarkdown = useMutation(app_convex_api.ai_docs_temp.update_page_and_broadcast_markdown);
	const convex = useConvex();

	const liveblocks = useLiveblocksExtension({
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

	/**
	 * Allow to pre-load the content from Convex
	 * and set it once the editor is ready
	 */
	const pageContentWatchableQuery = useWatchableValue<{
		value: FunctionReturnType<typeof app_convex_api.ai_docs_temp.get_page_text_content_by_page_id>;
		unsubscribe: () => void;
	}>();

	useEffect(() => {
		const watcher = convex.watchQuery(app_convex_api.ai_docs_temp.get_page_text_content_by_page_id, {
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId: pageId,
		});

		let subscribed = true;

		const doSafeUnsubscribe = () => {
			if (subscribed) {
				unsubscribe();
				subscribed = false;
			}
		};

		const unsubscribe = watcher.onUpdate(() => {
			pageContentWatchableQuery.setValue({
				value: watcher.localQueryResult() ?? null,
				unsubscribe: () => doSafeUnsubscribe(),
			});
		});

		return () => {
			doSafeUnsubscribe();
		};
	}, []);

	// Set content from Convex when editor is ready
	useEffect(() => {
		if (!editor || !isEditorReady || contentLoaded || !pageId) {
			return;
		}

		pageContentWatchableQuery.firstValuePromise
			.then(async (watcher) => {
				const query = watcher.getCurrentValue();
				const remoteContent = query.value;

				if (remoteContent) {
					// editor.commands.setContent(remoteContent, { contentType: "markdown", emitUpdate: false });
					storeSnapshotController.updateCurrentSnapshotContent();
				}

				setContentLoaded(true);
				query.unsubscribe();
			})
			.catch(console.error);
	}, [editor, isEditorReady]);

	// Subscribe to page updates broadcast and apply incoming content
	useEffect(() => {
		if (!editor || !isEditorReady || !pageId) return;

		let initialized = false;

		const watcher = convex.watchQuery(app_convex_api.ai_docs_temp.get_page_updates_richtext_broadcast_latest, {
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId: pageId,
		});

		const unsubscribe = watcher.onUpdate(() => {
			const update = watcher.localQueryResult();
			if (!editor || !update) return;

			if (!initialized) {
				initialized = true;
				return;
			}

			editor
				.chain()
				.setContent(update.text_content, { emitUpdate: false })
				.command(({ tr }) => {
					tr.setMeta(ySyncPluginKey, {
						snapshot: {},
						prevSnapshot: {},
					}).setMeta("addToHistory", false);

					return true;
				})
				.run();

			storeSnapshotController.updateCurrentSnapshotContent();
		});

		return () => {
			unsubscribe();
		};
	}, [editor, isEditorReady]);

	useEffect(() => {
		// Set up visibility change listener for snapshot versioning
		const handleVisibilityChange = () => {
			if (document.hidden) {
				// Tab is hidden and we have local changes that are more recent than remote changes
				storeSnapshotController.cancelTimer();
				void storeSnapshotController.sendVersionSnapshot();
			}
		};

		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			storeSnapshotController.cancelTimer();

			// Cleanup save debounce on unmount
			if (saveOnDbDebounce.current) {
				window.clearTimeout(saveOnDbDebounce.current);
			}
		};
	}, []);

	// Detect if the sync status changed
	useEffect(() => {
		if (isEditorReady && editor && oldSyncValue.current !== syncStatus) {
			setSyncChanged(true);
		}
	}, [syncStatus]);

	const handleCreate = ({ editor }: { editor: Editor }) => {
		setEditor(editor);
	};

	const handleUpdate: EditorContentProps["onUpdate"] = ({ editor, transaction }) => {
		setCharsCount(editor.storage.characterCount.words());

		// Detect if this is a Yjs collaboration update
		const isFromYjs = !!transaction.getMeta(ySyncPluginKey);

		if (isFromYjs) {
			// Remote update from other clients - cancel snapshot timer
			storeSnapshotController.cancelTimer();
		} else {
			// Local update from this client - restart snapshot timer and save to DB
			storeSnapshotController.restartTimer();

			// Debounce content save to Convex (100ms)
			if (saveOnDbDebounce.current) {
				clearTimeout(saveOnDbDebounce.current);
			}

			saveOnDbDebounce.current = setTimeout(async () => {
				try {
					const textContent = editor.getMarkdown();
					await updateAndBroadcastMarkdown({
						workspaceId: ai_chat_HARDCODED_ORG_ID,
						projectId: ai_chat_HARDCODED_PROJECT_ID,
						pageId: pageId!,
						textContent: textContent,
					});
				} catch (error) {
					console.error("Failed to save text content:", error);
				}
			}, 100);
		}
	};

	return isEditorReady ? (
		<div className={cn("PageEditorRichTextInner" satisfies PageEditorRichTextInner_ClassNames, className)}>
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
				initialContent={initialContent}
				immediatelyRender={false}
				onCreate={handleCreate}
				onUpdate={handleUpdate}
				slotBefore={
					/* Status Bar */
					<div className={cn("PageEditorRichTextInner-toolbar" satisfies PageEditorRichTextInner_ClassNames)}>
						<PageEditorRichTextToolbar
							charsCount={charsCount}
							syncStatus={syncStatus}
							syncChanged={syncChanged}
							pageId={pageId}
						/>
					</div>
				}
				slotAfter={<ImageResizer />}
			>
				<div className={cn("PageEditorRichTextInner-threads-container" satisfies PageEditorRichTextInner_ClassNames)}>
					<Threads />
				</div>

				<PageEditorRichTextToolsSlashCommand />

				<GenerativeMenuSwitch open={openAi} onOpenChange={setOpenAi}>
					<Separator orientation="vertical" />
					<PageEditorRichTextToolsNodeSelector open={openNode} onOpenChange={setOpenNode} />
					<Separator orientation="vertical" />
					<PageEditorRichTextToolsLinkSetter open={openLink} onOpenChange={setOpenLink} />
					<Separator orientation="vertical" />
					<PageEditorRichTextToolsMathToggle />
					<Separator orientation="vertical" />
					<PageEditorRichTextToolsTextStyles />
					<Separator orientation="vertical" />
					<PageEditorRichTextToolsColorSelector open={openColor} onOpenChange={setOpenColor} />
					<Separator orientation="vertical" />
					<PageEditorRichTextToolsAddCommentButton />
				</GenerativeMenuSwitch>
			</EditorContent>
		</div>
	) : (
		<PageEditorSkeleton />
	);
}

type PageEditorRichTextToolbar_ClassNames =
	| "PageEditorRichTextToolbar"
	| "PageEditorRichTextToolbar-scrollable-area"
	| "PageEditorRichTextToolbar-status-badge"
	| "PageEditorRichTextToolbar-word-count-badge"
	| "PageEditorRichTextToolbar-word-count-badge-hidden";

type PageEditorRichTextToolbar_Props = {
	charsCount: number;
	syncStatus: SyncStatus;
	syncChanged: boolean;
	pageId: string;
};

function PageEditorRichTextToolbar(props: PageEditorRichTextToolbar_Props) {
	const { charsCount, syncStatus, syncChanged, pageId } = props;

	const { editor } = useEditor();

	const [openNode, setOpenNode] = useState(false);
	const [openColor, setOpenColor] = useState(false);
	const [openLink, setOpenLink] = useState(false);

	return (
		<Toolbar editor={editor} className={cn("PageEditorRichTextToolbar" satisfies PageEditorRichTextToolbar_ClassNames)}>
			<div className={cn("PageEditorRichTextToolbar-scrollable-area" satisfies PageEditorRichTextToolbar_ClassNames)}>
				<PageEditorRichTextToolsHistoryButtons />
				<Separator orientation="vertical" />
				<PageEditorRichTextToolsNodeSelector open={openNode} onOpenChange={setOpenNode} />
				<Separator orientation="vertical" />
				<PageEditorRichTextToolsLinkSetter open={openLink} onOpenChange={setOpenLink} />
				<Separator orientation="vertical" />
				<PageEditorRichTextToolsMathToggle />
				<Separator orientation="vertical" />
				<PageEditorRichTextToolsTextStyles />
				<Separator orientation="vertical" />
				<PageEditorRichTextToolsColorSelector open={openColor} onOpenChange={setOpenColor} />
				<Separator orientation="vertical" />
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
		</Toolbar>
	);
}
