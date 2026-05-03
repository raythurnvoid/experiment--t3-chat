import "./index.css";

import { createFileRoute } from "@tanstack/react-router";
import React, { Suspense, useRef } from "react";
import type { FileEditor_Props } from "@/components/file-editor/file-editor.tsx";
import { FilesSidebar } from "./-components/files-sidebar.tsx";
import { useEffect } from "react";
import { FileEditorSkeleton } from "@/components/file-editor/file-editor-skeleton.tsx";
import { z } from "zod";
import { zodValidator } from "@tanstack/zod-adapter";
import { app_convex_api, type app_convex_Doc, type app_convex_FunctionReturnType } from "@/lib/app-convex-client.ts";
import { files_editor_view_values, type files_EditorView } from "@/lib/files.ts";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { MyPanel, MyPanelGroup, MyPanelResizeHandle } from "@/components/my-resizable-panel-group.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

const FileEditor = React.lazy(() =>
	import("@/components/file-editor/file-editor.tsx").then((module) => ({
		default: module.FileEditor,
	})),
);

// #region route files folder listing
type RouteFilesFolderListing_ClassNames =
	| "RouteFilesFolderListing"
	| "RouteFilesFolderListing-title"
	| "RouteFilesFolderListing-list"
	| "RouteFilesFolderListing-item"
	| "RouteFilesFolderListing-empty";

type RouteFilesFolderListing_Props = {
	node: app_convex_Doc<"files_nodes">;
	treeItemsList: RouteFilesContent_Props["treeItemsList"];
};

function RouteFilesFolderListing(props: RouteFilesFolderListing_Props) {
	const { node, treeItemsList } = props;
	const childItems = (treeItemsList ?? [])
		.filter((item) => item.parentId === node._id && item.archiveOperationId === undefined)
		.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));

	return (
		<div className={"RouteFilesFolderListing" satisfies RouteFilesFolderListing_ClassNames}>
			<h1 className={"RouteFilesFolderListing-title" satisfies RouteFilesFolderListing_ClassNames}>{node.name}</h1>
			{childItems.length > 0 ? (
				<ul className={"RouteFilesFolderListing-list" satisfies RouteFilesFolderListing_ClassNames}>
					{childItems.map((child) => (
						<li
							key={child.index}
							className={"RouteFilesFolderListing-item" satisfies RouteFilesFolderListing_ClassNames}
						>
							<span>{child.kind === "folder" ? "Folder" : "File"}</span>
							<span>{child.title}</span>
						</li>
					))}
				</ul>
			) : (
				<p className={"RouteFilesFolderListing-empty" satisfies RouteFilesFolderListing_ClassNames}>No files yet</p>
			)}
		</div>
	);
}
// #endregion route files folder listing

// #region content
type RouteFilesContent_Props = {
	node: app_convex_Doc<"files_nodes"> | null | undefined;
	treeItemsList: app_convex_FunctionReturnType<typeof app_convex_api.files_nodes.get_tree_nodes_list> | undefined;
	editorMode: FileEditor_Props["editorMode"];
	onEditorModeChange: FileEditor_Props["onEditorModeChange"];
};

function RouteFilesContent(props: RouteFilesContent_Props) {
	const { node, treeItemsList, editorMode, onEditorModeChange } = props;
	if (!node) {
		return null;
	}

	if (node.kind === "folder") {
		return <RouteFilesFolderListing node={node} treeItemsList={treeItemsList} />;
	}

	return (
		<Suspense fallback={<FileEditorSkeleton />}>
			<FileEditor nodeId={node._id} editorMode={editorMode} onEditorModeChange={onEditorModeChange} />
		</Suspense>
	);
}
// #endregion content

// #region root
type RouteFiles_ClassNames =
	| "RouteFiles"
	| "RouteFiles-sidebar-panel"
	| "RouteFiles-main-panel"
	| "RouteFiles-editor-panel"
	| "RouteFiles-loading-text";

type RouteFiles_SidebarState = "closed" | "expanded";

