"use client";

import NotificationsPopover from "./notifications-popover";
import { useEditor, EditorContent, Editor, type EditorEvents } from "@tiptap/react";
import {
	useLiveblocksExtension,
	FloatingComposer,
	FloatingThreads,
	AnchoredThreads,
	AiToolbar,
	FloatingToolbar,
	Toolbar,
} from "@liveblocks/react-tiptap";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import StarterKit from "@tiptap/starter-kit";
import CharacterCount from "@tiptap/extension-character-count";
import Link from "@tiptap/extension-link";
import Highlight from "@tiptap/extension-highlight";
import TextAlign from "@tiptap/extension-text-align";
import TextStyle from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Typography from "@tiptap/extension-typography";
import Underline from "@tiptap/extension-underline";
import { useThreads } from "@liveblocks/react";
import { useIsMobile } from "./use-is-mobile";
import VersionsDialog from "./version-history-dialog";
import { AiPlaceholder } from "./ai-placeholder";
import { AI_NAME } from "./constants";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";

export default function TiptapEditor() {
	const [word_count, set_word_count] = useState<number>(0);
	const [is_saved, set_is_saved] = useState(true);

	const liveblocks = useLiveblocksExtension({
		ai: {
			name: AI_NAME,
			// resolveContextualPrompt: async ({
			//   prompt,
			//   context,
			//   previous,
			//   signal,
			// }) => {
			//   const response = await fetch("/api/contextual-prompt", {
			//     method: "POST",
			//     body: JSON.stringify({ prompt, context, previous }),
			//     signal,
			//   });

			//   return response.json();
			// },
		},
	});

	const editor = useEditor({
		editorProps: {
			attributes: {
				// Add styles to editor element
				class:
					"TiptapEditor-content prose dark:prose-invert prose-headings:font-title font-default focus:outline-none max-w-full min-h-[400px] p-6 text-foreground bg-background",
			},
		},
		enableContentCheck: true,
		extensions: [
			liveblocks,
			StarterKit.configure({
				history: false,
			}),
			CharacterCount,
			Link.configure({
				openOnClick: false,
				HTMLAttributes: {
					class: "TiptapEditor-link text-blue-600 underline cursor-pointer",
				},
			}),
			Highlight.configure({
				HTMLAttributes: {
					class: "TiptapEditor-highlight bg-yellow-200 dark:bg-yellow-800",
				},
			}),
			TextAlign.configure({
				types: ["heading", "paragraph"],
			}),
			TextStyle,
			Color,
			Typography,
			Underline,
			AiPlaceholder,
		],
		onCreate: ({ editor }) => {
			try {
				// Use CharacterCount extension for word counting
				const words = editor.storage.characterCount?.words() || 0;
				console.log("Word count created:", words);
				set_word_count(words);
			} catch (error) {
				console.error("Error in onCreate:", error);
				set_word_count(0);
			}
		},
		onUpdate: ({ editor }) => {
			try {
				// Use CharacterCount extension for word counting
				const words = editor.storage.characterCount?.words() || 0;
				console.log("Word count update:", words);
				set_word_count(words);
				set_is_saved(false);

				// Simulate saving after a delay
				setTimeout(() => {
					set_is_saved(true);
				}, 1000);
			} catch (error) {
				console.error("Error in onUpdate:", error);
			}
		},
	});

	useEffect(() => {
		const onContentError = (event: EditorEvents["contentError"]) => {
			console.warn(event);
		};

		editor?.on("contentError", onContentError);

		return () => {
			editor?.off("contentError", onContentError);
		};
	}, [editor]);

	return (
		<div className={cn("TiptapEditor", "relative w-full max-w-screen-lg")}>
			{/* Status Bar */}
			<div className={cn("TiptapEditor-status-bar", "absolute right-5 top-5 z-10 mb-5 flex gap-2")}>
				<div className={cn("TiptapEditor-save-status", "bg-accent text-muted-foreground rounded-lg px-2 py-1 text-sm")}>
					{is_saved ? "Saved" : "Unsaved"}
				</div>
				<div className={cn("TiptapEditor-word-count", "bg-accent text-muted-foreground rounded-lg px-2 py-1 text-sm")}>
					{word_count} Words
				</div>
			</div>

			{/* Header with Version History */}
			<div
				className={cn(
					"TiptapEditor-header",
					"border-border/80 bg-background flex h-[60px] items-center justify-end border-b px-4",
				)}
			>
				<VersionsDialog editor={editor} />
				<NotificationsPopover />
			</div>

			{/* Official Liveblocks Toolbar */}
			<div className={cn("TiptapEditor-toolbar-container", "border-border/80 bg-background border-b")}>
				<Toolbar editor={editor}>
					<Toolbar.SectionHistory />
					<Toolbar.Separator />
					<Toolbar.SectionAi />
					<Toolbar.Separator />
					<Toolbar.BlockSelector />
					<Toolbar.SectionInline />
					<Toolbar.Separator />
					<Toolbar.SectionCollaboration />
				</Toolbar>
			</div>

			{/* Editor Content Area */}
			<EditorContent editor={editor} className={cn("TiptapEditor-editor", "relative min-h-[500px] w-full p-6")}>
				<div className="absolute left-full ml-4">
					<Threads editor={editor} />
				</div>
			</EditorContent>
			<FloatingComposer editor={editor} className="w-[350px]" />
			<FloatingToolbar editor={editor}>
				{/* Official Liveblocks FloatingToolbar - excludes SectionHistory as requested */}
				<Toolbar.SectionAi />
				<Toolbar.Separator />
				<Toolbar.BlockSelector />
				<Toolbar.SectionInline />
				<Toolbar.Separator />
				<Toolbar.SectionCollaboration />
			</FloatingToolbar>
			<AiToolbar editor={editor} />
		</div>
	);
}

function Threads({ editor }: { editor: Editor | null }) {
	const { threads } = useThreads();
	const isMobile = useIsMobile();

	if (!threads || !editor) {
		return null;
	}

	return isMobile ? (
		<FloatingThreads threads={threads} editor={editor} />
	) : (
		<AnchoredThreads threads={threads} editor={editor} className="mr-[50px] w-[350px] xl:mr-[100px]" />
	);
}
