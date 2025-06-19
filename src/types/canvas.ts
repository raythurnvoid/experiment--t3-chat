export interface ArtifactContent {
	index: number;
	title: string;
	type: "text";
}

export interface ArtifactTextContent extends ArtifactContent {
	type: "text";
	fullMarkdown: string;
}

export interface Artifact {
	id: string; // Server-generated UUID
	currentIndex: number;
	contents: ArtifactTextContent[];
	createdAt: string; // ISO date string
	title: string; // Display title for the artifact
}

export interface CanvasState {
	artifacts: Map<string, Artifact>; // Map of UUID to Artifact
	currentArtifactId: string | null; // Currently viewed artifact
	isEditing: boolean;
	updateRenderedArtifactRequired: boolean;
}