function RouteFiles() {
	const navigate = Route.useNavigate();
	const searchParams = Route.useSearch();

	const { membershipId, workspaceName, projectName } = AppTenantProvider.useContext();

	const effectiveView: files_EditorView = searchParams.view ?? "rich_text_editor";

	const [filesSidebarOpen, setFilesSidebarOpen] = useAppLocalStorageStateValue("app_state::sidebar::files_open");
	const [savedPanelLayout, setMainPanelLayout] = useAppLocalStorageStateValue("app_state::resizable_panel::main_panel");
	const panelLayoutRef = useRef(savedPanelLayout ?? [24, 76]);
	const filesSidebarState: RouteFiles_SidebarState = filesSidebarOpen ? "expanded" : "closed";

	const [lastOpenNodeId, setLastOpenNodeId] = useAppLocalStorageStateValue(
		`app_state::files_last_open::scope::${membershipId}`,
	);
	const homeNodeId = useAppGlobalStore((state) => state.files_home_id_by_membership_id[membershipId] ?? "");

	const searchNodeId = searchParams.nodeId;

	const treeItemsList = useStableQuery(app_convex_api.files_nodes.get_tree_nodes_list, { membershipId });

	const resolvedNode = useStableQuery(
		app_convex_api.files_nodes.get,
		searchNodeId
			? {
					membershipId,
					nodeId: searchNodeId,
				}
			: "skip",
	);
	const resolvedNodeId = resolvedNode?._id ?? null;

	// Navigation function to update URL with selected file
	const navigateToFile = useFn((nodeId?: string) => {
		const view = effectiveView === "rich_text_editor" ? undefined : effectiveView;

		navigate({
			to: "/w/$workspaceName/$projectName/files",
			params: { workspaceName, projectName },
			search: { nodeId, view },
		}).catch((error) => {
			console.error("[FilesRoute.navigateToFile] Error navigating to file", { error, nodeId, view });
		});
	});

	const navigateToView = useFn<RouteFilesContent_Props["onEditorModeChange"]>((nextView) => {
		const nodeId = searchNodeId ?? homeNodeId;
		const view = nextView === "rich_text_editor" ? undefined : nextView;
		navigate({
			to: "/w/$workspaceName/$projectName/files",
			params: { workspaceName, projectName },
			search: { nodeId, view },
		}).catch((error) => {
			console.error("[FilesRoute.navigateToView] Error navigating to view", { error, nodeId, view });
		});
	});

	const handleArchive = useFn<React.ComponentProps<typeof FilesSidebar>["onArchive"]>((itemId) => {
		// When a file is archived, clear selection if it was the selected one
		if (searchNodeId === itemId) {
			navigateToFile();
		}
	});

	const handlePrimaryAction = useFn<React.ComponentProps<typeof FilesSidebar>["onPrimaryAction"]>(
		(itemId, itemType) => {
			// Only navigate if it's not already selected
			if (searchNodeId !== itemId) {
				navigateToFile(itemId);
			}
		},
	);

	const handleCloseSidebar = useFn<React.ComponentProps<typeof FilesSidebar>["onClose"]>(() => {
		setFilesSidebarOpen(false);
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

	// If URL has no file id, restore last-open; otherwise default to home file.
	useEffect(() => {
		if (searchNodeId) {
			return;
		}

		if (lastOpenNodeId) {
			navigateToFile(lastOpenNodeId);
			return;
		}

		navigateToFile(homeNodeId);
	}, [homeNodeId, lastOpenNodeId, navigateToFile, searchNodeId]);

	// Persist the current URL file id as "last open" for next visits.
	useEffect(() => {
		if (!searchNodeId) {
			return;
		}

		setLastOpenNodeId(searchNodeId);
	}, [searchNodeId, setLastOpenNodeId]);

	// If a requested file id cannot be resolved, clear stale last-open and fall back to home file.
	useEffect(() => {
		if (!searchNodeId || resolvedNode === undefined || resolvedNode !== null) {
			return;
		}

		setLastOpenNodeId(null);
		navigateToFile(homeNodeId);
	}, [homeNodeId, navigateToFile, resolvedNode, searchNodeId, setLastOpenNodeId]);

	return (
		<MyPanelGroup
			className={"RouteFiles" satisfies RouteFiles_ClassNames}
			direction="horizontal"
			onLayout={handlePanelLayout}
		>
			<MyPanel
				defaultSize={savedPanelLayout?.[0] ?? 24}
				className={"RouteFiles-sidebar-panel" satisfies RouteFiles_ClassNames}
				isOpen={filesSidebarOpen}
				closeBehavior="unmount"
			>
				<FilesSidebar
					selectedNodeId={searchNodeId ?? null}
					view={effectiveView}
					onClose={handleCloseSidebar}
					onArchive={handleArchive}
					onPrimaryAction={handlePrimaryAction}
				/>
			</MyPanel>
			<MyPanelResizeHandle isOpen={filesSidebarOpen} closeBehavior="unmount" onDragging={handlePanelDragging} />
			<MyPanel
				defaultSize={filesSidebarState === "closed" ? 100 : (savedPanelLayout?.[1] ?? 76)}
				minSize={40}
				className={"RouteFiles-main-panel" satisfies RouteFiles_ClassNames}
			>
				{resolvedNodeId ? (
					<RouteFilesContent
						node={resolvedNode}
						treeItemsList={treeItemsList}
						editorMode={effectiveView}
						onEditorModeChange={navigateToView}
					/>
				) : searchNodeId ? (
					<div className={"RouteFiles-loading-text" satisfies RouteFiles_ClassNames}>Loading...</div>
				) : null}
			</MyPanel>
		</MyPanelGroup>
	);
}

const Route = createFileRoute("/w/$workspaceName/$projectName/files/")({
	component: RouteFiles,
	validateSearch: zodValidator(
		z.object({
			nodeId: z.string().optional().catch(undefined),
			view: z.enum(files_editor_view_values).optional().catch(undefined),
		}),
	),
});

export { Route };
// #endregion root
