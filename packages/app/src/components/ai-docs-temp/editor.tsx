import { useState, useEffect } from "react";
import {
	EditorCommand,
	EditorCommandEmpty,
	EditorCommandItem,
	EditorCommandList,
	EditorContent,
	EditorRoot,
	useEditor,
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

// Get Convex URL for HTTP endpoints
const CONVEX_URL = import.meta.env.VITE_CONVEX_URL || "https://your-convex-deployment.convex.site";

interface RichTextDocEditor_Props {
	initialContent?: string;
}

// Outer component - React 19: ref is now available as a prop, no need for forwardRef
export function RichTextDocEditor(props: RichTextDocEditor_Props) {
	return (
		<div className={cn("TiptapEditor", "h-full w-full")}>
			{/* Novel Editor */}
			<EditorRoot>
				<TiptapEditorContent initialContent={props.initialContent} />
			</EditorRoot>
		</div>
	);
}

interface TiptapEditorContent_Props {
	initialContent?: string;
}

// Inner component - lives inside EditorRoot, can safely use useEditor hook
function TiptapEditorContent(props: TiptapEditorContent_Props) {
	const [openAi, setOpenAi] = useState(false);
	const [openNode, setOpenNode] = useState(false);
	const [openColor, setOpenColor] = useState(false);
	const [openLink, setOpenLink] = useState(false);
	const [editor, setEditor] = useState<Editor | null>(null);

	const [charsCount, setCharsCount] = useState<number>(0);

	const liveblocks = useLiveblocksExtension({
		comments: true,
		ai: {
			name: AI_NAME,
			resolveContextualPrompt: async ({ prompt, context, previous, signal }: any) => {
				const response = await fetch(`${CONVEX_URL}/api/ai-docs-temp/contextual-prompt`, {
					method: "POST",
					body: JSON.stringify({ prompt, context, previous }),
					signal,
				});

				return response.json();
			},
		},
	});

	const extensions = [...defaultExtensions, slashCommand, liveblocks];

	const syncStatus = useSyncStatus({ smooth: true });
	const isEditorReady = useIsEditorReady();

	// Set initial content when editor is connected to the liveblocks room
	useEffect(() => {
		if (editor && isEditorReady && props.initialContent) {
			console.log("Setting initial content:", props.initialContent);
			editor.commands.setContent(props.initialContent);
		}
	}, [editor, isEditorReady, props.initialContent]);

	const handleCreate = ({ editor }: { editor: Editor }) => {
		setEditor(editor);
	};

	const handleUpdate = ({ editor }: { editor: Editor }) => {
		setCharsCount(editor.storage.characterCount.words());
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
						<EditorToolbar charsCount={charsCount} syncStatus={syncStatus} />
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
	syncStatus: string;
};

function EditorToolbar({ charsCount, syncStatus }: EditorToolbar_Props) {
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
				{syncStatus === "synchronizing" ? "Unsaved" : "Saved"}
			</div>
			<div className={charsCount ? "rounded-lg bg-accent px-2 py-1 text-sm text-muted-foreground" : "hidden"}>
				{charsCount} Words
			</div>
			<VersionsDialog />
			<NotificationsPopover />
		</Toolbar>
	);
}
