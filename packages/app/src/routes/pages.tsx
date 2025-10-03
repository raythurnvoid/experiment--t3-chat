import React from "react";
import { DocsSidebarV2, type DocsSidebarV2_Props } from "../components/docs-sidebar-v2.tsx";
import { Panel, PanelGroup } from "react-resizable-panels";
import { useState, useEffect } from "react";
import { Button } from "../components/ui/button.tsx";
import { PanelLeft, Menu } from "lucide-react";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { useMutation } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import "./pages.css";

export const Route = createFileRoute({
	component: Pages,
	validateSearch: zodValidator(
		z.object({
			pageId: z.string().optional().catch(undefined),
		}),
	),
});

const PageRichTextEditor = React.lazy(() =>
	import("../components/page-rich-text-editor/page-rich-text-editor.tsx").then((module) => ({
		default: module.PageRichTextEditor,
	})),
);

type PagesContent_Props = {
	pageId: string | null | undefined;
};

function PagesContent(props: PagesContent_Props) {
	const { pageId } = props;

	if (!pageId) {
		return <div className="Pages-loading-text">Loading homepage…</div>;
	}

	return (
		<React.Suspense fallback={<div className="Pages-loading-text">Loading editor…</div>}>
			<div className="Pages-editor-wrapper">
				<PageRichTextEditor pageId={pageId} />
			</div>
		</React.Suspense>
	);
}

function Pages() {
	const navigate = Route.useNavigate();
	const searchParams = Route.useSearch();
	const { toggleSidebar } = MainAppSidebar.useSidebar();

	const [pagesSidebarState, setPagesSidebarState] = useState<DocsSidebarV2_Props["state"]>("expanded");

	// Ensure homepage exists and get its ID
	const ensureHomepage = useMutation(app_convex_api.ai_docs_temp.ensure_home_page);
	const [homepageId, setHomepageId] = useState<string | null>(null);

	useEffect(() => {
		if (!searchParams.pageId && homepageId === null) {
			ensureHomepage({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
			})
				.then((result) => setHomepageId(result.page_id))
				.catch(console.error);
		}
	}, []);

	const effectivePageId = searchParams.pageId ?? homepageId ?? undefined;

	// Navigation function to update URL with selected page
	const navigateToPage = (pageId: string | null) => {
		navigate({
			to: "/pages",
			search: { pageId },
		}).catch(console.error);
	};

	const handleAddChild = (parentId: string, newItemId: string) => {
		// When a new page is created, open it
		navigateToPage(newItemId);
	};

	const handleArchive = (itemId: string) => {
		// When a page is archived, clear selection if it was the selected one
		if (effectivePageId === itemId) {
			navigateToPage(null);
		}
	};

	const handlePrimaryAction = (itemId: string, itemType: string) => {
		// Only navigate if it's not already selected
		if (effectivePageId !== itemId) {
			navigateToPage(itemId);
		}
	};

	const handleCloseSidebar = () => {
		setPagesSidebarState("closed");
	};

	const handleOpenSidebar = () => {
		setPagesSidebarState("expanded");
	};

	return (
		<div className="Pages-content-area">
			{/* Pages Sidebar - positioned between main sidebar and content with animation */}
			<DocsSidebarV2
				selectedDocId={effectivePageId}
				onClose={handleCloseSidebar}
				onAddChild={handleAddChild}
				onArchive={handleArchive}
				onPrimaryAction={handlePrimaryAction}
				state={pagesSidebarState}
			/>

			{/* Main Content Area - takes remaining space */}
			<div className="Pages-main-content">
				<PanelGroup direction="horizontal" className="h-full">
					{/* Pages Editor Panel */}
					<Panel defaultSize={100} minSize={50}>
						<div className="Pages-editor-panel">
							{pagesSidebarState === "closed" && (
								<div className="Pages-editor-panel-controls">
									{/* Hamburger Menu - mobile only */}
									<Button
										variant="outline"
										size="sm"
										onClick={toggleSidebar}
										className="Pages-editor-panel-hamburger-button"
									>
										<Menu className="h-4 w-4" />
									</Button>

									{/* Open Pages Sidebar button */}
									<Button
										variant="outline"
										size="sm"
										onClick={handleOpenSidebar}
										className="Pages-editor-panel-expand-button"
									>
										<PanelLeft className="h-4 w-4" />
									</Button>
								</div>
							)}
							<div className="Pages-editor-content">
								<PagesContent pageId={effectivePageId} />
							</div>
						</div>
					</Panel>
				</PanelGroup>
			</div>
		</div>
	);
}
