import { z } from "zod";

// Shared schema for createArtifact tool arguments
export const createArtifactArgsSchema = z.object({
	type: z.enum(["code", "text"]).describe("Type of artifact to create"),
	title: z.string().optional().describe("Optional title for the artifact"),
	language: z
		.string()
		.optional()
		.describe(
			"Programming language for code artifacts (e.g., 'javascript', 'python', 'typescript')"
		),
	code: z
		.string()
		.optional()
		.describe("The code content (required when type is 'code')"),
	markdown: z
		.string()
		.optional()
		.describe("The markdown/text content (required when type is 'text')"),
});

// Shared schema for tool call content parts (based on AI SDK spec)
export const toolCallContentPartSchema = z.object({
	type: z.literal("tool-call"),
	toolCallId: z.string(),
	toolName: z.string(),
	args: z.unknown(),
});

// Infer TypeScript types from schemas
export type CreateArtifactArgs = z.infer<typeof createArtifactArgsSchema>;
export type ToolCallContentPart = z.infer<typeof toolCallContentPartSchema>;

// Type guard functions with runtime validation
export function isToolCallContentPart(
	part: unknown
): part is ToolCallContentPart {
	return toolCallContentPartSchema.safeParse(part).success;
}

export function isCreateArtifactCall(part: ToolCallContentPart): boolean {
	return part.toolName === "createArtifact";
}

export function parseCreateArtifactArgs(
	args: unknown
): CreateArtifactArgs | null {
	const result = createArtifactArgsSchema.safeParse(args);
	return result.success ? result.data : null;
}
