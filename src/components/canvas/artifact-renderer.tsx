import { useCanvasStore } from "../../stores/canvas-store";
import { CodeRenderer } from "./code-renderer";
import { TextRenderer } from "./text-renderer";
import { useState } from "react";
import { Button } from "../ui/button";
import { ChevronLeft, ChevronRight, Edit3, Save, X } from "lucide-react";

export function ArtifactRenderer() {
	const {
		artifact,
		getCurrentArtifactContent,
		isEditing,
		setIsEditing,
		isStreaming,
	} = useCanvasStore();

	const [isHovering, setIsHovering] = useState(false);
	const currentContent = getCurrentArtifactContent();

	if (!artifact || !currentContent) {
		return (
			<div className="flex items-center justify-center h-full bg-gray-50">
				<div className="text-center">
					<div className="text-6xl mb-4">🎨</div>
					<h2 className="text-xl font-semibold text-gray-700 mb-2">
						Canvas is ready
					</h2>
					<p className="text-gray-500">
						Start a conversation to create content on the canvas
					</p>
				</div>
			</div>
		);
	}

	const isBackwardsDisabled =
		artifact.contents.length === 1 || currentContent.index === 1 || isStreaming;

	const isForwardDisabled =
		artifact.contents.length === 1 ||
		currentContent.index === artifact.contents.length ||
		isStreaming;

	return (
		<div className="relative w-full h-full bg-white">
			{/* Header */}
			<div className="border-b border-gray-200 px-4 py-3 bg-white">
				<div className="flex items-center justify-between">
					<div className="flex items-center space-x-3">
						<h3 className="text-lg font-semibold text-gray-900">
							{currentContent.title}
						</h3>
						<div className="flex items-center space-x-1 text-sm text-gray-500">
							<span>{currentContent.type === "code" ? "Code" : "Text"}</span>
							{currentContent.type === "code" && (
								<>
									<span>•</span>
									<span className="capitalize">{currentContent.language}</span>
								</>
							)}
						</div>
					</div>

					<div className="flex items-center space-x-2">
						{/* Version navigation */}
						{artifact.contents.length > 1 && (
							<div className="flex items-center space-x-1">
								<Button
									variant="outline"
									size="sm"
									disabled={isBackwardsDisabled}
									className="h-8 w-8 p-0"
								>
									<ChevronLeft className="h-4 w-4" />
								</Button>
								<span className="text-sm text-gray-500">
									{currentContent.index} / {artifact.contents.length}
								</span>
								<Button
									variant="outline"
									size="sm"
									disabled={isForwardDisabled}
									className="h-8 w-8 p-0"
								>
									<ChevronRight className="h-4 w-4" />
								</Button>
							</div>
						)}

						{/* Edit controls */}
						{isEditing ? (
							<div className="flex items-center space-x-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => setIsEditing(false)}
									className="h-8"
								>
									<X className="h-4 w-4 mr-1" />
									Cancel
								</Button>
								<Button
									size="sm"
									onClick={() => setIsEditing(false)}
									className="h-8"
								>
									<Save className="h-4 w-4 mr-1" />
									Save
								</Button>
							</div>
						) : (
							<Button
								variant="outline"
								size="sm"
								onClick={() => setIsEditing(true)}
								disabled={isStreaming}
								className="h-8"
							>
								<Edit3 className="h-4 w-4 mr-1" />
								Edit
							</Button>
						)}
					</div>
				</div>
			</div>

			{/* Content area */}
			<div
				className="h-[calc(100%-65px)] overflow-auto"
				onMouseEnter={() => setIsHovering(true)}
				onMouseLeave={() => setIsHovering(false)}
			>
				{currentContent.type === "code" ? (
					<CodeRenderer isHovering={isHovering} />
				) : (
					<TextRenderer isHovering={isHovering} />
				)}
			</div>
		</div>
	);
}
