import { useCanvasStore } from "../../stores/canvas-store";
import type { ArtifactTextContent } from "../../types/canvas";
import { useCallback } from "react";
import { cn } from "../../lib/utils";

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

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			if (isEditing) {
				updateArtifactContent(e.target.value);
			}
		},
		[isEditing, updateArtifactContent]
	);

	const handleClick = useCallback(() => {
		if (!isStreaming && isHovering) {
			setIsEditing(true);
		}
	}, [isStreaming, isHovering, setIsEditing]);

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
		<div
			className={cn(
				"TextRenderer",
				"h-full w-full relative p-4 max-w-4xl mx-auto"
			)}
			onClick={handleClick}
		>
			{isEditing ? (
				<textarea
					value={currentContent.fullMarkdown}
					onChange={handleChange}
					placeholder="Start writing your content..."
					className={cn(
						"TextRenderer-editor",
						"w-full h-full resize-none border-none outline-none p-4 font-mono text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder:text-gray-500 dark:placeholder:text-gray-400"
					)}
					autoFocus
				/>
			) : (
				<div
					className={cn(
						"TextRenderer-preview",
						"prose prose-sm dark:prose-invert max-w-none h-full overflow-auto p-4"
					)}
					dangerouslySetInnerHTML={{
						__html: currentContent.fullMarkdown
							.replace(/\n/g, "<br/>")
							.replace(/^# (.+)$/gm, "<h1>$1</h1>")
							.replace(/^## (.+)$/gm, "<h2>$1</h2>")
							.replace(/^### (.+)$/gm, "<h3>$1</h3>"),
					}}
				/>
			)}

			{!isEditing && isHovering && !isStreaming && (
				<div
					className={cn(
						"TextRenderer-edit-hint",
						"absolute top-8 right-8 bg-black/20 dark:bg-white/20 text-white dark:text-gray-900 px-3 py-1 rounded-md text-sm"
					)}
				>
					Click to edit
				</div>
			)}
		</div>
	);
}
