import "./page-editor-rich-text.css";
import { useState, useEffect, useRef } from "react";
import { EditorContent, EditorRoot, useEditor, type EditorContentProps } from "novel";
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
import { cn, create_promise_with_resolvers, make } from "../../../lib/utils.ts";
import { PageEditorRichTextToolsHistoryButtons } from "./page-editor-rich-text-tools-history-buttons.tsx";
import { app_fetch_ai_docs_contextual_prompt } from "../../../lib/fetch.ts";
import { useMutation, useConvex } from "convex/react";
import { ySyncPluginKey } from "y-prosemirror";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../../lib/ai-chat.ts";
import { MyBadge } from "../../my-badge.tsx";
import { PageEditorSkeleton } from "../page-editor-skeleton.tsx";
import { app_convex_api } from "../../../lib/app-convex-client.ts";
import { app_fetch_create_version_snapshot } from "../../../lib/fetch.ts";

/**
 * 2 seconds.
 */
const SNAPSHOT_DEBOUNCE_DURATION = 2000; // 2 seconds

type SyncStatus = ReturnType<typeof useSyncStatus>;

function useStoreSnapshot(editor: Editor | null, pageId: string) {
	const snapshotTimer = useRef<ReturnType<typeof setTimeout>>(null);

	const sendVersionSnapshot = async () => {
		if (!editor) return;

		const markdownContent = editor.storage.markdown.serializer.serialize(editor.state.doc) as string;

		const result = await app_fetch_create_version_snapshot({
			input: {
				workspace_id: ai_chat_HARDCODED_ORG_ID,
				project_id: ai_chat_HARDCODED_PROJECT_ID,
				page_id: pageId,
				content: markdownContent,
			},
			keepalive: true,
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
	const [openAi, setOpenAi] = useState(false);
	const [openNode, setOpenNode] = useState(false);
	const [openColor, setOpenColor] = useState(false);
	const [openLink, setOpenLink] = useState(false);
	const [editor, setEditor] = useState<Editor | null>(null);

	const [charsCount, setCharsCount] = useState<number>(0);
	const [contentLoaded, setContentLoaded] = useState(false);

	const saveOnDbDebounce = useRef<ReturnType<typeof setTimeout>>(null);

	const updateAndBroadcastMarkdown = useMutation(app_convex_api.ai_docs_temp.update_page_and_broadcast_markdown);
	const convex = useConvex();

	const storeSnapshotController = useStoreSnapshot(editor, pageId);

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

	const extensions = [...defaultExtensions, (PageEditorRichTextToolsSlashCommand as any).slashCommand, liveblocks];

	const syncStatus = useSyncStatus({ smooth: true });
	const oldSyncValue = useRef(syncStatus);
	const [syncChanged, setSyncChanged] = useState(false);
	const isEditorReady = useIsEditorReady();

	/**
	 * Allow to pre-load the content from Convex
	 * and set it once the editor is ready
	 */
	const pageContentQueryWatch = useRef<
		PromiseWithResolvers<{
			valueGetterPromise: Promise<() => string | null>;
			unsubscribe: () => void;
		}>
	>(null);
	if (pageContentQueryWatch.current === null) {
		pageContentQueryWatch.current = create_promise_with_resolvers<{
			valueGetterPromise: Promise<() => string | null>;
			unsubscribe: () => void;
		}>();
	}

	/**
	 * Prevent feedback loops when applying remote broadcasts
	 */
	const isApplyingBroadcastRef = useRef(false);

	useEffect(() => {
		if (!pageContentQueryWatch.current) return;

		let currentValue: string | null | undefined = undefined;
		let valueGetterSet = false;
		const valueGetterDeferred = create_promise_with_resolvers<() => string | null>();

		const watcher = convex.watchQuery(app_convex_api.ai_docs_temp.get_page_text_content_by_page_id, {
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId: pageId,
		});

		const unsubscribe = watcher.onUpdate(() => {
			currentValue = watcher.localQueryResult();
			if (!valueGetterSet) {
				valueGetterDeferred.resolve(() => currentValue ?? null);
				valueGetterSet = true;
			}
		});

		pageContentQueryWatch.current.resolve({
			valueGetterPromise: valueGetterDeferred.promise,
			unsubscribe: () => {
				unsubscribe();
				pageContentQueryWatch.current = null;
			},
		});

		return () => {
			pageContentQueryWatch.current?.promise.then((watch) => watch.unsubscribe()).catch(console.error);
		};
	}, []);

	// Set content from Convex when editor is ready
	useEffect(() => {
		if (!editor || !isEditorReady || contentLoaded || !pageId || !pageContentQueryWatch.current) {
			return;
		}

		pageContentQueryWatch.current.promise
			.then(async (watch) => {
				const remoteContent = await watch.valueGetterPromise.then((valueGetter) => valueGetter());

				if (remoteContent) {
					editor.commands.setContent(remoteContent, false);
				}

				setContentLoaded(true);

				watch.unsubscribe();
			})
			.catch(console.error);
	}, [editor, isEditorReady]);

	// Subscribe to page updates broadcast and apply incoming content
	useEffect(() => {
		if (!editor || !isEditorReady || contentLoaded || !pageId) return;

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

			// Apply update without triggering our own save; guard using ref
			isApplyingBroadcastRef.current = true;
			editor.commands.setContent(update.text_content, false);
			queueMicrotask(() => {
				isApplyingBroadcastRef.current = false;
			});
		});

		return () => {
			unsubscribe();
		};
	}, [editor, isEditorReady, contentLoaded]);

	// Set up document update listeners for snapshot versioning
	useEffect(() => {
		if (!editor) return;

		const handleUpdate = (update: any, origin: any) => {
			if (origin === "local") {
				storeSnapshotController.restartTimer();
			} else {
				storeSnapshotController.cancelTimer();
			}
		};

		const handleVisibilityChange = () => {
			if (document.hidden) {
				// Tab is hidden and we have local changes that are more recent than remote changes
				storeSnapshotController.cancelTimer();
				void storeSnapshotController.sendVersionSnapshot();
			}
		};

		const doc = editor.storage.collaboration?.doc;

		// Listen to Yjs document updates through the editor
		doc?.on("update", handleUpdate);
		document.addEventListener("visibilitychange", handleVisibilityChange);

		return () => {
			doc?.off("update", handleUpdate);
			document.removeEventListener("visibilitychange", handleVisibilityChange);

			storeSnapshotController.cancelTimer();
		};
	}, [editor, storeSnapshotController]);

	// Cleanup timeout on unmount
	useEffect(() => {
		return () => {
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
		if (isApplyingBroadcastRef.current) {
			return;
		}
		setCharsCount(editor.storage.characterCount.words());

		// Debounce content save to Convex (100ms)
		if (!transaction.getMeta(ySyncPluginKey)) {
			if (saveOnDbDebounce.current) {
				clearTimeout(saveOnDbDebounce.current);
			}

			saveOnDbDebounce.current = setTimeout(async () => {
				try {
					const textContent = editor.storage.markdown.serializer.serialize(editor.state.doc) as string;
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
		<>
			{headerSlot}
			<EditorContent
				className={cn("PageEditorRichTextInner" satisfies PageEditorRichTextInner_ClassNames, className)}
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
		</>
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
				<PageEditorSnapshotsModal pageId={pageId} />
				<NotificationsPopover />
			</div>
		</Toolbar>
	);
}
