"use client";

import { useEffect, type FC } from "react";
import { MarkdownText } from "./markdown-text";
import { useCanvasIntegration } from "../../hooks/use-canvas-integration";
import { useArtifactToolDetection } from "../../hooks/use-artifact-tool-detection";
import { MessagePrimitive, useMessage } from "@assistant-ui/react";

export const ArtifactAwareText: FC = () => {
	const { detectAndCreateArtifact } = useCanvasIntegration();
	const message = useMessage();

	// Listen for explicit tool calls from the server
	useArtifactToolDetection();

	// Fallback pattern-match detection (kept for robustness)
	useEffect(() => {
		if (message.role === "assistant" && message.content.length > 0) {
			// Get the text content from all text parts
			const textContent = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");

			if (textContent) {
				detectAndCreateArtifact(textContent);
			}
		}
	}, [message, detectAndCreateArtifact]);

	return <MessagePrimitive.Content components={{ Text: MarkdownText }} />;
};
