import "./file-node-view.css";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { FileEditorSidebar } from "@/components/file-editor/file-editor-sidebar/file-editor-sidebar.tsx";
import { FileEditorPresence } from "@/components/file-editor/file-editor-presence.tsx";
import {
	FileEditor,
	FileEditorPresenceSupplier,
	type FileEditor_Mode,
	type FileEditor_Layout,
	type FileEditor_NavigatePendingUpdates,
	type FileEditor_OnlineUser,
} from "@/components/file-editor/file-editor.tsx";
import { FilesSidebarToggle } from "@/components/files-sidebar-toggle.tsx";
import { MainAppHeaderBillingIndicator } from "@/components/main-app-header-billing-indicator.tsx";
import { MainAppSidebarToggle } from "@/components/main-app-sidebar-toggle.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyButtonGroup, MyButtonGroupItem } from "@/components/my-button-group.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyLink, MyLinkIcon } from "@/components/my-link.tsx";
import { MyPanel, MyPanelGroup, MyPanelResizeHandle } from "@/components/my-resizable-panel-group.tsx";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	app_convex_api,
	type app_convex_Doc,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { format_relative_time } from "@/lib/date.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import { files_ROOT_ID, type files_EditorView, type files_TreeItem } from "@/lib/files.ts";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import { cn } from "@/lib/utils.ts";
import { useMutation } from "convex/react";
import { BookOpen, FilePlus, FileText, Folder, Home } from "lucide-react";
import React, { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FilesSidebar } from "./files-sidebar.tsx";

function get_breadcrumb_path(treeItemsList: files_TreeItem[] | undefined, nodeId: string | null | undefined) {
	if (!treeItemsList || !nodeId || nodeId === files_ROOT_ID) {
		return [];
	}

	const path: files_TreeItem[] = [];
	let currentId = nodeId;
	const itemsMap = new Map<string, files_TreeItem>();

	for (const item of treeItemsList) {
		itemsMap.set(item.index, item);
		if (item._id === nodeId) {
			currentId = item.index;
		}
	}

	while (currentId !== files_ROOT_ID) {
		const item = itemsMap.get(currentId);
		if (!item) {
			break;
		}

		path.unshift(item);
		currentId = item.parentId;
	}

	return path;
}

// #region header
type FileNodeViewHeader_ClassNames =
	| "FileNodeViewHeader"
	| "FileNodeViewHeader-start"
	| "FileNodeViewHeader-sidebars-actions"
	| "FileNodeViewHeader-breadcrumb"
	| "FileNodeViewHeader-breadcrumb-home"
	| "FileNodeViewHeader-breadcrumb-segment"
	| "FileNodeViewHeader-breadcrumb-segment-current"
	| "FileNodeViewHeader-breadcrumb-separator"
	| "FileNodeViewHeader-switch-group";

type FileNodeViewHeader_Props = {
	selectedNodeId: string | null | undefined;
	treeItemsList: app_convex_FunctionReturnType<typeof app_convex_api.files_nodes.get_tree_nodes_list> | undefined;
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	showFileControls: boolean;
	onlineUsers: FileEditor_OnlineUser[];
	onEditorModeChange: (mode: FileEditor_Mode) => void;
};

