import { memo, useEffect } from "react";
import { makeAssistantToolUI, useMessage } from "@assistant-ui/react";
import type { ToolCallContentPartProps } from "@assistant-ui/react";
import { useCanvasStore } from "../stores/canvas-store.ts";
import type { ArtifactTextContent, Artifact } from "../types/canvas.ts";
import { parseCreateArtifactArgs, type CreateArtifactArgs } from "../types/artifact-schemas.ts";
import { Button } from "./ui/button.tsx";
import { FileText, Eye, AlertCircle, Loader2 } from "lucide-react";

// Define props interface for better typing
type CreateArtifactToolProps = ToolCallContentPartProps<CreateArtifactArgs, void>;

function CreateArtifactToolRender({ args, result, status }: CreateArtifactToolProps) {
	const { setArtifact, setCurrentArtifactId, getArtifactById } = useCanvasStore();

	// Safely parse arguments and result using Zod
	const argsParseResult = parseCreateArtifactArgs(args);

	const message = useMessage();

	const artifactId = (message.metadata.unstable_data?.[0] as any)?.id;

	useEffect(() => {
		if (!argsParseResult.success) {
			return;
		}

		const { type, title, markdown } = argsParseResult.data;

		try {
			// Create artifact with initial empty content - content will be populated via streaming
			if (type === "text") {
				const textContent: ArtifactTextContent = {
					index: 1,
					type: "text",
					title: title || "Document",
					fullMarkdown: markdown,
				};

				const newArtifact: Artifact = {
					id: artifactId,
					title: title || "Document",
					currentIndex: 1,
					contents: [textContent],
				};

				setArtifact(newArtifact);
			}
		} catch (error) {
			console.error("❌ Error updating canvas store:", error);
		}

		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [result, args, status.type]);

	const handleViewArtifact = () => {
		if (argsParseResult.success && artifactId !== undefined) {
			const artifact = getArtifactById(artifactId);
			if (artifact) {
				setCurrentArtifactId(artifactId);
			}
		}
	};

	// Show loading state while tool is executing
	if (status.type === "running") {
		return (
			<div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950">
				<Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />
				<div className="flex flex-col">
					<span className="text-sm text-blue-800 dark:text-blue-200">
						{status.type === "running" ? "Generating artifact content..." : "Creating artifact..."}
					</span>
					{argsParseResult.success && (
						<span className="text-xs text-blue-600 dark:text-blue-400">
							{argsParseResult.data.title || "Untitled Document"}
						</span>
					)}
				</div>
			</div>
		);
	}

	// Show error state if parsing failed
	if (status.type === "complete" && argsParseResult.error) {
		return (
			<div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950">
				<AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
				<span className="text-sm text-red-800 dark:text-red-200">
					Invalid artifact arguments: {argsParseResult.error.message}
				</span>
			</div>
		);
	}

	// Show success state with view button
	if (status.type === "complete" && argsParseResult.success) {
		return (
			<div className="flex items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950">
				<div className="flex items-center gap-2">
					<FileText className="h-4 w-4 text-green-600 dark:text-green-400" />
					<div className="flex flex-col">
						<span className="text-sm font-medium text-green-800 dark:text-green-200">
							Created: {argsParseResult.data.title || "Document"}
						</span>
						<span className="text-xs text-green-600 dark:text-green-400">ID: {artifactId}</span>
					</div>
				</div>
				<Button
					onClick={handleViewArtifact}
					size="sm"
					variant="outline"
					className="border-green-300 hover:bg-green-100 dark:border-green-700 dark:hover:bg-green-900"
				>
					<Eye className="mr-1 h-4 w-4" />
					View
				</Button>
			</div>
		);
	}

	// Default processing state
	return (
		<div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900">
			<FileText className="h-4 w-4 text-gray-600 dark:text-gray-400" />
			<span className="text-sm text-gray-700 dark:text-gray-300">Processing artifact...</span>
		</div>
	);
}

export const CreateArtifactToolUI = memo(
	makeAssistantToolUI<CreateArtifactArgs, void>({
		toolName: "createArtifact",
		render: (args) => {
			return CreateArtifactToolRender(args);
		},
	}),
);
