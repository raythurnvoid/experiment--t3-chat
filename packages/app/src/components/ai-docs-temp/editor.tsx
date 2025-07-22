import { useState } from "react";
import {
	EditorCommand,
	EditorCommandEmpty,
	EditorCommandItem,
	EditorCommandList,
	EditorContent,
	EditorRoot,
	useEditor,
} from "novel";
import { ImageResizer, handleCommandNavigation, handleImageDrop, handleImagePaste } from "novel";
import { Toolbar, useLiveblocksExtension } from "@liveblocks/react-tiptap";
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

export default function TiptapEditor() {
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

	const [open_ai, set_open_ai] = useState(false);
	const [open_node, set_open_node] = useState(false);
	const [open_color, set_open_color] = useState(false);
	const [open_link, set_open_link] = useState(false);

	const extensions = [...defaultExtensions, slashCommand, liveblocks];
	const [chars_count, set_chars_count] = useState<number>(0);

	const sync_status = useSyncStatus({ smooth: true });

	return (
		<div className={cn("TiptapEditor", "h-full w-full")}>
			{/* Novel Editor */}
			<EditorRoot>
				<EditorContent
					extensions={extensions}
					className="h-full w-full"
					onUpdate={({ editor }) => set_chars_count(editor.storage.characterCount.words())}
					editorContainerProps={{
						className: "h-full w-full ",
					}}
					editorProps={{
						handleDOMEvents: {
							keydown: (_view, event) => handleCommandNavigation(event),
						},
						handlePaste: (view, event) => handleImagePaste(view, event, uploadFn),
						handleDrop: (view, event, _slice, moved) => handleImageDrop(view, event, moved, uploadFn),
						attributes: {
							class:
								"prose dark:prose-invert prose-headings:font-title font-default px-16 py-4 h-full focus:outline-none",
						},
					}}
					slotBefore={
						/* Status Bar */
						<div className="flex gap-2 px-8 pt-8 pb-2 outline-none">
							<EditorToolbar charsCount={chars_count} syncStatus={sync_status} />
						</div>
					}
					slotAfter={<ImageResizer />}
					immediatelyRender={false}
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

					<GenerativeMenuSwitch open={open_ai} onOpenChange={set_open_ai}>
						<Separator orientation="vertical" />
						<NodeSelector open={open_node} onOpenChange={set_open_node} />
						<Separator orientation="vertical" />
						<LinkSelector open={open_link} onOpenChange={set_open_link} />
						<Separator orientation="vertical" />
						<MathSelector />
						<Separator orientation="vertical" />
						<TextButtons />
						<Separator orientation="vertical" />
						<ColorSelector open={open_color} onOpenChange={set_open_color} />
						<Separator orientation="vertical" />
						<AddCommentSelector />
					</GenerativeMenuSwitch>
				</EditorContent>
			</EditorRoot>
		</div>
	);
}

type EditorToolbar_Props = {
	charsCount: number;
	syncStatus: string;
};

function EditorToolbar({ charsCount, syncStatus }: EditorToolbar_Props) {
	const { editor } = useEditor();

	const [open_node, set_open_node] = useState(false);
	const [open_color, set_open_color] = useState(false);
	const [open_link, set_open_link] = useState(false);

	return (
		<Toolbar editor={editor} className="w-full">
			<HistoryButtons />
			<Separator orientation="vertical" />
			<NodeSelector open={open_node} onOpenChange={set_open_node} />
			<Separator orientation="vertical" />
			<LinkSelector open={open_link} onOpenChange={set_open_link} />
			<Separator orientation="vertical" />
			<MathSelector />
			<Separator orientation="vertical" />
			<TextButtons />
			<Separator orientation="vertical" />
			<ColorSelector open={open_color} onOpenChange={set_open_color} />
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