const FileNodeViewHeader = memo(function FileNodeViewHeader(props: FileNodeViewHeader_Props) {
	const {
		selectedNodeId,
		treeItemsList,
		editorMode,
		filesSidebarOpen,
		showFileControls,
		onlineUsers,
		onEditorModeChange,
	} = props;

	const { workspaceName, projectName } = AppTenantProvider.useContext();

	const breadcrumbPath = get_breadcrumb_path(treeItemsList, selectedNodeId);

	const handleEditorModeChange = useFn((mode: string) => {
		onEditorModeChange(mode as FileEditor_Mode);
	});

	return (
		<div className={cn("FileNodeViewHeader" satisfies FileNodeViewHeader_ClassNames)}>
			<div className={cn("FileNodeViewHeader-start" satisfies FileNodeViewHeader_ClassNames)}>
				{!filesSidebarOpen && (
					<div className={cn("FileNodeViewHeader-sidebars-actions" satisfies FileNodeViewHeader_ClassNames)}>
						<MainAppSidebarToggle variant="ghost-highlightable" tooltip="Open app sidebar" />
						<FilesSidebarToggle variant="ghost-highlightable" tooltip="Open files sidebar" />
					</div>
				)}

				<ol className={cn("FileNodeViewHeader-breadcrumb" satisfies FileNodeViewHeader_ClassNames)}>
					{selectedNodeId && breadcrumbPath.length > 0 ? (
						<>
							<li>
								<MyLink
									aria-label="Home"
									className={cn("FileNodeViewHeader-breadcrumb-home" satisfies FileNodeViewHeader_ClassNames)}
									to="/w/$workspaceName/$projectName/files"
									params={{ workspaceName, projectName }}
									search={{ nodeId: files_ROOT_ID, view: editorMode }}
									variant="button-icon-ghost-highlightable"
									tooltip="Home"
								>
									<MyLinkIcon aria-hidden>
										<Home />
									</MyLinkIcon>
								</MyLink>
							</li>
							<span>/</span>
							{breadcrumbPath.map((item, index) => {
								const isCurrentNode = index === breadcrumbPath.length - 1;
								return (
									<React.Fragment key={item.index}>
										{isCurrentNode ? (
											<li
												className={cn(
													"FileNodeViewHeader-breadcrumb-segment-current" satisfies FileNodeViewHeader_ClassNames,
												)}
											>
												{item.title}
											</li>
										) : (
											<li>
												<MyLink
													className={cn(
														"FileNodeViewHeader-breadcrumb-segment" satisfies FileNodeViewHeader_ClassNames,
													)}
													to="/w/$workspaceName/$projectName/files"
													params={{ workspaceName, projectName }}
													search={{ nodeId: item.index, view: editorMode }}
													variant="button-tertiary"
												>
													{item.title}
												</MyLink>
											</li>
										)}
										{index < breadcrumbPath.length - 1 && (
											<span
												className={cn("FileNodeViewHeader-breadcrumb-separator" satisfies FileNodeViewHeader_ClassNames)}
											>
												/
											</span>
										)}
									</React.Fragment>
								);
							})}
						</>
					) : (
						<li className={cn("FileNodeViewHeader-breadcrumb-segment-current" satisfies FileNodeViewHeader_ClassNames)}>
							<Home size={16} />
							<span>Home</span>
						</li>
					)}
				</ol>
			</div>

			<div className={cn("FileNodeViewHeader-switch-group" satisfies FileNodeViewHeader_ClassNames)}>
				{showFileControls && <FileEditorPresence users={onlineUsers} />}
				<MainAppHeaderBillingIndicator />
				{showFileControls && (
					<MyButtonGroup value={editorMode} onValueChange={handleEditorModeChange}>
						<MyButtonGroupItem value="rich_text_editor">Rich</MyButtonGroupItem>
						<MyButtonGroupItem value="plain_text_editor">Markdown</MyButtonGroupItem>
						<MyButtonGroupItem value="diff_editor">Diff</MyButtonGroupItem>
					</MyButtonGroup>
				)}
			</div>
		</div>
	);
});

type FileNodeViewHeaderPortal_Props = FileNodeViewHeader_Props;

const FileNodeViewHeaderPortal = memo(function FileNodeViewHeaderPortal(props: FileNodeViewHeaderPortal_Props) {
	const headerPortalElement = document.getElementById("app_main_header_content" satisfies AppElementId);

	return headerPortalElement ? createPortal(<FileNodeViewHeader {...props} />, headerPortalElement) : null;
});
// #endregion header

// #region file editor
type FileNodeViewFileEditor_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	editorMode: FileEditor_Mode;
	layout?: FileEditor_Layout;
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost?: HTMLElement | null;
	topViewZoneSlot?: React.ReactNode;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
	onNavigatePendingUpdates: FileEditor_NavigatePendingUpdates;
};

