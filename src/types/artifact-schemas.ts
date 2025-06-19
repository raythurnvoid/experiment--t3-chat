import { z } from "zod";
import type { ThreadAssistantContentPart } from "@assistant-ui/react";

// Enhanced schema for createArtifact tool arguments with better validation
export const createArtifactArgsSchema = z
	.object({
		type: z.enum(["text"]).describe("Type of artifact to create"),
		title: z
			.string()
			.min(1)
			.optional()
			.describe("Optional title for the artifact"),
		markdown: z.string().min(1).describe("The markdown/text content"),
	})
	// Add refined validation to ensure required fields are present
	.refine(
		(data) => {
			if (data.type === "text") {
				return data.markdown !== undefined && data.markdown.trim().length > 0;
			}
			return true;
		},
		{
			message: "Text artifacts require 'markdown' field",
			path: ["type"],
		}
	);

// Schema for the tool result that includes the generated UUID
export const createArtifactResultSchema = z.object({
	success: z.boolean(),
	artifactId: z.string().uuid().optional(),
	error: z.string().optional(),
});

// Infer TypeScript types from schemas
export type CreateArtifactArgs = z.infer<typeof createArtifactArgsSchema>;
export type CreateArtifactResult = z.infer<typeof createArtifactResultSchema>;

// Type guard functions that work with assistant-ui types
export function isToolCallContentPart(
	part: ThreadAssistantContentPart
): part is Extract<ThreadAssistantContentPart, { type: "tool-call" }> {
	return part.type === "tool-call";
}

export function isCreateArtifactCall(
	part: Extract<ThreadAssistantContentPart, { type: "tool-call" }>
): boolean {
	return part.toolName === "createArtifact";
}

export function parseCreateArtifactArgs(
	args: unknown
): CreateArtifactArgs | null {
	const result = createArtifactArgsSchema.safeParse(args);
	return result.success ? result.data : null;
}

// Additional utility to get tool call from assistant-ui type
export function getToolCallContentParts(
	content: readonly ThreadAssistantContentPart[]
): Extract<ThreadAssistantContentPart, { type: "tool-call" }>[] {
	return content.filter(isToolCallContentPart);
}

// Utility to find createArtifact calls specifically
export function getCreateArtifactCalls(
	content: readonly ThreadAssistantContentPart[]
): Extract<ThreadAssistantContentPart, { type: "tool-call" }>[] {
	return getToolCallContentParts(content).filter(isCreateArtifactCall);
}
