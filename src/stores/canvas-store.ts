import { create } from "zustand";
import type {
	Artifact,
	CanvasState,
	ArtifactCodeContent,
	ArtifactTextContent,
	ProgrammingLanguage,
} from "../types/canvas";

interface CanvasStore extends CanvasState {
	updateRenderedArtifactRequired: boolean;
	firstTokenReceived: boolean;
	setArtifact: (artifact: Artifact | null) => void;
	setIsStreaming: (isStreaming: boolean) => void;
	setChatStarted: (chatStarted: boolean) => void;
	setIsEditing: (isEditing: boolean) => void;
	setUpdateRenderedArtifactRequired: (required: boolean) => void;
	setFirstTokenReceived: (received: boolean) => void;
	updateArtifactContent: (content: string) => void;
	getCurrentArtifactContent: () =>
		| (ArtifactCodeContent | ArtifactTextContent)
		| null;
	createQuickStart: (type: "text" | "code", language?: string) => void;
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
	artifact: null,
	isStreaming: false,
	chatStarted: false,
	isEditing: false,
	updateRenderedArtifactRequired: false,
	firstTokenReceived: false,

	setArtifact: (artifact) => {
		set({
			artifact,
			updateRenderedArtifactRequired: true,
			firstTokenReceived: true,
		});
	},
	setIsStreaming: (isStreaming) => {
		set({
			isStreaming,
			// Reset first token when streaming starts
			...(isStreaming && { firstTokenReceived: false }),
		});
	},
	setChatStarted: (chatStarted) => set({ chatStarted }),
	setIsEditing: (isEditing) => set({ isEditing }),
	setUpdateRenderedArtifactRequired: (required) =>
		set({ updateRenderedArtifactRequired: required }),
	setFirstTokenReceived: (received) => set({ firstTokenReceived: received }),

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

		const updatedContents = artifact.contents.map(
			(c: ArtifactCodeContent | ArtifactTextContent) => {
				if (c.index === artifact.currentIndex) {
					if (c.type === "code") {
						return { ...c, code: content };
					} else {
						return { ...c, fullMarkdown: content };
					}
				}
				return c;
			}
		);

		set({
			artifact: {
				...artifact,
				contents: updatedContents,
			},
			updateRenderedArtifactRequired: true,
			firstTokenReceived: true,
		});
	},

	createQuickStart: (type, language) => {
		let artifactContent: ArtifactCodeContent | ArtifactTextContent;

		if (type === "code" && language) {
			const codeTemplate = getLanguageTemplate(language);
			artifactContent = {
				index: 1,
				type: "code",
				title: `Quick start ${type}`,
				code: codeTemplate,
				language: language as ProgrammingLanguage,
			};
		} else {
			artifactContent = {
				index: 1,
				type: "text",
				title: `Quick start ${type}`,
				fullMarkdown:
					"# Welcome to your canvas\n\nStart writing your content here...",
			};
		}

		const newArtifact: Artifact = {
			currentIndex: 1,
			contents: [artifactContent],
		};

		set({
			artifact: newArtifact,
			chatStarted: true,
			isEditing: true,
		});
	},
}));

function getLanguageTemplate(language: string): string {
	const templates: Record<string, string> = {
		javascript: `// JavaScript code
console.log("Hello, World!");

function greet(name) {
  return \`Hello, \${name}!\`;
}

greet("Canvas");`,
		typescript: `// TypeScript code
interface User {
  name: string;
  age: number;
}

const user: User = {
  name: "Canvas User",
  age: 25
};

console.log(\`Hello, \${user.name}!\`);`,
		python: `# Python code
def greet(name: str) -> str:
    return f"Hello, {name}!"

def main():
    print("Hello, World!")
    print(greet("Canvas"))

if __name__ == "__main__":
    main()`,
		html: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Canvas HTML</title>
</head>
<body>
    <h1>Hello, Canvas!</h1>
    <p>Welcome to your HTML canvas.</p>
</body>
</html>`,
		css: `/* CSS Styles */
body {
  font-family: 'Arial', sans-serif;
  margin: 0;
  padding: 20px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.container {
  max-width: 800px;
  margin: 0 auto;
  text-align: center;
}

h1 {
  font-size: 2.5rem;
  margin-bottom: 1rem;
}`,
	};

	return (
		templates[language] || `// ${language} code\nconsole.log("Hello, Canvas!");`
	);
}
