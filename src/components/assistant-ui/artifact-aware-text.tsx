"use client";

import { useEffect, type FC } from "react";
import { MarkdownText } from "./markdown-text";
import { useCanvasIntegration } from "../../hooks/use-canvas-integration";
import { MessagePrimitive, useMessage } from "@assistant-ui/react";

export const ArtifactAwareText: FC = () => {
	const { detectAndCreateArtifact } = useCanvasIntegration();
	const message = useMessage();

	// Fallback pattern-match detection (kept for robustness)
	// Note: Primary artifact detection now happens at page level via useArtifactToolDetection
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
