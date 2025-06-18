"use client";

import { useEffect } from "react";
import { useThread } from "@assistant-ui/react";
import { useCanvasStore } from "../stores/canvas-store";
import {
	parseCreateArtifactArgs,
	getCreateArtifactCalls,
	type CreateArtifactArgs,
} from "../types/artifact-schemas";
import type {
	ArtifactCodeContent,
	ArtifactTextContent,
	ProgrammingLanguage,
} from "../types/canvas";

/**
 * Watches the entire thread for TOOL-CALL messages named `createArtifact`.
 * If found, this hook converts the tool arguments into a canvas artifact
 * and switches the UI from chat to canvas.
 *
 * This hook runs at the thread level and processes all messages to find
 * the most recent artifact creation or update.
 *
 * TODO: The detection of create vs update artifact should happen via tool calling
 * on the server side, not by automatic detection in this client hook.
 * The server should determine whether to call createArtifact or updateArtifact tools.
 */
export function useArtifactToolDetection() {
	const thread = useThread();
	const { setArtifact, artifact, updateArtifactContent } = useCanvasStore();

	useEffect(
		() => {
			// Look for assistant messages with tool calls
			const assistantMessages = thread.messages.filter(
				(message) => message.role === "assistant"
			);

			if (assistantMessages.length === 0) return;

			// Process all assistant messages to find tool calls
			let latestToolCall:
				| ReturnType<typeof getCreateArtifactCalls>[number]
				| null = null;
			let sourceMessage: (typeof thread.messages)[number] | null = null;

			for (const message of assistantMessages) {
				// Use the utility function to get createArtifact calls
				const createArtifactCalls = getCreateArtifactCalls(message.content);

				if (createArtifactCalls.length > 0) {
					// Use the most recent tool call
					latestToolCall = createArtifactCalls[createArtifactCalls.length - 1];
					sourceMessage = message;
				}
			}

			if (!latestToolCall || !sourceMessage) return;

			// Parse and validate arguments
			const args = parseCreateArtifactArgs(latestToolCall.args);
			if (!args) {
				console.warn("Invalid createArtifact arguments:", latestToolCall.args);
				return;
			}

			// Create artifact based on validated args
			try {
				createArtifactFromArgs(args);
			} catch (error) {
				console.error("Error creating artifact:", error);
			}
		},

		// eslint-disable-next-line react-hooks/exhaustive-deps
		[thread.messages, thread.isRunning]
	);

	/**
	 * Creates or updates an artifact from validated CreateArtifactArgs
	 */
	function createArtifactFromArgs(args: CreateArtifactArgs) {
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

			// Check if this is an update to existing artifact or new one
			if (artifact && artifact.contents.length > 0) {
				const currentContent = artifact.contents.find(
					(c) => c.index === artifact.currentIndex
				);
				if (
					currentContent &&
					currentContent.type === "code" &&
					currentContent.title === codeContent.title
				) {
					// Update existing content during streaming
					if (currentContent.code !== codeContent.code) {
						updateArtifactContent(codeContent.code);
					}
					return;
				}
			}

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

			// Check if this is an update to existing artifact or new one
			if (artifact && artifact.contents.length > 0) {
				const currentContent = artifact.contents.find(
					(c) => c.index === artifact.currentIndex
				);
				if (
					currentContent &&
					currentContent.type === "text" &&
					currentContent.title === textContent.title
				) {
					// Update existing content during streaming
					if (currentContent.fullMarkdown !== textContent.fullMarkdown) {
						updateArtifactContent(textContent.fullMarkdown);
					}
					return;
				}
			}

			setArtifact({
				currentIndex: 1,
				contents: [textContent],
			});
		}
	}
}
