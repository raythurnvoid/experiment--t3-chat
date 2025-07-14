import { useCanvasStore } from "../../stores/canvas-store";
import { Button } from "../ui/button";
import { FileText, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";

export function QuickStart() {
	const { createQuickStart } = useCanvasStore();

	return (
		<div
			className={cn(
				"QuickStart",
				"flex items-center justify-center h-full bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 overflow-auto"
			)}
		>
			<div
				className={cn(
					"QuickStart-container",
					"max-w-2xl mx-auto text-center p-8"
				)}
			>
				<div className={cn("QuickStart-header", "mb-8")}>
					<Sparkles
						className={cn(
							"QuickStart-header-icon",
							"h-16 w-16 mx-auto text-blue-600 dark:text-blue-400 mb-4"
						)}
					/>
					<h1
						className={cn(
							"QuickStart-header-title",
							"text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2"
						)}
					>
						Welcome to Canvas
					</h1>
					<p
						className={cn(
							"QuickStart-header-description",
							"text-lg text-gray-600 dark:text-gray-300"
						)}
					>
						Create text content with AI assistance
					</p>
				</div>

				<div className={cn("QuickStart-content", "space-y-6")}>
					<div className={cn("QuickStart-options", "flex justify-center")}>
						{/* Text option */}
						<div
							className={cn(
								"QuickStart-option",
								"QuickStart-option-text",
								"bg-white dark:bg-gray-800 rounded-lg border-2 border-gray-200 dark:border-gray-700 hover:border-blue-300 dark:hover:border-blue-600 transition-colors p-6 max-w-md"
							)}
						>
							<FileText
								className={cn(
									"QuickStart-option-icon",
									"h-12 w-12 text-blue-600 dark:text-blue-400 mx-auto mb-4"
								)}
							/>
							<h3
								className={cn(
									"QuickStart-option-title",
									"text-xl font-semibold mb-2 text-gray-900 dark:text-gray-100"
								)}
							>
								Start with Text
							</h3>
							<p
								className={cn(
									"QuickStart-option-description",
									"text-gray-600 dark:text-gray-300 mb-4"
								)}
							>
								Create documents, articles, or any text-based content with rich
								markdown formatting
							</p>
							<Button
								onClick={() => createQuickStart()}
								className={cn("QuickStart-option-button", "w-full")}
								variant="outline"
							>
								Create Text Document
							</Button>
						</div>
					</div>

					<div
						className={cn(
							"QuickStart-hint",
							"text-sm text-gray-500 dark:text-gray-400"
						)}
					>
						You can also start a conversation and let AI create content for you
					</div>
				</div>
			</div>
		</div>
	);
}
