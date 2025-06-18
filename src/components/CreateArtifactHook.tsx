import { memo, useEffect } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import type { ToolCallContentPartProps } from "@assistant-ui/react";
import { useCanvasStore } from "../stores/canvas-store";
import type { ArtifactTextContent } from "../types/canvas";
import { parseCreateArtifactArgs } from "../types/artifact-schemas";

// Define props interface for better typing
type CreateArtifactToolProps = ToolCallContentPartProps<
	{
		type: "text";
		title?: string;
		markdown: string;
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

		const { type, title, markdown } = parsedArgs;

		try {
			if (type === "text" && markdown) {
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
			type: "text";
			title?: string;
			markdown: string;
		},
		void
	>({
		toolName: "createArtifact",
		render: (args) => {
			return CreateArtifactToolRender(args);
		},
	})
);
