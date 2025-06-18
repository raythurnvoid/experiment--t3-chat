import { create } from "zustand";
import type {
	Artifact,
	CanvasState,
	ArtifactTextContent,
} from "../types/canvas";

interface CanvasStore extends CanvasState {
	updateRenderedArtifactRequired: boolean;
	setArtifact: (artifact: Artifact | null) => void;
	setIsEditing: (isEditing: boolean) => void;
	setUpdateRenderedArtifactRequired: (required: boolean) => void;
	updateArtifactContent: (content: string) => void;
	getCurrentArtifactContent: () => ArtifactTextContent | null;
	createQuickStart: () => void;
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
	artifact: null,
	isEditing: false,
	updateRenderedArtifactRequired: false,

	setArtifact: (artifact) => {
		set({
			artifact,
			updateRenderedArtifactRequired: true,
		});
	},

	setIsEditing: (isEditing) => set({ isEditing }),
	setUpdateRenderedArtifactRequired: (required) =>
		set({ updateRenderedArtifactRequired: required }),

	getCurrentArtifactContent: () => {
		const { artifact } = get();
		if (!artifact || artifact.contents.length === 0) return null;
		return (
			artifact.contents.find(
				(content) => content.index === artifact.currentIndex
			) || null
		);
	},

	updateArtifactContent: (content: string) => {
		const { artifact } = get();
		if (!artifact) return;

		const currentContent = artifact.contents.find(
			(c) => c.index === artifact.currentIndex
		);
		if (!currentContent) return;

		const updatedContents = artifact.contents.map((c: ArtifactTextContent) => {
			if (c.index === artifact.currentIndex) {
				return { ...c, fullMarkdown: content };
			}
			return c;
		});

		set({
			artifact: {
				...artifact,
				contents: updatedContents,
			},
			updateRenderedArtifactRequired: true,
		});
	},

	createQuickStart: () => {
		const newContent: ArtifactTextContent = {
			index: 1,
			type: "text",
			title: "Quick Start Document",
			fullMarkdown: "# New Document\n\nStart writing your content here...",
		};

		set({
			artifact: {
				currentIndex: 1,
				contents: [newContent],
			},
			updateRenderedArtifactRequired: true,
		});
	},
}));
