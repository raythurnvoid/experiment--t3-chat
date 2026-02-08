import "./index.css";

import React, { Suspense } from "react";
import type { PageEditor_Props } from "../../components/page-editor/page-editor.tsx";
import { PagesSidebar, type PagesSidebar_Props } from "./-components/pages-sidebar.tsx";
import { Panel, PanelGroup } from "react-resizable-panels";
import { useState, useEffect, useRef } from "react";
import { Button } from "../../components/ui/button.tsx";
import { PageEditorSkeleton } from "../../components/page-editor/page-editor-skeleton.tsx";
import { PanelLeft, Menu } from "lucide-react";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { useMutation } from "convex/react";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { pages_editor_view_values, type pages_EditorView } from "@/lib/pages.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/utils.ts";
import { useStableQuery } from "../../hooks/convex-hooks.ts";
import { useAppLocalStorageState } from "@/lib/app-local-storage-state.ts";

const PageEditor = React.lazy(() =>
	import("../../components/page-editor/page-editor.tsx").then((module) => ({
		default: module.PageEditor,
	})),
);

export const Route = createFileRoute({
	component: RoutePages,
	validateSearch: zodValidator(
		z.object({
			pageId: z.string().optional().catch(undefined),
			view: z.enum(pages_editor_view_values).optional().catch(undefined),
		}),
	),
});

type RoutePagesContent_Props = {
	pageId: app_convex_Id<"pages"> | null | undefined;
	editorMode: PageEditor_Props["editorMode"];
	onEditorModeChange: PageEditor_Props["onEditorModeChange"];
};

function RoutePagesContent(props: RoutePagesContent_Props) {
	const { pageId, editorMode, onEditorModeChange } = props;

	return (
		<Suspense fallback={<PageEditorSkeleton />}>
			{pageId && (
				<div className={"RoutePages-editor-wrapper" satisfies RoutePages_ClassNames}>
					<PageEditor pageId={pageId} editorMode={editorMode} onEditorModeChange={onEditorModeChange} />
				</div>
			)}
		</Suspense>
	);
}

type RoutePages_ClassNames =
	| "RoutePages-content-area"
	| "RoutePages-main-content"
	| "RoutePages-editor-panel"
	| "RoutePages-editor-panel-controls"
	| "RoutePages-editor-panel-hamburger-button"
	| "RoutePages-editor-panel-expand-button"
	| "RoutePages-editor-content"
	| "RoutePages-loading-text"
	| "RoutePages-editor-wrapper";

