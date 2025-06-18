import {
	makeAssistantToolUI,
	type ToolCallContentPartProps,
} from "@assistant-ui/react";
import { useCanvasStore } from "../stores/canvas-store";
import type {
	ArtifactCodeContent,
	ArtifactTextContent,
	ProgrammingLanguage,
} from "../types/canvas";
import { parseCreateArtifactArgs } from "../types/artifact-schemas";
import { memo, useEffect } from "react";

type CreateArtifactToolProps = ToolCallContentPartProps<
	{
		type: "code" | "text";
		title?: string;
		code?: string;
		language?: string;
		markdown?: string;
	},
	void
>;

function CreateArtifactToolRender({ args, status }: CreateArtifactToolProps) {
	const { setArtifact } = useCanvasStore();

	// Use the existing Zod parser to validate arguments
	const parsedArgs = parseCreateArtifactArgs(args);

	useEffect(() => {
		if (!parsedArgs) {
			return;
		}

		const { type, title, code, language, markdown } = parsedArgs;

		try {
			if (type === "code" && code && language) {
				const codeContent: ArtifactCodeContent = {
					index: 0,
					type: "code",
					title: title || "Code Snippet",
					code,
					language: language as ProgrammingLanguage,
				};
				setArtifact({
					currentIndex: 0,
					contents: [codeContent],
				});
			} else if (type === "text" && markdown) {
				const textContent: ArtifactTextContent = {
					index: 0,
					type: "text",
					title: title || "Document",
					fullMarkdown: markdown,
				};

				setArtifact({
					currentIndex: 0,
					contents: [textContent],
				});
			}
		} catch (error) {
			console.error("❌ Error updating canvas store:", error);
		}

		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [args, status.type]);

	// Return a small indicator that the hook is active
	return parsedArgs ? (
		<div className="CreateArtifactHook">Hello from CreateArtifactHook</div>
	) : (
		<div className="CreateArtifactHook">Parsing artifact...</div>
	);
}

export const CreateArtifactToolUI = memo(
	makeAssistantToolUI<
		{
			type: "code" | "text";
			title?: string;
			code?: string;
			language?: string;
			markdown?: string;
		},
		void
	>({
		toolName: "createArtifact",
		render: (args) => {
			return CreateArtifactToolRender(args);
		},
	})
);
