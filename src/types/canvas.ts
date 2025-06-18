export type ProgrammingLanguage =
	| "javascript"
	| "typescript"
	| "python"
	| "html"
	| "css"
	| "java"
	| "cpp"
	| "rust"
	| "go";

export interface ArtifactContent {
	index: number;
	title: string;
	type: "text" | "code";
}

export interface ArtifactCodeContent extends ArtifactContent {
	type: "code";
	code: string;
	language: ProgrammingLanguage;
}

export interface ArtifactTextContent extends ArtifactContent {
	type: "text";
	fullMarkdown: string;
}

export interface Artifact {
	currentIndex: number;
	contents: (ArtifactCodeContent | ArtifactTextContent)[];
}

export interface CanvasState {
	artifact: Artifact | null;
	isStreaming: boolean;
	chatStarted: boolean;
	isEditing: boolean;
	updateRenderedArtifactRequired: boolean;
	firstTokenReceived: boolean;
}
