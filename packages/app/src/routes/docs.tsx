import React from "react";
import { DocsSidebar } from "../components/docs-sidebar-v2.tsx";
import { Panel, PanelGroup } from "react-resizable-panels";
import { useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { PanelLeft, Menu } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";

export const Route = createFileRoute({
	component: Docs,
	validateSearch: zodValidator(
		z.object({
			docId: z.string().optional().catch(undefined),
		}),
	),
});

const PageRichTextEditor = React.lazy(() =>
	import("../components/page-rich-text-editor/page-rich-text-editor.tsx").then((module) => ({
		default: module.PageRichTextEditor,
	})),
);

function DocsContent() {
	const searchParams = Route.useSearch();

	if (!searchParams.docId) {
		return <div>No document selected</div>;
	}

	return (
		<React.Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading editor…</div>}>
			<div className="h-full w-full">
				<PageRichTextEditor pageId={searchParams.docId} />
			</div>
		</React.Suspense>
	);
}

function Docs() {
	const navigate = Route.useNavigate();
	const searchParams = Route.useSearch();
	const { toggleSidebar } = MainAppSidebar.useSidebar();

	const [docsSidebarOpen, setDocsSidebarOpen] = useState(true);

	// Navigation function to update URL with selected document
	const navigateToDocument = (docId: string | null) => {
		navigate({
			to: "/docs",
			search: { docId },
		}).catch(console.error);
	};

	const handleAddChild = (parentId: string, newItemId: string) => {
		// When a new document is created, open it
		navigateToDocument(newItemId);
	};

	const handleArchive = (itemId: string) => {
		// When a document is archived, clear selection if it was the selected one
		if (searchParams.docId === itemId) {
			navigateToDocument(null);
		}
	};

	const handlePrimaryAction = (itemId: string, itemType: string) => {
		// Only navigate if it's not already selected
		if (searchParams.docId !== itemId) {
			navigateToDocument(itemId);
		}
	};

	const handleClose = () => {
		setDocsSidebarOpen(false);
	};

	return (
		<div className={cn("Docs-content-area", "flex h-full w-full")}>
			{/* Docs Sidebar - positioned between main sidebar and content with animation */}
			<div
				className={cn(
					"Docs-sidebar-wrapper",
					"h-full flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out",
					docsSidebarOpen ? "w-80 opacity-100" : "w-0 opacity-0",
				)}
			>
				<DocsSidebar
					selectedDocId={searchParams.docId}
					onClose={handleClose}
					onAddChild={handleAddChild}
					onArchive={handleArchive}
					onPrimaryAction={handlePrimaryAction}
				/>
			</div>

			{/* Main Content Area - takes remaining space */}
			<div className={cn("Docs-main-content", "flex h-full min-w-0 flex-1 flex-col")}>
				<PanelGroup direction="horizontal" className="h-full">
					{/* Docs Editor Panel */}
					<Panel defaultSize={100} minSize={50}>
						<div className={cn("Docs-editor-panel", "relative flex h-full flex-col overflow-hidden bg-background")}>
							{!docsSidebarOpen && (
								<div className={cn("Docs-editor-panel-controls", "absolute top-4 left-4 z-10 flex items-center gap-2")}>
									{/* Hamburger Menu - mobile only */}
									<Button
										variant="outline"
										size="sm"
										onClick={toggleSidebar}
										className={cn("Docs-editor-panel-hamburger-button", "h-8 w-8 p-0 lg:hidden")}
									>
										<Menu className="h-4 w-4" />
									</Button>

									{/* Open Docs Sidebar button */}
									<Button
										variant="outline"
										size="sm"
										onClick={() => setDocsSidebarOpen(true)}
										className={cn("Docs-editor-panel-expand-button", "h-8 w-8 p-0")}
									>
										<PanelLeft className="h-4 w-4" />
									</Button>
								</div>
							)}
							<div className={cn("Docs-editor-content", "flex min-h-0 flex-1 overflow-hidden")}>
								<DocsContent />
							</div>
						</div>
					</Panel>
				</PanelGroup>
			</div>
		</div>
	);
}