const FileNodeViewFileEditor = memo(function FileNodeViewFileEditor(props: FileNodeViewFileEditor_Props) {
	const {
		nodeId,
		editorMode,
		layout,
		commentsPortalHost,
		toolbarPortalHost,
		topViewZoneSlot,
		onEditorModeChange,
		onNavigatePendingUpdates,
	} = props;

	const authenticated = AppAuthProvider.useAuthenticated();

	return (
		<FileEditorPresenceSupplier userId={authenticated.userId} nodeId={nodeId}>
			{({ presenceStore }) => (
				<FileEditor
					nodeId={nodeId}
					editorMode={editorMode}
					layout={layout}
					presenceStore={presenceStore}
					commentsPortalHost={commentsPortalHost}
					toolbarPortalHost={toolbarPortalHost}
					topViewZoneSlot={topViewZoneSlot}
					onEditorModeChange={onEditorModeChange}
					onNavigatePendingUpdates={onNavigatePendingUpdates}
				/>
			)}
		</FileEditorPresenceSupplier>
	);
});

type FileNodeViewFile_Props = {
	node: app_convex_Doc<"files_nodes">;
	treeItemsList: FileNodeViewContent_Props["treeItemsList"];
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	commentsPortalHost: HTMLElement | null;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
	onNavigatePendingUpdates: FileEditor_NavigatePendingUpdates;
};

const FileNodeViewFile = memo(function FileNodeViewFile(props: FileNodeViewFile_Props) {
	const {
		node,
		treeItemsList,
		editorMode,
		filesSidebarOpen,
		commentsPortalHost,
		onEditorModeChange,
		onNavigatePendingUpdates,
	} = props;

	const authenticated = AppAuthProvider.useAuthenticated();

	return (
		<FileEditorPresenceSupplier userId={authenticated.userId} nodeId={node._id}>
			{({ presenceStore, onlineUsers }) => (
				<>
					<FileNodeViewHeaderPortal
						selectedNodeId={node._id}
						treeItemsList={treeItemsList}
						editorMode={editorMode}
						filesSidebarOpen={filesSidebarOpen}
						showFileControls={true}
						onlineUsers={onlineUsers}
						onEditorModeChange={onEditorModeChange}
					/>
					<FileEditor
						nodeId={node._id}
						editorMode={editorMode}
						presenceStore={presenceStore}
						commentsPortalHost={commentsPortalHost}
						onEditorModeChange={onEditorModeChange}
						onNavigatePendingUpdates={onNavigatePendingUpdates}
					/>
				</>
			)}
		</FileEditorPresenceSupplier>
	);
});
// #endregion file editor

// #region folder explorer
const FILE_NODE_VIEW_FOLDER_EXPLORER_INITIAL_ITEMS_COUNT = 5;

type FileNodeViewFolderExplorer_ClassNames =
	| "FileNodeViewFolderExplorer"
	| "FileNodeViewFolderExplorer-mode-monaco"
	| "FileNodeViewFolderExplorer-browser"
	| "FileNodeViewFolderExplorer-toolbar"
	| "FileNodeViewFolderExplorer-header"
	| "FileNodeViewFolderExplorer-title"
	| "FileNodeViewFolderExplorer-list"
	| "FileNodeViewFolderExplorer-table"
	| "FileNodeViewFolderExplorer-row"
	| "FileNodeViewFolderExplorer-cell"
	| "FileNodeViewFolderExplorer-cell-name"
	| "FileNodeViewFolderExplorer-cell-kind"
	| "FileNodeViewFolderExplorer-cell-updated"
	| "FileNodeViewFolderExplorer-link"
	| "FileNodeViewFolderExplorer-icon"
	| "FileNodeViewFolderExplorer-show-more"
	| "FileNodeViewFolderExplorer-readme"
	| "FileNodeViewFolderExplorer-readme-header"
	| "FileNodeViewFolderExplorer-readme-title"
	| "FileNodeViewFolderExplorer-readme-editor"
	| "FileNodeViewFolderExplorer-readme-empty"
	| "FileNodeViewFolderExplorer-readme-empty-text"
	| "FileNodeViewFolderExplorer-readme-empty-action"
	| "FileNodeViewFolderExplorer-readme-empty-action-icon";

