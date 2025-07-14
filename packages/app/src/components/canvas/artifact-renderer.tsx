import { useCanvasStore } from "../../stores/canvas-store";
import { useThread } from "@assistant-ui/react";
import { TextRenderer } from "./text-renderer";
import { useState } from "react";
import { Button } from "../ui/button";
import { ChevronLeft, ChevronRight, Edit3, Save, X } from "lucide-react";
import { cn } from "../../lib/utils";

export function ArtifactRenderer() {
	const { getCurrentArtifact, getCurrentArtifactContent, isEditing, setIsEditing, currentArtifactId } =
		useCanvasStore();

	const thread = useThread();
	const isStreaming = thread.isRunning;

	const [isHovering, setIsHovering] = useState(false);
	const artifact = getCurrentArtifact();
	const currentContent = getCurrentArtifactContent();

	if (!artifact || !currentContent || !currentArtifactId) {
		return (
			<div
				className={cn("ArtifactRenderer-empty", "flex items-center justify-center h-full bg-gray-50 dark:bg-gray-900")}
			>
				<div className={cn("ArtifactRenderer-empty-content", "text-center")}>
					<div className={cn("ArtifactRenderer-empty-icon", "text-6xl mb-4")}>📝</div>
					<h2
						className={cn(
							"ArtifactRenderer-empty-title",
							"text-xl font-semibold text-gray-700 dark:text-gray-300 mb-2",
						)}
					>
						Canvas is ready
					</h2>
					<p className={cn("ArtifactRenderer-empty-description", "text-gray-500 dark:text-gray-400")}>
						Start a conversation to create content on the canvas
					</p>
				</div>
			</div>
		);
	}

	const isBackwardsDisabled = artifact.contents.length === 1 || currentContent.index === 1 || isStreaming;

	const isForwardDisabled =
		artifact.contents.length === 1 || currentContent.index === artifact.contents.length || isStreaming;

	return (
		<div className={cn("ArtifactRenderer", "relative w-full h-full bg-white dark:bg-gray-900 flex flex-col")}>
			{/* Header */}
			<div
				className={cn(
					"ArtifactRenderer-header",
					"border-b border-gray-200 dark:border-gray-700 px-4 py-3 bg-white dark:bg-gray-800",
				)}
			>
				<div className={cn("ArtifactRenderer-header-content", "flex items-center justify-between")}>
					<div className={cn("ArtifactRenderer-header-info", "flex items-center space-x-3")}>
						<h3
							className={cn("ArtifactRenderer-header-title", "text-lg font-semibold text-gray-900 dark:text-gray-100")}
						>
							{artifact.title}
						</h3>
						<div
							className={cn(
								"ArtifactRenderer-header-meta",
								"flex items-center space-x-1 text-sm text-gray-500 dark:text-gray-400",
							)}
						>
							<span>Text</span>
							<span>•</span>
							<span>ID: {artifact.id.substring(0, 8)}...</span>
						</div>
					</div>

					<div className={cn("ArtifactRenderer-header-controls", "flex items-center space-x-2")}>
						{/* Version navigation */}
						{artifact.contents.length > 1 && (
							<div className={cn("ArtifactRenderer-nav", "flex items-center space-x-1")}>
								<Button
									variant="outline"
									size="sm"
									disabled={isBackwardsDisabled}
									className={cn("ArtifactRenderer-nav-prev", "h-8 w-8 p-0")}
								>
									<ChevronLeft className="h-4 w-4" />
								</Button>
								<span className={cn("ArtifactRenderer-nav-indicator", "text-sm text-gray-500 dark:text-gray-400")}>
									{currentContent.index} / {artifact.contents.length}
								</span>
								<Button
									variant="outline"
									size="sm"
									disabled={isForwardDisabled}
									className={cn("ArtifactRenderer-nav-next", "h-8 w-8 p-0")}
								>
									<ChevronRight className="h-4 w-4" />
								</Button>
							</div>
						)}

						{/* Edit controls */}
						{isEditing ? (
							<div className={cn("ArtifactRenderer-edit-controls", "flex items-center space-x-2")}>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setIsEditing(false)}
									className={cn("ArtifactRenderer-cancel-button", "h-8")}
								>
									<X className="h-4 w-4 mr-1" />
									Cancel
								</Button>
								<Button
									size="sm"
									onClick={() => setIsEditing(false)}
									className={cn("ArtifactRenderer-save-button", "h-8")}
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
								className={cn("ArtifactRenderer-edit-button", "h-8")}
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
				className={cn("ArtifactRenderer-content", "flex-1 overflow-auto")}
				onMouseEnter={() => setIsHovering(true)}
				onMouseLeave={() => setIsHovering(false)}
			>
				<TextRenderer isHovering={isHovering} />
			</div>
		</div>
	);
}
