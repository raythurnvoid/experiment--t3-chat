import { useCallback } from "react";
import { useCanvasStore } from "../stores/canvas-store";
import type {
	ArtifactCodeContent,
	ArtifactTextContent,
	ProgrammingLanguage,
} from "../types/canvas";

export function useCanvasIntegration() {
	const { setArtifact, setChatStarted, artifact } = useCanvasStore();

	const detectAndCreateArtifact = useCallback(
		(content: string) => {
			// Check for code blocks first
			const codeBlockMatch = content.match(/```(\w+)?\n([\s\S]*?)```/);
			if (codeBlockMatch) {
				const language = codeBlockMatch[1] || "javascript";
				const code = codeBlockMatch[2].trim();

				if (code.length > 0) {
					// Create artifact for any code block
					const codeContent: ArtifactCodeContent = {
						index: 1,
						type: "code",
						title: `${language.charAt(0).toUpperCase() + language.slice(1)} Code`,
						code,
						language: language as ProgrammingLanguage,
					};

					setArtifact({
						currentIndex: 1,
						contents: [codeContent],
					});
					setChatStarted(true);
					return true;
				}
			}

			// Check for substantial markdown content (more lenient criteria)
			const hasHeaders = /^#+\s.+$/m.test(content);
			const hasMultipleLines = content.split("\n").length > 2;
			const hasSubstantialContent = content.length > 50; // Lower threshold
			const hasStoryKeywords =
				/\b(story|document|article|essay|chapter|tale|narrative)\b/i.test(
					content
				);

			// Create artifact if it has headers OR is substantial content OR contains story keywords
			if (
				(hasHeaders && hasMultipleLines) ||
				(hasSubstantialContent && hasStoryKeywords) ||
				content.length > 200
			) {
				const textContent: ArtifactTextContent = {
					index: 1,
					type: "text",
					title: hasHeaders
						? content.match(/^#+\s(.+)$/m)?.[1]?.slice(0, 50) || "Document"
						: "Story Document",
					fullMarkdown: content,
				};

				setArtifact({
					currentIndex: 1,
					contents: [textContent],
				});
				setChatStarted(true);
				return true;
			}

			return false;
		},
		[setArtifact, setChatStarted]
	);

	const updateArtifactWithResponse = useCallback(
		(response: string) => {
			if (!artifact) {
				// Try to create a new artifact if response warrants it
				detectAndCreateArtifact(response);
			} else {
				// Update existing artifact if it's a code or text continuation
				const currentContent = artifact.contents.find(
					(c) => c.index === artifact.currentIndex
				);
				if (currentContent) {
					const codeMatch = response.match(/```(\w+)?\n([\s\S]*?)```/);

					if (codeMatch && currentContent.type === "code") {
						const newCode = codeMatch[2].trim();
						if (newCode.length > 10) {
							const updatedContent: ArtifactCodeContent = {
								...currentContent,
								code: newCode,
							};

							setArtifact({
								...artifact,
								contents: artifact.contents.map((c) =>
									c.index === artifact.currentIndex ? updatedContent : c
								),
							});
						}
					}
				}
			}
		},
		[artifact, setArtifact, detectAndCreateArtifact]
	);

	return {
		detectAndCreateArtifact,
		updateArtifactWithResponse,
	};
}
