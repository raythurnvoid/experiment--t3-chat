"use client";

import { useEffect } from "react";
import { useMessage } from "@assistant-ui/react";
import { useCanvasStore } from "../stores/canvas-store";
import {
	isToolCallContentPart,
	isCreateArtifactCall,
	parseCreateArtifactArgs,
	type CreateArtifactArgs,
} from "../types/artifact-schemas";
import type {
	ArtifactCodeContent,
	ArtifactTextContent,
	ProgrammingLanguage,
} from "../types/canvas";

/**
 * Watches the current streaming assistant message.
 * If the assistant emits a TOOL-CALL named `createArtifact`
 * this hook converts the tool arguments into a canvas artifact
 * and switches the UI from chat to canvas.
 */
export function useArtifactToolDetection() {
	const message = useMessage();
	const { setArtifact, setChatStarted } = useCanvasStore();

	useEffect(() => {
		if (message.role !== "assistant") return;

		// Find tool call parts using proper type guards
		// Note: assistant-ui types don't include tool-call parts, so we need to widen the type
		const messageContent = message.content as unknown[];
		const toolCallParts = messageContent.filter(isToolCallContentPart);
		const createArtifactCalls = toolCallParts.filter(isCreateArtifactCall);

		if (createArtifactCalls.length === 0) return;

		// Process the first createArtifact call
		const toolCall = createArtifactCalls[0];

		// Parse and validate arguments - no casting needed!
		const args = parseCreateArtifactArgs(toolCall.args);
		if (!args) {
			console.warn("Invalid createArtifact arguments:", toolCall.args);
			return;
		}

		// Create artifact based on validated args
		try {
			if (args.type === "code") {
				if (!args.code) {
					console.warn("Code artifact missing code content");
					return;
				}

				const codeContent: ArtifactCodeContent = {
					index: 1,
					type: "code",
					title: args.title || `${args.language || "Code"} Snippet`,
					code: args.code,
					language: (args.language || "javascript") as ProgrammingLanguage,
				};

				setArtifact({
					currentIndex: 1,
					contents: [codeContent],
				});
			} else if (args.type === "text") {
				if (!args.markdown) {
					console.warn("Text artifact missing markdown content");
					return;
				}

				const textContent: ArtifactTextContent = {
					index: 1,
					type: "text",
					title: args.title || "Document",
					fullMarkdown: args.markdown,
				};

				setArtifact({
					currentIndex: 1,
					contents: [textContent],
				});
			}

			setChatStarted(true);
		} catch (error) {
			console.error("Error creating artifact:", error);
		}
	}, [message.content, setArtifact, setChatStarted]);
}