type FileNodeViewFolderExplorer_Props = {
	node: app_convex_Doc<"files_nodes"> | null;
	folderItemId: app_convex_Doc<"files_nodes">["parentId"];
	treeItemsList: FileNodeViewContent_Props["treeItemsList"];
	editorMode: FileEditor_Mode;
	commentsPortalHost: HTMLElement | null;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
	onNavigatePendingUpdates: FileEditor_NavigatePendingUpdates;
};

const FileNodeViewFolderExplorer = memo(function FileNodeViewFolderExplorer(props: FileNodeViewFolderExplorer_Props) {
	const {
		node,
		folderItemId,
		treeItemsList,
		editorMode,
		commentsPortalHost,
		onEditorModeChange,
		onNavigatePendingUpdates,
	} = props;
	const { membershipId, workspaceName, projectName } = AppTenantProvider.useContext();

	const createNode = useMutation(app_convex_api.files_nodes.create_node);

	const [showAllItems, setShowAllItems] = useState(false);
	const [isCreatingReadme, setIsCreatingReadme] = useState(false);
	const [toolbarPortalHost, setToolbarPortalHost] = useState<HTMLElement | null>(null);

	useEffect(() => {
		setShowAllItems(false);
	}, [folderItemId]);

	const childItems = (treeItemsList ?? [])
		.filter(
			(item) => item.type === "node" && item.parentId === folderItemId && item.archiveOperationId === undefined,
		)
		.sort((a, b) => {
			if (a.kind !== b.kind) {
				return a.kind === "folder" ? -1 : 1;
			}

			return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
		});
	const visibleChildItems = showAllItems
		? childItems
		: childItems.slice(0, FILE_NODE_VIEW_FOLDER_EXPLORER_INITIAL_ITEMS_COUNT);
	const hiddenChildItemsCount = childItems.length - visibleChildItems.length;
	const readmeItem = childItems.find((item) => item.kind === "file" && item.title.toLowerCase() === "readme.md");
	const readmeNodeId = readmeItem?._id ?? null;
	const folderTitle = node?.name ?? "Files";

	const handleShowMoreClick = useFn(() => {
		setShowAllItems(true);
	});

	const handleCreateReadmeClick = useFn(() => {
		setIsCreatingReadme(true);
		createNode({
			membershipId,
			parentId: folderItemId,
			name: "README.md",
			kind: "file",
		})
			.then((result) => {
				if (result._nay) {
					console.error("[FileNodeViewFolderExplorer.handleCreateReadmeClick] Failed to create README", {
						result,
						folderItemId,
					});
				}
			})
			.catch((error) => {
				console.error("[FileNodeViewFolderExplorer.handleCreateReadmeClick] Error creating README", {
					error,
					folderItemId,
				});
			})
			.finally(() => {
				setIsCreatingReadme(false);
			});
	});

	const isMonacoEditorMode = editorMode !== "rich_text_editor";
	const toolbarPortalHostElement = (
		<div
			ref={setToolbarPortalHost}
			className={"FileNodeViewFolderExplorer-toolbar" satisfies FileNodeViewFolderExplorer_ClassNames}
		/>
	);

	const folderBrowserContent = (
		<div className={"FileNodeViewFolderExplorer-browser" satisfies FileNodeViewFolderExplorer_ClassNames}>
			<div className={"FileNodeViewFolderExplorer-header" satisfies FileNodeViewFolderExplorer_ClassNames}>
				<h1 className={"FileNodeViewFolderExplorer-title" satisfies FileNodeViewFolderExplorer_ClassNames}>
					{folderTitle}
				</h1>
			</div>

			{(childItems.length > 0 || hiddenChildItemsCount > 0) && (
				<div className={"FileNodeViewFolderExplorer-list" satisfies FileNodeViewFolderExplorer_ClassNames}>
					{childItems.length > 0 && (
						<table className={"FileNodeViewFolderExplorer-table" satisfies FileNodeViewFolderExplorer_ClassNames}>
							<tbody>
								{visibleChildItems.map((child) => (
									<tr
										key={child.index}
										className={"FileNodeViewFolderExplorer-row" satisfies FileNodeViewFolderExplorer_ClassNames}
									>
										<td
											className={cn(
												"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorer_ClassNames,
												"FileNodeViewFolderExplorer-cell-name" satisfies FileNodeViewFolderExplorer_ClassNames,
											)}
										>
											<MyIcon className={"FileNodeViewFolderExplorer-icon" satisfies FileNodeViewFolderExplorer_ClassNames}>
												{child.kind === "folder" ? <Folder /> : <FileText />}
											</MyIcon>
											<MyLink
												className={"FileNodeViewFolderExplorer-link" satisfies FileNodeViewFolderExplorer_ClassNames}
												to="/w/$workspaceName/$projectName/files"
												params={{ workspaceName, projectName }}
												search={{ nodeId: child.index, view: editorMode }}
												variant="button-tertiary"
											>
												{child.title}
											</MyLink>
										</td>
										<td
											className={cn(
												"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorer_ClassNames,
												"FileNodeViewFolderExplorer-cell-kind" satisfies FileNodeViewFolderExplorer_ClassNames,
											)}
										>
											{child.kind === "folder" ? "Folder" : "File"}
										</td>
										<td
											className={cn(
												"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorer_ClassNames,
												"FileNodeViewFolderExplorer-cell-updated" satisfies FileNodeViewFolderExplorer_ClassNames,
											)}
										>
											{format_relative_time(child.updatedAt)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}

					{hiddenChildItemsCount > 0 && (
						<MyButton
							className={"FileNodeViewFolderExplorer-show-more" satisfies FileNodeViewFolderExplorer_ClassNames}
							variant="outline"
							onClick={handleShowMoreClick}
						>
							Show more
						</MyButton>
					)}
				</div>
			)}

			<section className={"FileNodeViewFolderExplorer-readme" satisfies FileNodeViewFolderExplorer_ClassNames}>
				<div className={"FileNodeViewFolderExplorer-readme-header" satisfies FileNodeViewFolderExplorer_ClassNames}>
					<MyIcon className={"FileNodeViewFolderExplorer-icon" satisfies FileNodeViewFolderExplorer_ClassNames}>
						<BookOpen />
					</MyIcon>
					<h2 className={"FileNodeViewFolderExplorer-readme-title" satisfies FileNodeViewFolderExplorer_ClassNames}>
						README.md
					</h2>
				</div>

				{treeItemsList === undefined ? (
					<div className={"FileNodeView-loading-text" satisfies FileNodeView_ClassNames}>Loading...</div>
				) : !readmeNodeId ? (
					<div className={"FileNodeViewFolderExplorer-readme-empty" satisfies FileNodeViewFolderExplorer_ClassNames}>
						<p className={"FileNodeViewFolderExplorer-readme-empty-text" satisfies FileNodeViewFolderExplorer_ClassNames}>
							No README available.
						</p>
						<MyButton
							className={"FileNodeViewFolderExplorer-readme-empty-action" satisfies FileNodeViewFolderExplorer_ClassNames}
							variant="outline"
							disabled={isCreatingReadme}
							aria-busy={isCreatingReadme}
							onClick={handleCreateReadmeClick}
						>
							<MyButtonIcon
								className={
									"FileNodeViewFolderExplorer-readme-empty-action-icon" satisfies FileNodeViewFolderExplorer_ClassNames
								}
							>
								<FilePlus />
							</MyButtonIcon>
							Create README
						</MyButton>
					</div>
				) : null}
			</section>
		</div>
	);

	const readmeEditor = readmeNodeId ? (
		<div className={"FileNodeViewFolderExplorer-readme-editor" satisfies FileNodeViewFolderExplorer_ClassNames}>
			<FileNodeViewFileEditor
				key={readmeNodeId}
				nodeId={readmeNodeId}
				editorMode={editorMode}
				layout="embedded"
				commentsPortalHost={commentsPortalHost}
				toolbarPortalHost={toolbarPortalHost}
				topViewZoneSlot={isMonacoEditorMode ? folderBrowserContent : undefined}
				onEditorModeChange={onEditorModeChange}
				onNavigatePendingUpdates={onNavigatePendingUpdates}
			/>
		</div>
	) : null;

	return (
		<div
			className={cn(
				"FileNodeViewFolderExplorer" satisfies FileNodeViewFolderExplorer_ClassNames,
				isMonacoEditorMode &&
					readmeNodeId &&
					("FileNodeViewFolderExplorer-mode-monaco" satisfies FileNodeViewFolderExplorer_ClassNames),
			)}
		>
			{isMonacoEditorMode && readmeNodeId ? (
				<>
					{toolbarPortalHostElement}
					{readmeEditor}
				</>
			) : (
				<>
					{toolbarPortalHostElement}
					{folderBrowserContent}
					{readmeEditor}
				</>
			)}
		</div>
	);
});
// #endregion folder explorer

// #region content
type FileNodeViewContent_Props = {
	selectedNodeId: string | null | undefined;
	node: app_convex_Doc<"files_nodes"> | null | undefined;
	treeItemsList: app_convex_FunctionReturnType<typeof app_convex_api.files_nodes.get_tree_nodes_list> | undefined;
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	commentsPortalHost: HTMLElement | null;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
	onNavigatePendingUpdates: FileEditor_NavigatePendingUpdates;
};

const FileNodeViewContent = memo(function FileNodeViewContent(props: FileNodeViewContent_Props) {
	const {
		selectedNodeId,
		node,
		treeItemsList,
		editorMode,
		filesSidebarOpen,
		commentsPortalHost,
		onEditorModeChange,
		onNavigatePendingUpdates,
	} = props;

	if (selectedNodeId === files_ROOT_ID) {
		return (
			<>
				<FileNodeViewHeaderPortal
					selectedNodeId={files_ROOT_ID}
					treeItemsList={treeItemsList}
					editorMode={editorMode}
					filesSidebarOpen={filesSidebarOpen}
					showFileControls={true}
					onlineUsers={[]}
					onEditorModeChange={onEditorModeChange}
				/>
				<FileNodeViewFolderExplorer
					node={null}
					folderItemId={files_ROOT_ID}
					treeItemsList={treeItemsList}
					editorMode={editorMode}
					commentsPortalHost={commentsPortalHost}
					onEditorModeChange={onEditorModeChange}
					onNavigatePendingUpdates={onNavigatePendingUpdates}
				/>
			</>
		);
	}

	if (!node) {
		return null;
	}

	if (node.kind === "folder") {
		return (
			<>
				<FileNodeViewHeaderPortal
					selectedNodeId={node._id}
					treeItemsList={treeItemsList}
					editorMode={editorMode}
					filesSidebarOpen={filesSidebarOpen}
					showFileControls={true}
					onlineUsers={[]}
					onEditorModeChange={onEditorModeChange}
				/>
				<FileNodeViewFolderExplorer
					node={node}
					folderItemId={node._id}
					treeItemsList={treeItemsList}
					editorMode={editorMode}
					commentsPortalHost={commentsPortalHost}
					onEditorModeChange={onEditorModeChange}
					onNavigatePendingUpdates={onNavigatePendingUpdates}
				/>
			</>
		);
	}

	return (
		<FileNodeViewFile
			node={node}
			treeItemsList={treeItemsList}
			editorMode={editorMode}
			filesSidebarOpen={filesSidebarOpen}
			commentsPortalHost={commentsPortalHost}
			onEditorModeChange={onEditorModeChange}
			onNavigatePendingUpdates={onNavigatePendingUpdates}
		/>
	);
});
// #endregion content

// #region root
type FileNodeView_ClassNames =
	| "FileNodeView"
	| "FileNodeView-sidebar-panel"
	| "FileNodeView-main-panel"
	| "FileNodeView-editor-area"
	| "FileNodeView-content-group"
	| "FileNodeView-content-panel"
	| "FileNodeView-editor-sidebar-panel"
	| "FileNodeView-loading-text";

type FileNodeView_SidebarState = "closed" | "expanded";

export type FileNodeView_SearchParams = {
	nodeId?: string;
	view?: files_EditorView;
};

export type FileNodeView_Props = {
	searchParams: FileNodeView_SearchParams;
	onNavigateSearch: (search: FileNodeView_SearchParams) => void;
};

export const FileNodeView = memo(function FileNodeView(props: FileNodeView_Props) {
	const { searchParams, onNavigateSearch } = props;

	const { membershipId } = AppTenantProvider.useContext();

	const effectiveView: files_EditorView = searchParams.view ?? "rich_text_editor";

	const [filesSidebarOpen, setFilesSidebarOpen] = useAppLocalStorageStateValue("app_state::sidebar::files_open");
	const [savedPanelLayout, setMainPanelLayout] = useAppLocalStorageStateValue("app_state::resizable_panel::main_panel");
	const [savedEditorPanelLayout, setEditorPanelLayout] = useAppLocalStorageStateValue(
		"app_state::resizable_panel::file_editor_panel",
	);
	const panelLayoutRef = useRef(savedPanelLayout ?? [24, 76]);
	const editorPanelLayoutRef = useRef(savedEditorPanelLayout ?? [75, 25]);
	const filesSidebarState: FileNodeView_SidebarState = filesSidebarOpen ? "expanded" : "closed";
	const [commentsPortalHost, setCommentsPortalHost] = useState<HTMLElement | null>(null);

	const [lastOpenNodeId, setLastOpenNodeId] = useAppLocalStorageStateValue(
		`app_state::files_last_open::scope::${membershipId}`,
	);

	const searchNodeId = searchParams.nodeId;
	const isRootNodeSelected = searchNodeId === files_ROOT_ID;

	const treeItemsList = useStableQuery(app_convex_api.files_nodes.get_tree_nodes_list, { membershipId });

	const resolvedNode = useStableQuery(
		app_convex_api.files_nodes.get,
		searchNodeId && !isRootNodeSelected
			? {
					membershipId,
					nodeId: searchNodeId,
				}
			: "skip",
	);
	const resolvedNodeId = isRootNodeSelected ? files_ROOT_ID : (resolvedNode?._id ?? null);

	const navigateToNode = useFn((nodeId?: string, nextEditorMode: files_EditorView = effectiveView) => {
		const view = nextEditorMode === "rich_text_editor" ? undefined : nextEditorMode;

		onNavigateSearch({ nodeId, view });
	});

	const navigateToView = useFn<FileNodeViewContent_Props["onEditorModeChange"]>((nextView) => {
		const nodeId = searchNodeId ?? files_ROOT_ID;
		const view = nextView === "rich_text_editor" ? undefined : nextView;
		onNavigateSearch({ nodeId, view });
	});

	const handleNavigatePendingUpdates = useFn<FileEditor_NavigatePendingUpdates>((args) => {
		const nextView = args.forceDiffEditor ? "diff_editor" : effectiveView;
		navigateToNode(args.nodeId, nextView);
	});

	const handleArchive = useFn<React.ComponentProps<typeof FilesSidebar>["onArchive"]>((itemId) => {
		// When the selected node is archived, leave the user on the root folder instead of a stale node id.
		if (searchNodeId === itemId) {
			navigateToNode(files_ROOT_ID);
		}
	});

	const handlePrimaryAction = useFn<React.ComponentProps<typeof FilesSidebar>["onPrimaryAction"]>(
		(itemId) => {
			if (searchNodeId !== itemId) {
				navigateToNode(itemId);
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

	const handleEditorPanelLayout = useFn<NonNullable<React.ComponentProps<typeof MyPanelGroup>["onLayout"]>>(
		(layout) => {
			editorPanelLayoutRef.current = layout;
		},
	);

	const handleEditorPanelDragging = useFn<NonNullable<React.ComponentProps<typeof MyPanelResizeHandle>["onDragging"]>>(
		(isDragging) => {
			if (isDragging) {
				return;
			}

			setEditorPanelLayout(editorPanelLayoutRef.current);
		},
	);

	// If URL has no node id, restore last-open; otherwise default to the root folder.
	useEffect(() => {
		if (searchNodeId) {
			return;
		}

		if (lastOpenNodeId) {
			navigateToNode(lastOpenNodeId);
			return;
		}

		navigateToNode(files_ROOT_ID);
	}, [lastOpenNodeId, navigateToNode, searchNodeId]);

	// Persist the current URL node id as "last open" for next visits.
	useEffect(() => {
		if (!searchNodeId) {
			return;
		}

		setLastOpenNodeId(searchNodeId);
	}, [searchNodeId, setLastOpenNodeId]);

	// If a requested node id cannot be resolved, clear stale last-open and fall back to the root folder.
	useEffect(() => {
		if (!searchNodeId || resolvedNode === undefined || resolvedNode !== null) {
			return;
		}

		setLastOpenNodeId(null);
		navigateToNode(files_ROOT_ID);
	}, [navigateToNode, resolvedNode, searchNodeId, setLastOpenNodeId]);

	const contentPanelStyle =
		effectiveView === "rich_text_editor"
			? {
					minHeight: "100%",
					height: "max-content",
					overflow: "visible",
				}
			: undefined;

	return (
		<MyPanelGroup
			className={"FileNodeView" satisfies FileNodeView_ClassNames}
			direction="horizontal"
			onLayout={handlePanelLayout}
		>
			<MyPanel
				defaultSize={savedPanelLayout?.[0] ?? 24}
				className={"FileNodeView-sidebar-panel" satisfies FileNodeView_ClassNames}
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
				className={"FileNodeView-main-panel" satisfies FileNodeView_ClassNames}
			>
				<div className={"FileNodeView-editor-area" satisfies FileNodeView_ClassNames}>
					<MyPanelGroup
						className={"FileNodeView-content-group" satisfies FileNodeView_ClassNames}
						direction="horizontal"
						onLayout={handleEditorPanelLayout}
						style={{
							height: "max-content",
							overflow: "visible",
						}}
					>
						<MyPanel
							defaultSize={savedEditorPanelLayout?.[0] ?? 75}
							minSize={40}
							className={"FileNodeView-content-panel" satisfies FileNodeView_ClassNames}
							style={contentPanelStyle}
						>
							{resolvedNodeId ? (
								<FileNodeViewContent
									selectedNodeId={searchNodeId}
									node={resolvedNode}
									treeItemsList={treeItemsList}
									editorMode={effectiveView}
									filesSidebarOpen={filesSidebarOpen}
									commentsPortalHost={commentsPortalHost}
									onEditorModeChange={navigateToView}
									onNavigatePendingUpdates={handleNavigatePendingUpdates}
								/>
							) : searchNodeId ? (
								<div className={"FileNodeView-loading-text" satisfies FileNodeView_ClassNames}>Loading...</div>
							) : null}
						</MyPanel>
						<MyPanelResizeHandle onDragging={handleEditorPanelDragging} />
						<MyPanel
							className={"FileNodeView-editor-sidebar-panel" satisfies FileNodeView_ClassNames}
							collapsible={false}
							defaultSize={savedEditorPanelLayout?.[1] ?? 25}
							minSize={18}
							style={{
								overflow: "initial",
							}}
						>
							<FileEditorSidebar commentsContainerRef={setCommentsPortalHost} />
						</MyPanel>
					</MyPanelGroup>
				</div>
			</MyPanel>
		</MyPanelGroup>
	);
});
// #endregion root
