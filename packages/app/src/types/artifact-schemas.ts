import { z } from "zod";

// Updated schema for createArtifact tool arguments without markdown parameter
export const createArtifactArgsSchema = z.object({
	type: z.enum(["text"]).describe("Type of artifact to create"),
	title: z.string().min(1).describe("Title for the artifact"),
	markdown: z.string().min(1).describe("The markdown/text content"),
});

// Infer types from schemas
export type CreateArtifactArgs = z.infer<typeof createArtifactArgsSchema>;

// Helper function to parse and validate createArtifact arguments
export function parseCreateArtifactArgs(args: unknown) {
	return createArtifactArgsSchema.safeParse(args);
}
