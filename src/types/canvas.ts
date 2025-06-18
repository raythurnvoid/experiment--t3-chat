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
	currentIndex: number;
	contents: ArtifactTextContent[];
}

export interface CanvasState {
	artifact: Artifact | null;
	isEditing: boolean;
	updateRenderedArtifactRequired: boolean;
}
