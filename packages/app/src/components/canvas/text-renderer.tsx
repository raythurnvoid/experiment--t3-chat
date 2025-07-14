import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useCanvasStore } from "../../stores/canvas-store";
import { useThread } from "@assistant-ui/react";
import type { ArtifactTextContent } from "../../types/canvas";
import "@blocknote/core/fonts/inter.css";
import { getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote } from "@blocknote/react";
import PQueue from "p-queue";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Eye, EyeOff, Copy } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { MantineProvider } from "@mantine/core";
import { useThemeContext } from "../theme-provider";

const cleanText = (text: string) => {
	return text.replace(/\\\n/g, "\n");
};

// Use global theme context instead of local detection

function ViewRawText({
	isRawView,
	setIsRawView,
}: {
	isRawView: boolean;
	setIsRawView: Dispatch<SetStateAction<boolean>>;
}) {
	return (
		<TooltipProvider delayDuration={400}>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="outline" size="sm" onClick={() => setIsRawView((p) => !p)} className="h-8 w-8 p-0">
						{isRawView ? (
							<EyeOff className="w-4 h-4 text-gray-600 dark:text-gray-400" />
						) : (
							<Eye className="w-4 h-4 text-gray-600 dark:text-gray-400" />
						)}
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					<p>View {isRawView ? "rendered" : "raw"} markdown</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

function CopyText({ content }: { content: string }) {
	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(content);
		} catch (err) {
			console.error("Failed to copy text: ", err);
		}
	};

	return (
		<TooltipProvider delayDuration={400}>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="outline" size="sm" onClick={handleCopy} className="h-8 w-8 p-0">
						<Copy className="w-4 h-4 text-gray-600 dark:text-gray-400" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					<p>Copy text</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

interface TextRendererProps {
	isHovering?: boolean;
}

export function TextRenderer({ isHovering }: TextRendererProps) {
	const editor = useCreateBlockNote({});

	// Queue for managing markdown parsing operations
	// - Max 1 concurrent operation
	// - New tasks replace pending ones
	const markdownQueue = useMemo(() => new PQueue({ concurrency: 1 }), []);

	const {
		getCurrentArtifact,
		getCurrentArtifactContent,
		updateArtifactContent,
		updateRenderedArtifactRequired,
		setUpdateRenderedArtifactRequired,
		currentArtifactId,
	} = useCanvasStore();

	const thread = useThread();
	const isStreaming = thread.isRunning;
	const { resolved_theme } = useThemeContext();
	const isDarkMode = resolved_theme === "dark";

	// Use Assistant UI's message status to determine if we've received content
	const lastMessage = thread.messages[thread.messages.length - 1];
	const hasReceivedFirstToken = lastMessage?.role === "assistant" && lastMessage.content.length > 0;

	const artifact = getCurrentArtifact();
	const currentContent = getCurrentArtifactContent() as ArtifactTextContent | null;
	const [rawMarkdown, setRawMarkdown] = useState("");
	const [isRawView, setIsRawView] = useState(false);
	// Use ref to track manual update progress without triggering re-renders
	const manuallyUpdatingRef = useRef(false);

	// Memoized content update promise - only recreates when artifact content changes
	useEffect(() => {
		// eslint-disable-next-line @typescript-eslint/no-floating-promises
		(async (/* iife */) => {
			if (!artifact || !currentContent) return null;
			// Only update when flagged by the store
			if (!updateRenderedArtifactRequired) {
				return null;
			}

			try {
				manuallyUpdatingRef.current = true;

				// Use queue to manage markdown parsing operations
				// Clear pending items if any, then add new task
				if (markdownQueue.size > 0) {
					markdownQueue.clear();
				}
				await markdownQueue.add(async () => {
					const markdownAsBlocks = await editor.tryParseMarkdownToBlocks(currentContent.fullMarkdown);
					editor.replaceBlocks(editor.document, markdownAsBlocks);
				});

				setUpdateRenderedArtifactRequired(false);
				manuallyUpdatingRef.current = false;
			} catch (error) {
				console.error("Error updating editor content:", error);
				manuallyUpdatingRef.current = false;
				setUpdateRenderedArtifactRequired(false);
			}
		})();
	}, [
		artifact,
		currentContent,
		updateRenderedArtifactRequired,
		editor,
		setUpdateRenderedArtifactRequired,
		markdownQueue,
	]);

	// Handle raw view toggle with event handlers
	const handleRawViewToggle = useCallback(
		async (newIsRawView: boolean) => {
			if (newIsRawView && currentContent) {
				// Entering raw view - serialize current editor content
				try {
					const markdown = await editor.blocksToMarkdownLossy(editor.document);
					setRawMarkdown(markdown);
				} catch (error) {
					console.error("Error serializing to markdown:", error);
				}
			} else if (!newIsRawView && rawMarkdown && currentContent) {
				// Leaving raw view - parse textarea back to blocks
				try {
					manuallyUpdatingRef.current = true;

					// Use queue to manage markdown parsing operations
					// Clear pending items if any, then add new task
					if (markdownQueue.size > 0) {
						markdownQueue.clear();
					}
					await markdownQueue.add(async () => {
						const markdownAsBlocks = await editor.tryParseMarkdownToBlocks(rawMarkdown);
						editor.replaceBlocks(editor.document, markdownAsBlocks);
					});

					manuallyUpdatingRef.current = false;
				} catch (error) {
					console.error("Error parsing raw markdown:", error);
					manuallyUpdatingRef.current = false;
				}
			}
			setIsRawView(newIsRawView);
		},
		[currentContent, editor, rawMarkdown, markdownQueue],
	);

	// Wrapper for ViewRawText to handle the async callback
	const handleViewRawTextToggle = useCallback(
		(value: boolean | ((prev: boolean) => boolean)) => {
			const newValue = typeof value === "function" ? value(isRawView) : value;
			handleRawViewToggle(newValue).catch(console.error);
		},
		[isRawView, handleRawViewToggle],
	);

	const onChange = useCallback(async () => {
		if (isStreaming || manuallyUpdatingRef.current || updateRenderedArtifactRequired || !currentArtifactId) {
			return;
		}

		// Use queue to manage markdown serialization operations
		// Clear pending items if any, then add new task
		if (markdownQueue.size > 0) {
			markdownQueue.clear();
		}
		await markdownQueue.add(async () => {
			const fullMarkdown = await editor.blocksToMarkdownLossy(editor.document);
			updateArtifactContent(currentArtifactId, cleanText(fullMarkdown));
		});
	}, [isStreaming, updateRenderedArtifactRequired, currentArtifactId, markdownQueue, editor, updateArtifactContent]);

	const onChangeRawMarkdown = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const newRawMarkdown = e.target.value;
		setRawMarkdown(newRawMarkdown);
		if (!isStreaming && currentArtifactId) {
			updateArtifactContent(currentArtifactId, newRawMarkdown);
		}
	};

	if (!currentContent) {
		return (
			<div
				className={cn("TextRenderer-empty", "flex items-center justify-center h-64 text-gray-500 dark:text-gray-400")}
			>
				No text content available
			</div>
		);
	}

	return (
		<MantineProvider forceColorScheme={isDarkMode ? "dark" : "light"}>
			<div className="w-full h-full mt-2 flex flex-col border-t-[1px] border-gray-200 dark:border-gray-700 overflow-y-auto py-5 relative">
				{isHovering && (
					<div className="absolute flex gap-2 top-2 right-4 z-10">
						<CopyText content={currentContent.fullMarkdown} />
						<ViewRawText isRawView={isRawView} setIsRawView={handleViewRawTextToggle} />
					</div>
				)}

				{isRawView ? (
					<textarea
						className="whitespace-pre-wrap font-mono text-sm px-[54px] border-0 shadow-none h-full outline-none ring-0 rounded-none focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent text-gray-900 dark:text-gray-100 resize-none"
						value={rawMarkdown}
						onChange={onChangeRawMarkdown}
						placeholder="Start writing your markdown content..."
						disabled={isStreaming}
					/>
				) : (
					<div
						className={cn(
							isStreaming && !hasReceivedFirstToken ? "pulse-text" : "",
							"w-full h-full custom-blocknote-theme",
						)}
					>
						<BlockNoteView
							theme={isDarkMode ? "dark" : "light"}
							formattingToolbar={false}
							slashMenu={false}
							onChange={onChange}
							editable={!isStreaming || !manuallyUpdatingRef.current}
							editor={editor}
						>
							<SuggestionMenuController
								// eslint-disable-next-line @typescript-eslint/require-await
								getItems={async () => getDefaultReactSlashMenuItems(editor).filter((item) => item.group !== "Media")}
								triggerCharacter={"/"}
							/>
						</BlockNoteView>
					</div>
				)}
			</div>
		</MantineProvider>
	);
}
