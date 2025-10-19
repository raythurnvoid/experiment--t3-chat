import "./page-rich-text-editor.css";
import { useState, useEffect, useRef } from "react";
import {
	EditorCommand,
	EditorCommandEmpty,
	EditorCommandItem,
	EditorCommandList,
	EditorContent,
	EditorRoot,
	useEditor,
	type EditorContentProps,
} from "novel";
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
import { AddCommentSelector } from "./selectors/add-comment-selector.tsx";
import { Separator } from "../../ui/separator.tsx";
import GenerativeMenuSwitch from "./generative/generative-menu-switch.tsx";
import NotificationsPopover from "./notifications-popover.tsx";
import { uploadFn } from "./image-upload.ts";
import { slashCommand, suggestionItems } from "./slash-command.tsx";
import { Threads } from "./threads.tsx";
import VersionsDialog from "./version-history-dialog.tsx";
import { AI_NAME } from "./constants.ts";
import { cn, create_promise_with_resolvers, make } from "../../../lib/utils.ts";
import { HistoryButtons } from "./selectors/history-buttons.tsx";
import { app_fetch_ai_docs_contextual_prompt } from "../../../lib/fetch.ts";
import { useMutation, useConvex } from "convex/react";
import { ySyncPluginKey } from "y-prosemirror";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../../lib/ai-chat.ts";
import { MyBadge } from "../../my-badge.tsx";
import { PageEditorSkeleton } from "../page-editor-skeleton.tsx";
import { app_convex_api } from "../../../lib/app-convex-client.ts";

type SyncStatus = ReturnType<typeof useSyncStatus>;

const INITIAL_CONTENT = make<TiptapJSONContent>({
	text:
		"<h1>Welcome</h1>\n" + //
		"<p>You can start editing your document here.</p>",
});

export type PageRichTextEditor_ClassNames = "PageRichTextEditor";

export type PageRichTextEditor_Props = React.ComponentProps<"div"> & {
	pageId: string;
	headerSlot?: React.ReactNode;
};

export function PageRichTextEditor(props: PageRichTextEditor_Props) {
	const { className, pageId, headerSlot, ...rest } = props;

	return (
		<EditorRoot>
			<PageRichTextEditorInner
				className={cn("PageRichTextEditor" satisfies PageRichTextEditor_ClassNames, className)}
				initialContent={INITIAL_CONTENT}
				pageId={pageId}
				headerSlot={headerSlot}
				{...rest}
			/>
		</EditorRoot>
	);
}

type PageRichTextEditorInner_ClassNames =
	| "PageRichTextEditorInner"
	| "PageRichTextEditorInner-editor-container"
	| "PageRichTextEditorInner-editor-content"
	| "PageRichTextEditorInner-toolbar"
	| "PageRichTextEditorInner-threads-container"
	| "PageRichTextEditorInner-editor-command"
	| "PageRichTextEditorInner-editor-command-empty"
	| "PageRichTextEditorInner-editor-command-list"
	| "PageRichTextEditorInner-editor-command-item"
	| "PageRichTextEditorInner-editor-command-item-icon"
	| "PageRichTextEditorInner-editor-command-item-content"
	| "PageRichTextEditorInner-editor-command-item-title"
	| "PageRichTextEditorInner-editor-command-item-description"
	| "PageRichTextEditorInner-status-badge"
	| "PageRichTextEditorInner-word-count-badge"
	| "PageRichTextEditorInner-word-count-badge-hidden";

type PageRichTextEditorInner_Props = {
	className?: string;
	initialContent?: TiptapJSONContent;
	pageId: string;
	headerSlot?: React.ReactNode;
};

