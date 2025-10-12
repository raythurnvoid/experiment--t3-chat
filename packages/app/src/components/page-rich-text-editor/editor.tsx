import "./editor.css";

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
import { Editor } from "@tiptap/react";
import { ImageResizer, handleCommandNavigation, handleImageDrop, handleImagePaste } from "novel";
import { Toolbar, useLiveblocksExtension, useIsEditorReady } from "@liveblocks/react-tiptap";
import { useSyncStatus } from "@liveblocks/react/suspense";
import { defaultExtensions } from "./extensions.ts";
import { ColorSelector } from "./selectors/color-selector.tsx";
import { LinkSelector } from "./selectors/link-selector.tsx";
import { NodeSelector } from "./selectors/node-selector.tsx";
import { MathSelector } from "./selectors/math-selector.tsx";
import { TextButtons } from "./selectors/text-buttons.tsx";
import { AddCommentSelector } from "./selectors/add-comment-selector.tsx";
import { Separator } from "../ui/separator.tsx";
import GenerativeMenuSwitch from "./generative/generative-menu-switch.tsx";
import NotificationsPopover from "./notifications-popover.tsx";
import { uploadFn } from "./image-upload.ts";
import { slashCommand, suggestionItems } from "./slash-command.tsx";
import { Threads } from "./threads.tsx";
import VersionsDialog from "./version-history-dialog.tsx";
import { AI_NAME } from "./constants.ts";
import { cn, create_promise_with_resolvers } from "../../lib/utils.ts";
import { HistoryButtons } from "./selectors/history-buttons.tsx";
import { app_fetch_ai_docs_contextual_prompt } from "../../lib/fetch.ts";
import { useMutation, useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ySyncPluginKey } from "y-prosemirror";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";

type SyncStatus = ReturnType<typeof useSyncStatus>;

const INITIAL_CONTENT = `
<h1>Welcome</h1>
<p>You can start editing your document here.</p>
`;

export type PageRichTextEditorBody_ClassNames = "PageRichTextEditorBody";

export type PageRichTextEditorBody_Props = React.ComponentProps<"div"> & {
	pageId: string;
};

export function PageRichTextEditorBody(props: PageRichTextEditorBody_Props) {
	const { className, pageId, ...rest } = props;
	return (
		<div className={cn("PageRichTextEditorBody" satisfies PageRichTextEditorBody_ClassNames, className)} {...rest}>
			<EditorRoot>
				<PageRichTextEditorBodyContent initialContent={INITIAL_CONTENT} pageId={pageId} />
			</EditorRoot>
		</div>
	);
}

export type PageRichTextEditorBodyContent_ClassNames =
	| "PageRichTextEditorBodyContent"
	| "PageRichTextEditorBodyContent-editor-container"
	| "PageRichTextEditorBodyContent-editor-content";

export type PageRichTextEditorBodyContent_Props = React.ComponentProps<"div"> & {
	initialContent?: string;
	pageId: string;
};

