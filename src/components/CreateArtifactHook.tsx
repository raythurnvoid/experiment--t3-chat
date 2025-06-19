import { memo, useEffect } from "react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import type { ToolCallContentPartProps } from "@assistant-ui/react";
import { useCanvasStore } from "../stores/canvas-store";
import type { ArtifactTextContent, Artifact } from "../types/canvas";
import {
	parseCreateArtifactArgs,
	type CreateArtifactResult,
} from "../types/artifact-schemas";
import { Button } from "./ui/button";
import { FileText, Eye } from "lucide-react";

// Define props interface for better typing
type CreateArtifactToolProps = ToolCallContentPartProps<
	{
		type: "text";
		title?: string;
		markdown: string;
	},
	CreateArtifactResult
>;

function CreateArtifactToolRender({
	args,
	result,
	status,
}: CreateArtifactToolProps) {
	const { setArtifact, setCurrentArtifactId, getArtifactById } =
		useCanvasStore();

	// Use the existing Zod parser to validate arguments
	const parsedArgs = parseCreateArtifactArgs(args);

	useEffect(() => {
		if (!parsedArgs || !result?.success || !result.artifactId) {
			return;
		}

		const { type, title, markdown } = parsedArgs;
		const { artifactId } = result;

		try {
			if (type === "text" && markdown) {
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
					createdAt: new Date().toISOString(),
				};

				setArtifact(newArtifact);
			}
		} catch (error) {
			console.error("❌ Error updating canvas store:", error);
		}

		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [result, args, status.type]);

	const handleViewArtifact = () => {
		if (result?.artifactId) {
			const artifact = getArtifactById(result.artifactId);
			if (artifact) {
				setCurrentArtifactId(result.artifactId);
			}
		}
	};

	// Show loading state while tool is executing
	if (status.type === "running") {
		return (
			<div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg">
				<FileText className="h-4 w-4 text-blue-600 dark:text-blue-400" />
				<span className="text-sm text-blue-800 dark:text-blue-200">
					Creating artifact...
				</span>
			</div>
		);
	}

	// Show error state if failed
	if (status.type === "complete" && result && !result.success) {
		return (
			<div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg">
				<FileText className="h-4 w-4 text-red-600 dark:text-red-400" />
				<span className="text-sm text-red-800 dark:text-red-200">
					Failed to create artifact: {result.error || "Unknown error"}
				</span>
			</div>
		);
	}

	// Show success state with view button
	if (
		status.type === "complete" &&
		result?.success &&
		result.artifactId &&
		parsedArgs
	) {
		return (
			<div className="flex items-center justify-between gap-3 p-3 bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg">
				<div className="flex items-center gap-2">
					<FileText className="h-4 w-4 text-green-600 dark:text-green-400" />
					<div className="flex flex-col">
						<span className="text-sm font-medium text-green-800 dark:text-green-200">
							Created: {parsedArgs.title || "Document"}
						</span>
						<span className="text-xs text-green-600 dark:text-green-400">
							ID: {result.artifactId.substring(0, 8)}...
						</span>
					</div>
				</div>
				<Button
					onClick={handleViewArtifact}
					size="sm"
					variant="outline"
					className="border-green-300 hover:bg-green-100 dark:border-green-700 dark:hover:bg-green-900"
				>
					<Eye className="h-4 w-4 mr-1" />
					View
				</Button>
			</div>
		);
	}

	// Default parsing state
	return (
		<div className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg">
			<FileText className="h-4 w-4 text-gray-600 dark:text-gray-400" />
			<span className="text-sm text-gray-700 dark:text-gray-300">
				Processing artifact...
			</span>
		</div>
	);
}

export const CreateArtifactToolUI = memo(
	makeAssistantToolUI<
		{
			type: "text";
			title?: string;
			markdown: string;
		},
		CreateArtifactResult
	>({
		toolName: "createArtifact",
		render: (args) => {
			return CreateArtifactToolRender(args);
		},
	})
);
