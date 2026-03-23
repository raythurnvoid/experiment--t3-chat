import "./index.css";

import React, { Suspense, useRef } from "react";
import type { PageEditor_Props } from "@/components/page-editor/page-editor.tsx";
import { PagesSidebar } from "./-components/pages-sidebar.tsx";
import { useEffect } from "react";
import { PageEditorSkeleton } from "@/components/page-editor/page-editor-skeleton.tsx";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { pages_editor_view_values, type pages_EditorView } from "@/lib/pages.ts";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { MyPanel, MyPanelGroup, MyPanelResizeHandle } from "@/components/my-resizable-panel-group.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

const PageEditor = React.lazy(() =>
	import("@/components/page-editor/page-editor.tsx").then((module) => ({
		default: module.PageEditor,
	})),
);

const Route = createFileRoute({
	component: RoutePages,
	validateSearch: zodValidator(
		z.object({
			pageId: z.string().optional().catch(undefined),
			view: z.enum(pages_editor_view_values).optional().catch(undefined),
		}),
	),
});

export { Route };

type RoutePagesContent_Props = {
	pageId: app_convex_Id<"pages"> | null | undefined;
	editorMode: PageEditor_Props["editorMode"];
	onEditorModeChange: PageEditor_Props["onEditorModeChange"];
};

function RoutePagesContent(props: RoutePagesContent_Props) {
	const { pageId, editorMode, onEditorModeChange } = props;

	return (
		<Suspense fallback={<PageEditorSkeleton />}>
			{pageId && <PageEditor pageId={pageId} editorMode={editorMode} onEditorModeChange={onEditorModeChange} />}
		</Suspense>
	);
}

type RoutePages_ClassNames =
	| "RoutePages"
	| "RoutePages-sidebar-panel"
	| "RoutePages-main-panel"
	| "RoutePages-editor-panel"
	| "RoutePages-loading-text";

type RoutePages_SidebarState = "closed" | "expanded";

