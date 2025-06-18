import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useCanvasStore } from "../../stores/canvas-store";
import type { ArtifactTextContent } from "../../types/canvas";
import "@blocknote/core/fonts/inter.css";
import {
	getDefaultReactSlashMenuItems,
	SuggestionMenuController,
	useCreateBlockNote,
} from "@blocknote/react";
import { BlockNoteView } from "@blocknote/shadcn";
import "@blocknote/shadcn/style.css";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Eye, EyeOff, Copy } from "lucide-react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "../ui/tooltip";

const cleanText = (text: string) => {
	return text.replace(/\\\n/g, "\n");
};

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
					<Button
						variant="outline"
						size="sm"
						onClick={() => setIsRawView((p) => !p)}
						className="h-8 w-8 p-0"
					>
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
					<Button
						variant="outline"
						size="sm"
						onClick={handleCopy}
						className="h-8 w-8 p-0"
					>
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
	const editor = useCreateBlockNote();
	const {
		getCurrentArtifactContent,
		updateArtifactContent,
		isEditing,
		isStreaming,
	} = useCanvasStore();

	const currentContent =
		getCurrentArtifactContent() as ArtifactTextContent | null;
	const [rawMarkdown, setRawMarkdown] = useState("");
	const [isRawView, setIsRawView] = useState(false);
	const [manuallyUpdatingArtifact, setManuallyUpdatingArtifact] =
		useState(false);

	// Update editor content when artifact content changes during streaming
	useEffect(() => {
		if (!currentContent) return;

		// Only update editor if content has changed and we're streaming or need to initialize
		const updateEditor = async () => {
			try {
				setManuallyUpdatingArtifact(true);
				const markdownAsBlocks = await editor.tryParseMarkdownToBlocks(
					currentContent.fullMarkdown
				);
				editor.replaceBlocks(editor.document, markdownAsBlocks);
				setManuallyUpdatingArtifact(false);
			} catch (error) {
				console.error("Error updating editor content:", error);
				setManuallyUpdatingArtifact(false);
			}
		};

		if (isStreaming || !editor.document.length) {
			updateEditor();
		}
	}, [currentContent?.fullMarkdown, isStreaming, editor]);

	// Handle raw view toggle
	useEffect(() => {
		if (isRawView && currentContent) {
			editor.blocksToMarkdownLossy(editor.document).then(setRawMarkdown);
		} else if (!isRawView && rawMarkdown && currentContent) {
			(async () => {
				try {
					setManuallyUpdatingArtifact(true);
					const markdownAsBlocks =
						await editor.tryParseMarkdownToBlocks(rawMarkdown);
					editor.replaceBlocks(editor.document, markdownAsBlocks);
					setManuallyUpdatingArtifact(false);
				} catch (error) {
					console.error("Error parsing raw markdown:", error);
					setManuallyUpdatingArtifact(false);
				}
			})();
		}
	}, [isRawView, editor]);

	const onChange = async () => {
		if (isStreaming || manuallyUpdatingArtifact) return;

		const fullMarkdown = await editor.blocksToMarkdownLossy(editor.document);
		updateArtifactContent(cleanText(fullMarkdown));
	};

	const onChangeRawMarkdown = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const newRawMarkdown = e.target.value;
		setRawMarkdown(newRawMarkdown);
		if (!isStreaming) {
			updateArtifactContent(newRawMarkdown);
		}
	};

	if (!currentContent) {
		return (
			<div
				className={cn(
					"TextRenderer-empty",
					"flex items-center justify-center h-64 text-gray-500 dark:text-gray-400"
				)}
			>
				No text content available
			</div>
		);
	}

	return (
		<div className="w-full h-full mt-2 flex flex-col border-t-[1px] border-gray-200 dark:border-gray-700 overflow-y-auto py-5 relative">
			{isHovering && (
				<div className="absolute flex gap-2 top-2 right-4 z-10">
					<CopyText content={currentContent.fullMarkdown} />
					<ViewRawText isRawView={isRawView} setIsRawView={setIsRawView} />
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
				<div className={cn(isStreaming ? "pulse-text" : "", "w-full h-full")}>
					<BlockNoteView
						theme={
							typeof window !== "undefined" &&
							document.documentElement.classList.contains("dark")
								? "dark"
								: "light"
						}
						formattingToolbar={true}
						slashMenu={true}
						onChange={onChange}
						editable={!isStreaming && !manuallyUpdatingArtifact}
						editor={editor}
						className="custom-blocknote-theme"
					>
						<SuggestionMenuController
							getItems={async () =>
								getDefaultReactSlashMenuItems(editor).filter(
									(item) => item.group !== "Media"
								)
							}
							triggerCharacter={"/"}
						/>
					</BlockNoteView>
				</div>
			)}
		</div>
	);
}