function PageRichTextEditorInner(props: PageRichTextEditorInner_Props) {
	const { className, initialContent, pageId, headerSlot } = props;
	const [openAi, setOpenAi] = useState(false);
	const [openNode, setOpenNode] = useState(false);
	const [openColor, setOpenColor] = useState(false);
	const [openLink, setOpenLink] = useState(false);
	const [editor, setEditor] = useState<Editor | null>(null);

	const [charsCount, setCharsCount] = useState<number>(0);
	const [contentLoaded, setContentLoaded] = useState(false);

	const saveOnDbDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);

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

	const extensions = [...defaultExtensions, slashCommand, liveblocks];

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
				className={cn("PageRichTextEditorInner" satisfies PageRichTextEditorInner_ClassNames, className)}
				editorContainerProps={{
					className: cn("PageRichTextEditorInner-editor-container" satisfies PageRichTextEditorInner_ClassNames),
				}}
				editorProps={{
					attributes: {
						class: cn("PageRichTextEditorInner-editor-content" satisfies PageRichTextEditorInner_ClassNames),
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
					<div className={cn("PageRichTextEditorInner-toolbar" satisfies PageRichTextEditorInner_ClassNames)}>
						<PageRichTextEditorToolbar charsCount={charsCount} syncStatus={syncStatus} syncChanged={syncChanged} />
					</div>
				}
				slotAfter={<ImageResizer />}
			>
				<div className={cn("PageRichTextEditorInner-threads-container" satisfies PageRichTextEditorInner_ClassNames)}>
					<Threads />
				</div>

				<EditorCommand
					className={cn("PageRichTextEditorInner-editor-command" satisfies PageRichTextEditorInner_ClassNames)}
				>
					<EditorCommandEmpty
						className={cn("PageRichTextEditorInner-editor-command-empty" satisfies PageRichTextEditorInner_ClassNames)}
					>
						No results
					</EditorCommandEmpty>
					<EditorCommandList
						className={cn("PageRichTextEditorInner-editor-command-list" satisfies PageRichTextEditorInner_ClassNames)}
					>
						{suggestionItems.map((item) => (
							<EditorCommandItem
								value={item.title}
								onCommand={(val) => {
									if (!item?.command) {
										return;
									}

									item.command(val);
								}}
								className={cn(
									"PageRichTextEditorInner-editor-command-item" satisfies PageRichTextEditorInner_ClassNames,
								)}
								key={item.title}
							>
								<div
									className={cn(
										"PageRichTextEditorInner-editor-command-item-icon" satisfies PageRichTextEditorInner_ClassNames,
									)}
								>
									{item.icon}
								</div>
								<div
									className={cn(
										"PageRichTextEditorInner-editor-command-item-content" satisfies PageRichTextEditorInner_ClassNames,
									)}
								>
									<p
										className={cn(
											"PageRichTextEditorInner-editor-command-item-title" satisfies PageRichTextEditorInner_ClassNames,
										)}
									>
										{item.title}
									</p>
									<p
										className={cn(
											"PageRichTextEditorInner-editor-command-item-description" satisfies PageRichTextEditorInner_ClassNames,
										)}
									>
										{item.description}
									</p>
								</div>
							</EditorCommandItem>
						))}
					</EditorCommandList>
				</EditorCommand>

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
					<AddCommentSelector />
				</GenerativeMenuSwitch>
			</EditorContent>
		</>
	) : (
		<PageEditorSkeleton />
	);
}

type PageRichTextEditorToolbar_ClassNames =
	| "PageRichTextEditorToolbar"
	| "PageRichTextEditorToolbar-scrollable-area"
	| "PageRichTextEditorToolbar-status-badge"
	| "PageRichTextEditorToolbar-word-count-badge"
	| "PageRichTextEditorToolbar-word-count-badge-hidden";

type PageRichTextEditorToolbar_Props = {
	charsCount: number;
	syncStatus: SyncStatus;
	syncChanged: boolean;
};

function PageRichTextEditorToolbar(props: PageRichTextEditorToolbar_Props) {
	const { charsCount, syncStatus, syncChanged } = props;

	const { editor } = useEditor();

	const [openNode, setOpenNode] = useState(false);
	const [openColor, setOpenColor] = useState(false);
	const [openLink, setOpenLink] = useState(false);

	return (
		<Toolbar editor={editor} className={cn("PageRichTextEditorToolbar" satisfies PageRichTextEditorToolbar_ClassNames)}>
			<div className={cn("PageRichTextEditorToolbar-scrollable-area" satisfies PageRichTextEditorToolbar_ClassNames)}>
				<HistoryButtons />
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
					className={cn("PageRichTextEditorToolbar-status-badge" satisfies PageRichTextEditorToolbar_ClassNames)}
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
							? ("PageRichTextEditorToolbar-word-count-badge" satisfies PageRichTextEditorToolbar_ClassNames)
							: ("PageRichTextEditorToolbar-word-count-badge-hidden" satisfies PageRichTextEditorToolbar_ClassNames),
					)}
				>
					{charsCount} Words
				</MyBadge>
				<VersionsDialog />
				<NotificationsPopover />
			</div>
		</Toolbar>
	);
}