function RoutePages() {
	const navigate = Route.useNavigate();
	const searchParams = Route.useSearch();

	const { membershipId, workspaceId, workspaceName, projectId, projectName } = AppTenantProvider.useContext();

	const effectiveView: pages_EditorView = searchParams.view ?? "rich_text_editor";

	const [pagesSidebarOpen, setPagesSidebarOpen] = useAppLocalStorageStateValue("app_state::sidebar::pages_open");
	const [savedPanelLayout, setMainPanelLayout] = useAppLocalStorageStateValue("app_state::resizable_panel::main_panel");
	const panelLayoutRef = useRef(savedPanelLayout ?? [24, 76]);
	const pagesSidebarState: RoutePages_SidebarState = pagesSidebarOpen ? "expanded" : "closed";

	const [lastOpenPageId, setLastOpenPageId] = useAppLocalStorageStateValue(
		`app_state::pages_last_open::scope::${workspaceId}::${projectId}`,
	);
	const homePageId = useAppGlobalStore((state) => state.pages_home_id_by_membership_id[membershipId] ?? "");

	const searchPageId = searchParams.pageId;

	const resolvedPage = useStableQuery(
		app_convex_api.ai_docs_temp.get,
		searchPageId
			? {
					membershipId,
					pageId: searchPageId,
				}
			: "skip",
	);
	const resolvedPageId = resolvedPage?._id ?? null;

	// Navigation function to update URL with selected page
	const navigateToPage = useFn((pageId?: string) => {
		const view = effectiveView === "rich_text_editor" ? undefined : effectiveView;

		navigate({
			to: "/w/$workspaceName/$projectName/pages",
			params: { workspaceName, projectName },
			search: { pageId, view },
		}).catch((error) => {
			console.error("[PagesRoute.navigateToPage] Error navigating to page", { error, pageId, view });
		});
	});

	const navigateToView = useFn<RoutePagesContent_Props["onEditorModeChange"]>((nextView) => {
		const pageId = searchPageId ?? homePageId;
		const view = nextView === "rich_text_editor" ? undefined : nextView;
		navigate({
			to: "/w/$workspaceName/$projectName/pages",
			params: { workspaceName, projectName },
			search: { pageId, view },
		}).catch((error) => {
			console.error("[PagesRoute.navigateToView] Error navigating to view", { error, pageId, view });
		});
	});

	const handleArchive = useFn<React.ComponentProps<typeof PagesSidebar>["onArchive"]>((itemId) => {
		// When a page is archived, clear selection if it was the selected one
		if (searchPageId === itemId) {
			navigateToPage();
		}
	});

	const handlePrimaryAction = useFn<React.ComponentProps<typeof PagesSidebar>["onPrimaryAction"]>(
		(itemId, itemType) => {
			// Only navigate if it's not already selected
			if (searchPageId !== itemId) {
				navigateToPage(itemId);
			}
		},
	);

	const handleCloseSidebar = useFn<React.ComponentProps<typeof PagesSidebar>["onClose"]>(() => {
		setPagesSidebarOpen(false);
	});

	const handlePanelLayout = useFn<NonNullable<React.ComponentProps<typeof MyPanelGroup>["onLayout"]>>((layout) => {
		panelLayoutRef.current = layout;
	});

	const handlePanelDragging = useFn<NonNullable<React.ComponentProps<typeof MyPanelResizeHandle>["onDragging"]>>(
		(isDragging) => {
			if (isDragging) {
				return;
			}

			setMainPanelLayout(panelLayoutRef.current);
		},
	);

	// If URL has no page id, restore last-open; otherwise default to homepage.
	useEffect(() => {
		if (searchPageId) {
			return;
		}

		if (lastOpenPageId) {
			navigateToPage(lastOpenPageId);
			return;
		}

		navigateToPage(homePageId);
	}, [homePageId, lastOpenPageId, navigateToPage, searchPageId]);

	// Persist the current URL page id as "last open" for next visits.
	useEffect(() => {
		if (!searchPageId) {
			return;
		}

		setLastOpenPageId(searchPageId);
	}, [searchPageId, setLastOpenPageId]);

	// If a requested page id cannot be resolved, clear stale last-open and fall back to homepage.
	useEffect(() => {
		if (!searchPageId || resolvedPage === undefined || resolvedPage !== null) {
			return;
		}

		setLastOpenPageId(null);
		navigateToPage(homePageId);
	}, [homePageId, navigateToPage, resolvedPage, searchPageId, setLastOpenPageId]);

	return (
		<MyPanelGroup
			className={"RoutePages" satisfies RoutePages_ClassNames}
			direction="horizontal"
			onLayout={handlePanelLayout}
		>
			<MyPanel
				defaultSize={savedPanelLayout?.[0] ?? 24}
				className={"RoutePages-sidebar-panel" satisfies RoutePages_ClassNames}
				isOpen={pagesSidebarOpen}
				closeBehavior="unmount"
			>
				<PagesSidebar
					selectedPageId={searchPageId ?? null}
					view={effectiveView}
					onClose={handleCloseSidebar}
					onArchive={handleArchive}
					onPrimaryAction={handlePrimaryAction}
				/>
			</MyPanel>
			<MyPanelResizeHandle isOpen={pagesSidebarOpen} closeBehavior="unmount" onDragging={handlePanelDragging} />
			<MyPanel
				defaultSize={pagesSidebarState === "closed" ? 100 : (savedPanelLayout?.[1] ?? 76)}
				minSize={40}
				className={"RoutePages-main-panel" satisfies RoutePages_ClassNames}
			>
				{resolvedPageId ? (
					<RoutePagesContent pageId={resolvedPageId} editorMode={effectiveView} onEditorModeChange={navigateToView} />
				) : searchPageId ? (
					<div className={"RoutePages-loading-text" satisfies RoutePages_ClassNames}>Loading...</div>
				) : null}
			</MyPanel>
		</MyPanelGroup>
	);
}
