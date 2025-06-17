import { useCanvasStore } from "../../stores/canvas-store";
import type { ArtifactTextContent } from "../../types/canvas";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/react";
import "@blocknote/core/style.css";
import { useCallback, useEffect, useState } from "react";

interface TextRendererProps {
	isHovering?: boolean;
}

export function TextRenderer({ isHovering }: TextRendererProps) {
	const {
		getCurrentArtifactContent,
		updateArtifactContent,
		isEditing,
		setIsEditing,
		isStreaming,
	} = useCanvasStore();

	const currentContent =
		getCurrentArtifactContent() as ArtifactTextContent | null;
	const [editor, setEditor] = useState<any>(null);

	const blockNoteEditor = useCreateBlockNote({
		initialContent: currentContent?.fullMarkdown
			? undefined
			: [
					{
						type: "paragraph",
						content: [{ type: "text", text: "Start writing...", styles: {} }],
					},
				],
	});

	useEffect(() => {
		if (blockNoteEditor && currentContent?.fullMarkdown) {
			// Convert markdown to blocks when content changes
			blockNoteEditor
				.tryParseMarkdownToBlocks(currentContent.fullMarkdown)
				.then((blocks) => {
					blockNoteEditor.replaceBlocks(blockNoteEditor.document, blocks);
				});
		}
	}, [blockNoteEditor, currentContent?.fullMarkdown]);

	const handleChange = useCallback(() => {
		if (isEditing && blockNoteEditor) {
			const markdown = blockNoteEditor.blocksToMarkdownLossy(
				blockNoteEditor.document
			);
			updateArtifactContent(markdown);
		}
	}, [isEditing, blockNoteEditor, updateArtifactContent]);

	const handleClick = useCallback(() => {
		if (!isStreaming && isHovering) {
			setIsEditing(true);
		}
	}, [isStreaming, isHovering, setIsEditing]);

	if (!currentContent) {
		return (
			<div className="flex items-center justify-center h-64 text-gray-500">
				No text content available
			</div>
		);
	}

	return (
		<div
			className="h-full w-full relative p-4 max-w-4xl mx-auto"
			onClick={handleClick}
		>
			<BlockNoteView
				editor={blockNoteEditor}
				editable={isEditing}
				onChange={handleChange}
				className="min-h-full"
				theme="light"
			/>
			{!isEditing && isHovering && !isStreaming && (
				<div className="absolute top-8 right-8 bg-black/20 text-white px-3 py-1 rounded-md text-sm">
					Click to edit
				</div>
			)}
		</div>
	);
}