function RoutePages() {
	const navigate = Route.useNavigate();
	const searchParams = Route.useSearch();
	const { toggleSidebar } = MainAppSidebar.useSidebar();

	const effectiveView: pages_EditorView = searchParams.view ?? "rich_text_editor";

	const [pagesSidebarState, setPagesSidebarState] = useState<PagesSidebar_Props["state"]>("expanded");

	const pagesLastOpen = useAppLocalStorageState((state) => state.pages_last_open);

	const skipHomepageFallbackRef = useRef(false);

	// Ensure homepage exists and get its ID
	const ensureHomepage = useMutation(app_convex_api.ai_docs_temp.ensure_home_page);
	const [homepageId, setHomepageId] = useState<string | null>(null);

	const [clientGeneratePageId, setClientGeneratePageId] = useState<string | null>(null);
	const effectivePageId = useStableQuery(
		app_convex_api.ai_docs_temp.get_page_id_from_client_generated_id,
		clientGeneratePageId
			? {
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					clientGeneratedId: clientGeneratePageId,
				}
			: "skip",
	);
	const resolvedPageId = clientGeneratePageId ? effectivePageId : null;

	useEffect(() => {
		const nextClientGeneratePageId =
			searchParams.pageId ?? pagesLastOpen ?? (skipHomepageFallbackRef.current ? null : homepageId);

		setClientGeneratePageId((prev) => (prev === nextClientGeneratePageId ? prev : nextClientGeneratePageId));
	}, [homepageId, pagesLastOpen, searchParams.pageId]);

	useEffect(() => {
		if (!searchParams.pageId && !pagesLastOpen && homepageId === null && !skipHomepageFallbackRef.current) {
			ensureHomepage({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
			})
				.then((result) => setHomepageId(result.page_id))
				.catch(console.error);
		}
	}, [ensureHomepage, homepageId, pagesLastOpen, searchParams.pageId]);

	// Navigation function to update URL with selected page
	const navigateToPage = (pageId?: string) => {
		const view = effectiveView === "rich_text_editor" ? undefined : effectiveView;
		navigate({
			to: "/pages",
			search: { pageId, view },
		}).catch(console.error);
	};

	const navigateToView = (nextView: pages_EditorView) => {
		const pageId = clientGeneratePageId ?? undefined;
		const view = nextView === "rich_text_editor" ? undefined : nextView;
		navigate({
			to: "/pages",
			search: { pageId, view },
		}).catch(console.error);
	};

	const handleArchive = (itemId: string) => {
		// When a page is archived, clear selection if it was the selected one
		if (effectivePageId === itemId) {
			navigateToPage();
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

	useEffect(() => {
		if (searchParams.pageId || !pagesLastOpen) {
			return;
		}

		navigateToPage(pagesLastOpen);
	}, [pagesLastOpen, searchParams.pageId]);

	useEffect(() => {
		if (!searchParams.pageId) {
			return;
		}

		useAppLocalStorageState.setState({ pages_last_open: searchParams.pageId });
	}, [searchParams.pageId]);

	useEffect(() => {
		if (!searchParams.pageId) {
			return;
		}

		if (resolvedPageId !== null) {
			return;
		}

		skipHomepageFallbackRef.current = true;
		useAppLocalStorageState.setState({ pages_last_open: null });
		navigateToPage();
	}, [resolvedPageId, searchParams.pageId]);

	return (
		<div className={"RoutePages-content-area" satisfies RoutePages_ClassNames}>
			{/* Pages Sidebar - positioned between main sidebar and content with animation */}
			<PagesSidebar
				selectedPageId={clientGeneratePageId}
				view={effectiveView}
				onClose={handleCloseSidebar}
				onArchive={handleArchive}
				onPrimaryAction={handlePrimaryAction}
				state={pagesSidebarState}
			/>
			{resolvedPageId ? (
				// Main Content Area - takes remaining space
				<div className={"RoutePages-main-content" satisfies RoutePages_ClassNames}>
					<PanelGroup direction="horizontal" className="h-full">
						{/* Pages Editor Panel */}
						<Panel defaultSize={100} minSize={50}>
							<div className={"RoutePages-editor-panel" satisfies RoutePages_ClassNames}>
								{pagesSidebarState === "closed" && (
									<div className={"RoutePages-editor-panel-controls" satisfies RoutePages_ClassNames}>
										{/* Hamburger Menu - mobile only */}
										<Button
											variant="outline"
											size="sm"
											onClick={toggleSidebar}
											className={"RoutePages-editor-panel-hamburger-button" satisfies RoutePages_ClassNames}
										>
											<Menu className="h-4 w-4" />
										</Button>

										{/* Open Pages Sidebar button */}
										<Button
											variant="outline"
											size="sm"
											onClick={handleOpenSidebar}
											className={"RoutePages-editor-panel-expand-button" satisfies RoutePages_ClassNames}
										>
											<PanelLeft className="h-4 w-4" />
										</Button>
									</div>
								)}
								<div className={"RoutePages-editor-content" satisfies RoutePages_ClassNames}>
									<RoutePagesContent
										pageId={resolvedPageId}
										editorMode={effectiveView}
										onEditorModeChange={navigateToView}
									/>
								</div>
							</div>
						</Panel>
					</PanelGroup>
				</div>
			) : clientGeneratePageId ? (
				<div className={"RoutePages-loading-text" satisfies RoutePages_ClassNames}>Loading...</div>
			) : (
				<div className={"RoutePages-loading-text" satisfies RoutePages_ClassNames}>Select a page to get started.</div>
			)}
		</div>
	);
}
