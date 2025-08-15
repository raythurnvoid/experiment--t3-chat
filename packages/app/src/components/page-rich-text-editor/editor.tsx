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
import { cn } from "../../lib/utils.ts";
import { HistoryButtons } from "./selectors/history-buttons.tsx";
import { app_fetch_ai_docs_contextual_prompt } from "../../lib/fetch.ts";
import { useMutation, useConvex } from "convex/react";
import { api } from "../../../convex/_generated/api.js";
import { ySyncPluginKey } from "y-prosemirror";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../lib/ai-chat.ts";

interface RichTextDocEditor_Props {
	doc_id: string;
}

export function RichTextDocEditor(props: RichTextDocEditor_Props) {
	return (
		<div className={cn("TiptapEditor", "h-full w-full")}>
			<EditorRoot>
				<TiptapEditorContent initialContent={initialContent} doc_id={props.doc_id} />
			</EditorRoot>
		</div>
	);
}

interface TiptapEditorContent_Props {
	initialContent?: string;
	doc_id: string;
}

function TiptapEditorContent(props: TiptapEditorContent_Props) {
	const [openAi, setOpenAi] = useState(false);
	const [openNode, setOpenNode] = useState(false);
	const [openColor, setOpenColor] = useState(false);
	const [openLink, setOpenLink] = useState(false);
	const [editor, setEditor] = useState<Editor | null>(null);

	const [charsCount, setCharsCount] = useState<number>(0);
	const [contentLoaded, setContentLoaded] = useState(false);

	const saveOnDbDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);

	const updateTextContent = useMutation(api.ai_docs_temp.update_page_text_content);
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

				if (result.ok) {
					return result.ok.payload;
				} else {
					throw new Error(`Failed to resolve contextual prompt: ${result.bad.message}`);
				}
			},
		},
	});

	const extensions = [...defaultExtensions, slashCommand, liveblocks];

	const syncStatus = useSyncStatus({ smooth: true });
	const oldSyncValue = useRef(syncStatus);
	const [syncChanged, setSyncChanged] = useState(false);
	const isEditorReady = useIsEditorReady();

	const pageTextContentQueryWatch = useRef<{
		value: string | null | undefined;
		unsubscribe: () => void;
	} | null>(null);

	useEffect(() => {
		const watcher = convex.watchQuery(api.ai_docs_temp.get_page_text_content_by_page_id, {
			workspace_id: ai_chat_HARDCODED_ORG_ID,
			project_id: ai_chat_HARDCODED_PROJECT_ID,
			page_id: props.doc_id,
		});

		const unsubscribe = watcher.onUpdate(() => {
			if (pageTextContentQueryWatch.current) {
				pageTextContentQueryWatch.current.value = watcher.localQueryResult();
			}
		});

		pageTextContentQueryWatch.current = {
			value: watcher.localQueryResult(),
			unsubscribe: () => {
				unsubscribe();
				pageTextContentQueryWatch.current = null;
			},
		};

		return () => {
			pageTextContentQueryWatch.current?.unsubscribe();
		};
	}, [props.doc_id]);

	// Set content from Convex when editor is ready
	useEffect(() => {
		if (!editor || !isEditorReady || contentLoaded || !props.doc_id) {
			return;
		}

		// Apply content once when editor becomes ready
		const applyContent = () => {
			if (!editor || !isEditorReady) return;

			const ydoc = editor.storage.liveblocksExtension.doc;
			const hasContentSet = ydoc.getMap("liveblocks_config").get("hasContentSet");

			if (!hasContentSet) {
				ydoc.getMap("liveblocks_config").set("hasContentSet", true);

				if (props.initialContent) {
					console.log("Setting fallback initial content:", props.initialContent);
					editor.commands.setContent(props.initialContent);
				}
			} else if (pageTextContentQueryWatch.current?.value) {
				const content = pageTextContentQueryWatch.current.value;
				console.log("Setting content from Convex:", content);
				editor.commands.setContent(content, false);
			}

			pageTextContentQueryWatch.current?.unsubscribe();
			setContentLoaded(true);
		};

		// Try to apply content immediately if we already have it
		applyContent();
	}, [editor, isEditorReady, props.doc_id, props.initialContent, contentLoaded, convex, pageTextContentQueryWatch]);

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
		setCharsCount(editor.storage.characterCount.words());

		// Debounce content save to Convex (100ms)
		if (!transaction.getMeta(ySyncPluginKey)) {
			console.log("handleUpdate");
			if (saveOnDbDebounce.current) {
				clearTimeout(saveOnDbDebounce.current);
			}

			saveOnDbDebounce.current = setTimeout(async () => {
				try {
					const textContent = editor.storage.markdown.serializer.serialize(editor.state.doc) as string;
					await updateTextContent({
						workspace_id: ai_chat_HARDCODED_ORG_ID,
						project_id: ai_chat_HARDCODED_PROJECT_ID,
						page_id: props.doc_id!,
						text_content: textContent,
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
				className="h-full w-full"
				editorContainerProps={{
					className: "h-full w-full ",
				}}
				editorProps={{
					attributes: {
						class:
							"prose dark:prose-invert prose-headings:font-title font-default px-16 py-4 h-full focus:outline-none",
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
				{"" + syncChanged}{" "}
			</div>
			<div className={charsCount ? "rounded-lg bg-accent px-2 py-1 text-sm text-muted-foreground" : "hidden"}>
				{charsCount} Words
			</div>
			<VersionsDialog />
			<NotificationsPopover />
		</Toolbar>
	);
}

type SyncStatus = ReturnType<typeof useSyncStatus>;

const initialContent = `
<h1>Welcome</h1>
<p>You can start editing your document here.</p>
`;