function PageRichTextEditorBodyContent(props: PageRichTextEditorBodyContent_Props) {
	const { initialContent, pageId } = props;
	const [openAi, setOpenAi] = useState(false);
	const [openNode, setOpenNode] = useState(false);
	const [openColor, setOpenColor] = useState(false);
	const [openLink, setOpenLink] = useState(false);
	const [editor, setEditor] = useState<Editor | null>(null);

	const [charsCount, setCharsCount] = useState<number>(0);
	const [contentLoaded, setContentLoaded] = useState(false);

	const saveOnDbDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);

	const updateAndBroadcastMarkdown = useMutation(api.ai_docs_temp.update_page_and_broadcast_markdown);
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

		const watcher = convex.watchQuery(api.ai_docs_temp.get_page_text_content_by_page_id, {
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

		const watcher = convex.watchQuery(api.ai_docs_temp.get_page_updates_richtext_broadcast_latest, {
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

	return (
		isEditorReady && (
			<EditorContent
				className={cn("PageRichTextEditorBodyContent" satisfies PageRichTextEditorBodyContent_ClassNames)}
				editorContainerProps={{
					className: cn(
						"PageRichTextEditorBodyContent-editor-container" satisfies PageRichTextEditorBodyContent_ClassNames,
					),
				}}
				editorProps={{
					attributes: {
						class: cn(
							"PageRichTextEditorBodyContent-editor-content" satisfies PageRichTextEditorBodyContent_ClassNames,
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
				slotBefore={
					/* Status Bar */
					<div className="flex gap-2 px-8 pt-8 pb-2 outline-none">
						<EditorToolbar charsCount={charsCount} syncStatus={syncStatus} syncChanged={syncChanged} />
					</div>
				}
				slotAfter={<ImageResizer />}
			>
				<div className="absolute right-0 mr-4">
					<Threads />
				</div>

				<EditorCommand className="z-50 h-auto max-h-[330px] overflow-y-auto rounded-md border border-muted bg-background px-1 py-2 shadow-md transition-all">
					<EditorCommandEmpty className="px-2 text-muted-foreground">No results</EditorCommandEmpty>
					<EditorCommandList>
						{suggestionItems.map((item) => (
							<EditorCommandItem
								value={item.title}
								onCommand={(val) => {
									if (!item?.command) {
										return;
									}

									item.command(val);
								}}
								className="flex w-full items-center space-x-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent aria-selected:bg-accent"
								key={item.title}
							>
								<div className="flex h-10 w-10 items-center justify-center rounded-md border border-muted bg-background">
									{item.icon}
								</div>
								<div>
									<p className="font-medium">{item.title}</p>
									<p className="text-xs text-muted-foreground">{item.description}</p>
								</div>
							</EditorCommandItem>
						))}
					</EditorCommandList>
				</EditorCommand>

				<GenerativeMenuSwitch open={openAi} onOpenChange={setOpenAi}>
					<Separator orientation="vertical" />
					<NodeSelector open={openNode} onOpenChange={setOpenNode} />
					<Separator orientation="vertical" />
					<LinkSelector open={openLink} onOpenChange={setOpenLink} />
					<Separator orientation="vertical" />
					<MathSelector />
					<Separator orientation="vertical" />
					<TextButtons />
					<Separator orientation="vertical" />
					<ColorSelector open={openColor} onOpenChange={setOpenColor} />
					<Separator orientation="vertical" />
					<AddCommentSelector />
				</GenerativeMenuSwitch>
			</EditorContent>
		)
	);
}

type EditorToolbar_Props = {
	charsCount: number;
	syncStatus: SyncStatus;
	syncChanged: boolean;
};

function EditorToolbar(props: EditorToolbar_Props) {
	const { charsCount, syncStatus, syncChanged } = props;

	const { editor } = useEditor();

	const [openNode, setOpenNode] = useState(false);
	const [openColor, setOpenColor] = useState(false);
	const [openLink, setOpenLink] = useState(false);

	return (
		<Toolbar editor={editor} className="w-full">
			<HistoryButtons />
			<Separator orientation="vertical" />
			<NodeSelector open={openNode} onOpenChange={setOpenNode} />
			<Separator orientation="vertical" />
			<LinkSelector open={openLink} onOpenChange={setOpenLink} />
			<Separator orientation="vertical" />
			<MathSelector />
			<Separator orientation="vertical" />
			<TextButtons />
			<Separator orientation="vertical" />
			<ColorSelector open={openColor} onOpenChange={setOpenColor} />
			<Separator orientation="vertical" />
			<div className="rounded-lg bg-accent px-2 py-1 text-sm text-muted-foreground">
				{/*
				If syncChanged it's false then force to show "Saved" because when the
				editor is mounted the liveblocks syncStatus is stuck to "synchronizing"
				*/}
				{syncStatus === "synchronizing" && syncChanged ? "Unsaved" : "Saved"}
			</div>
			<div className={charsCount ? "rounded-lg bg-accent px-2 py-1 text-sm text-muted-foreground" : "hidden"}>
				{charsCount} Words
			</div>
			<VersionsDialog />
			<NotificationsPopover />
		</Toolbar>
	);
}
