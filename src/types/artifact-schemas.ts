import { z } from "zod";
import type { ThreadAssistantContentPart } from "@assistant-ui/react";

// Enhanced schema for createArtifact tool arguments with better validation
export const createArtifactArgsSchema = z
	.object({
		type: z.enum(["code", "text"]).describe("Type of artifact to create"),
		title: z
			.string()
			.min(1)
			.optional()
			.describe("Optional title for the artifact"),
		language: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Programming language for code artifacts (e.g., 'javascript', 'python', 'typescript')"
			),
		code: z
			.string()
			.min(1)
			.optional()
			.describe("The code content (required when type is 'code')"),
		markdown: z
			.string()
			.min(1)
			.optional()
			.describe("The markdown/text content (required when type is 'text')"),
	})
	// Add refined validation to ensure required fields are present based on type
	.refine(
		(data) => {
			if (data.type === "code") {
				return data.code !== undefined && data.code.trim().length > 0;
			}
			if (data.type === "text") {
				return data.markdown !== undefined && data.markdown.trim().length > 0;
			}
			return true;
		},
		{
			message:
				"Code artifacts require 'code' field, text artifacts require 'markdown' field",
			path: ["type"],
		}
	);

// Infer TypeScript types from schemas
export type CreateArtifactArgs = z.infer<typeof createArtifactArgsSchema>;

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
