import { create } from "zustand";
import type { Artifact, CanvasState, ArtifactTextContent } from "../types/canvas";

interface CanvasStore extends CanvasState {
	updateRenderedArtifactRequired: boolean;
	setArtifact: (artifact: Artifact) => void;
	setCurrentArtifactId: (id: string | null) => void;
	setIsEditing: (isEditing: boolean) => void;
	setUpdateRenderedArtifactRequired: (required: boolean) => void;
	updateArtifactContent: (artifactId: string, content: string) => void;
	getCurrentArtifact: () => Artifact | null;
	getCurrentArtifactContent: () => ArtifactTextContent | null;
	getArtifactById: (id: string) => Artifact | null;
	createQuickStart: () => void;
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
	artifacts: new Map<string, Artifact>(),
	currentArtifactId: null,
	isEditing: false,
	updateRenderedArtifactRequired: false,

	setArtifact: (artifact) => {
		set((state) => {
			const newArtifacts = new Map(state.artifacts);
			newArtifacts.set(artifact.id, artifact);
			return {
				artifacts: newArtifacts,
				currentArtifactId: artifact.id,
				updateRenderedArtifactRequired: true,
			};
		});
	},

	setCurrentArtifactId: (id) => {
		set({
			currentArtifactId: id,
			updateRenderedArtifactRequired: true,
		});
	},

	setIsEditing: (isEditing) => set({ isEditing }),
	setUpdateRenderedArtifactRequired: (required) => set({ updateRenderedArtifactRequired: required }),

	getCurrentArtifact: () => {
		const { artifacts, currentArtifactId } = get();
		if (!currentArtifactId) return null;
		return artifacts.get(currentArtifactId) || null;
	},

	getCurrentArtifactContent: () => {
		const { getCurrentArtifact } = get();
		const artifact = getCurrentArtifact();
		if (!artifact || artifact.contents.length === 0) return null;
		return artifact.contents.find((content) => content.index === artifact.currentIndex) || null;
	},

	getArtifactById: (id) => {
		const { artifacts } = get();
		return artifacts.get(id) || null;
	},

	updateArtifactContent: (artifactId: string, content: string) => {
		set((state) => {
			const artifact = state.artifacts.get(artifactId);
			if (!artifact) return state;

			const currentContent = artifact.contents.find((c) => c.index === artifact.currentIndex);
			if (!currentContent) return state;

			const updatedContents = artifact.contents.map((c: ArtifactTextContent) => {
				if (c.index === artifact.currentIndex) {
					return { ...c, fullMarkdown: content };
				}
				return c;
			});

			const updatedArtifact = {
				...artifact,
				contents: updatedContents,
			};

			const newArtifacts = new Map(state.artifacts);
			newArtifacts.set(artifactId, updatedArtifact);

			return {
				artifacts: newArtifacts,
				updateRenderedArtifactRequired: true,
			};
		});
	},

	createQuickStart: () => {
		const artifactId = `quickstart-${Date.now()}`;
		const newContent: ArtifactTextContent = {
			index: 1,
			type: "text",
			title: "Quick Start Document",
			fullMarkdown: "# New Document\n\nStart writing your content here...",
		};

		const newArtifact: Artifact = {
			id: artifactId,
			title: "Quick Start Document",
			currentIndex: 1,
			contents: [newContent],
		};

		set((state) => {
			const newArtifacts = new Map(state.artifacts);
			newArtifacts.set(artifactId, newArtifact);
			return {
				artifacts: newArtifacts,
				currentArtifactId: artifactId,
				updateRenderedArtifactRequired: true,
			};
		});
	},
}));
