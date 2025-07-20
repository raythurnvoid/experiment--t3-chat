import { useState } from "react";
import { Button } from "../components/ui/button";
import { PanelLeft } from "lucide-react";
import { cn } from "../lib/utils";
import { DocsSidebar } from "@/components/docs-sidebar";

export const Route = createFileRoute({
	component: Docs,
});

function Docs() {
	const [docs_sidebar_open, set_docs_sidebar_open] = useState(true);

	return (
		<div className={cn("Docs-content-area", "flex h-full w-full")}>
			{/* Docs Sidebar - positioned between main sidebar and content with animation */}
			<div
				className={cn(
					"Docs-sidebar-wrapper",
					"h-full flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out",
					docs_sidebar_open ? "w-80 opacity-100" : "w-0 opacity-0",
				)}
			>
				{docs_sidebar_open && <DocsSidebar onClose={() => set_docs_sidebar_open(false)} />}
			</div>

			{/* Main Content Area - takes remaining space */}
			<div className={cn("Docs-main-content", "flex h-full min-w-0 flex-1 flex-col")}>
				{/* Main editor area */}
				<div
					className={cn(
						"Docs-editor-panel",
						"relative flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-gray-900",
					)}
				>
					{!docs_sidebar_open && (
						<div className={cn("Docs-editor-panel-controls", "absolute top-4 left-4 z-10")}>
							<Button
								variant="outline"
								size="sm"
								onClick={() => set_docs_sidebar_open(true)}
								className={cn("Docs-editor-panel-expand-button", "h-8 w-8 p-0")}
							>
								<PanelLeft className="h-4 w-4" />
							</Button>
						</div>
					)}
					<div className={cn("Docs-editor-content", "flex min-h-0 flex-1 overflow-hidden p-8")}>
						{/* Placeholder for Tiptap Editor */}
						<div className={cn("Docs-editor-placeholder", "flex flex-1 items-center justify-center")}>
							<div className="text-center">
								<h2 className="mb-2 text-2xl font-semibold text-muted-foreground">Document Editor</h2>
								<p className="text-muted-foreground">Tiptap editor will be integrated here</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	)
}
