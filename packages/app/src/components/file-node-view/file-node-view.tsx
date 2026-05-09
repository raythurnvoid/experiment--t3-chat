import "./file-node-view.css";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { FileEditorSidebar } from "@/components/file-editor/file-editor-sidebar/file-editor-sidebar.tsx";
import { FileEditorPresence } from "@/components/file-editor/file-editor-presence.tsx";
import {
	FileEditor,
	FileEditorPendingUpdatesFloating,
	FileEditorPresenceSupplier,
	type FileEditor_Mode,
	type FileEditor_Layout,
	type FileEditor_OnlineUser,
	type FileEditorPresenceSupplier_Props,
	type FileEditor_Props,
} from "@/components/file-editor/file-editor.tsx";
import { FilesSidebarToggle } from "@/components/files-sidebar-toggle.tsx";
import { MainAppHeaderBillingIndicator } from "@/components/main-app-header-billing-indicator.tsx";
import { MainAppSidebarToggle } from "@/components/main-app-sidebar-toggle.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyButtonGroup, MyButtonGroupItem } from "@/components/my-button-group.tsx";
import { MyGridTable, MyGridTableBody, MyGridTableCell, MyGridTableRow } from "@/components/my-grid-table.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBox,
	MyInputControl,
	MyInputHelperText,
	MyInputLabel,
} from "@/components/my-input.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyLink, MyLinkIcon } from "@/components/my-link.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
} from "@/components/my-modal.tsx";
import {
	MyMenu,
	MyMenuItem,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	MyMenuPopover,
	MyMenuPopoverContent,
	MyMenuTrigger,
} from "@/components/my-menu.tsx";
import { MyPanel, MyPanelGroup, MyPanelResizeHandle } from "@/components/my-resizable-panel-group.tsx";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { useFn, useRenderPromise } from "@/hooks/utils-hooks.ts";
import {
	app_convex_api,
	type app_convex_Doc,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { format_relative_time } from "@/lib/date.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import {
	files_ROOT_ID,
	files_clear_node_path_cached_validation_messages,
	files_find_file_stem_end_index,
	files_get_default_node_name,
	files_get_node_path_validation,
	type files_EditorView,
	type files_TreeItem,
} from "@/lib/files.ts";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import { cn } from "@/lib/utils.ts";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { Archive, BookOpen, EllipsisVertical, FilePlus, FileText, Folder, FolderPlus, Home } from "lucide-react";
import React, { memo, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
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

function get_folder_readme_node_id(
	treeItemsList: files_TreeItem[] | undefined,
	folderItemId: string | null | undefined,
): app_convex_Id<"files_nodes"> | null {
	const readmeItem = treeItemsList?.find((item) => {
		return (
			item.type === "node" &&
			item.parentId === folderItemId &&
			item.kind === "file" &&
			item.archiveOperationId === undefined &&
			item.title.toLowerCase() === "readme.md"
		);
	});

	return readmeItem?._id ?? null;
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
												className={cn(
													"FileNodeViewHeader-breadcrumb-separator" satisfies FileNodeViewHeader_ClassNames,
												)}
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
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	serverSequence?: number;
	editorMode: FileEditor_Mode;
	layout?: FileEditor_Layout;
	presenceStore: FileEditor_Props["presenceStore"];
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost?: HTMLElement | null;
	topStickyFloatingSlot?: React.ReactNode;
	topViewZoneSlot?: React.ReactNode;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
};

const FileNodeViewFileEditor = memo(function FileNodeViewFileEditor(props: FileNodeViewFileEditor_Props) {
	const {
		nodeId,
		pendingUpdateId,
		serverSequence,
		editorMode,
		layout,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		topStickyFloatingSlot,
		topViewZoneSlot,
		onEditorModeChange,
	} = props;

	return (
		<FileEditor
			nodeId={nodeId}
			pendingUpdateId={pendingUpdateId}
			serverSequence={serverSequence}
			editorMode={editorMode}
			layout={layout}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			topStickyFloatingSlot={topStickyFloatingSlot}
			topViewZoneSlot={topViewZoneSlot}
			onEditorModeChange={onEditorModeChange}
		/>
	);
});

type FileNodeViewFile_Props = {
	node: app_convex_Doc<"files_nodes">;
	treeItemsList: FileNodeViewContent_Props["treeItemsList"];
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	serverSequence?: number;
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	presenceStore: FileEditor_Props["presenceStore"];
	onlineUsers: FileEditor_OnlineUser[];
	commentsPortalHost: HTMLElement | null;
	topStickyFloatingSlot?: React.ReactNode;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
};

const FileNodeViewFile = memo(function FileNodeViewFile(props: FileNodeViewFile_Props) {
	const {
		node,
		treeItemsList,
		pendingUpdateId,
		serverSequence,
		editorMode,
		filesSidebarOpen,
		presenceStore,
		onlineUsers,
		commentsPortalHost,
		topStickyFloatingSlot,
		onEditorModeChange,
	} = props;

	return (
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
			<FileNodeViewFileEditor
				nodeId={node._id}
				pendingUpdateId={pendingUpdateId}
				serverSequence={serverSequence}
				editorMode={editorMode}
				presenceStore={presenceStore}
				commentsPortalHost={commentsPortalHost}
				topStickyFloatingSlot={topStickyFloatingSlot}
				onEditorModeChange={onEditorModeChange}
			/>
		</>
	);
});
// #endregion file editor

// #region folder
const FILE_NODE_VIEW_FOLDER_INITIAL_VISIBLE_ITEMS_COUNT = 5;

type FileNodeViewFolder_ClassNames = "FileNodeViewFolder" | "FileNodeViewFolder-mode-monaco";

type FileNodeViewFolder_Props = {
	folderItemId: app_convex_Doc<"files_nodes">["parentId"];
	treeItemsList: FileNodeViewContent_Props["treeItemsList"];
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	serverSequence?: number;
	editorMode: FileEditor_Mode;
	presenceStore: FileEditor_Props["presenceStore"];
	commentsPortalHost: HTMLElement | null;
	topStickyFloatingSlot?: React.ReactNode;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
};

const FileNodeViewFolder = memo(function FileNodeViewFolder(props: FileNodeViewFolder_Props) {
	const {
		folderItemId,
		treeItemsList,
		pendingUpdateId,
		serverSequence,
		editorMode,
		presenceStore,
		commentsPortalHost,
		topStickyFloatingSlot,
		onEditorModeChange,
	} = props;
	const { membershipId, workspaceName, projectName } = AppTenantProvider.useContext();

	const createNode = useMutation(app_convex_api.files_nodes.create_node);
	const archiveNodes = useMutation(app_convex_api.files_nodes.archive_nodes);

	const [showAllItems, setShowAllItems] = useState(false);
	const [isCreatingReadme, setIsCreatingReadme] = useState(false);
	const [isCreatingNode, setIsCreatingNode] = useState(false);
	const [pendingActionNodeIds, setPendingActionNodeIds] = useState(() => new Set<string>());
	const createNodeModalRef = useRef<FileNodeViewFolderCreateNodeModal_Ref | null>(null);
	const [toolbarPortalHost, setToolbarPortalHost] = useState<HTMLElement | null>(null);

	const childItems = (treeItemsList ?? [])
		.filter((item) => item.type === "node" && item.parentId === folderItemId && item.archiveOperationId === undefined)
		.sort((a, b) => {
			if (a.kind !== b.kind) {
				return a.kind === "folder" ? -1 : 1;
			}

			return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
		});
	const visibleChildItems = showAllItems
		? childItems
		: childItems.slice(0, FILE_NODE_VIEW_FOLDER_INITIAL_VISIBLE_ITEMS_COUNT);
	const hiddenChildItemsCount = childItems.length - visibleChildItems.length;
	const readmeNodeId = get_folder_readme_node_id(treeItemsList, folderItemId);
	const childItemNames = childItems.map((child) => child.title);

	const handleShowMoreClick = useFn(() => {
		setShowAllItems(true);
	});

	const handleCreateNodeModalOpen = useFn((kind: files_TreeItem["kind"]) => {
		createNodeModalRef.current?.open(kind);
	});

	const handleCreateNodeSubmit = useFn((args: { kind: files_TreeItem["kind"]; name: string }) => {
		const { kind, name } = args;
		setIsCreatingNode(true);
		return createNode({
			membershipId,
			parentId: folderItemId,
			name,
			kind,
		})
			.then((result) => {
				if (result._nay) {
					console.error("[FileNodeViewFolder.handleCreateNodeSubmit] Failed to create node", {
						result,
						folderItemId,
						kind,
					});
					return result._nay.message;
				}

				return null;
			})
			.catch((error) => {
				console.error("[FileNodeViewFolder.handleCreateNodeSubmit] Error creating node", {
					error,
					folderItemId,
					kind,
				});
				return `Failed to create ${kind}.`;
			})
			.finally(() => {
				setIsCreatingNode(false);
			});
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
					console.error("[FileNodeViewFolder.handleCreateReadmeClick] Failed to create README", {
						result,
						folderItemId,
					});
				}
			})
			.catch((error) => {
				console.error("[FileNodeViewFolder.handleCreateReadmeClick] Error creating README", {
					error,
					folderItemId,
				});
			})
			.finally(() => {
				setIsCreatingReadme(false);
			});
	});

	const handleArchiveNode = useFn((nodeId: app_convex_Id<"files_nodes">) => {
		setPendingActionNodeIds((current) => new Set(current).add(nodeId));
		archiveNodes({
			membershipId,
			nodeIds: [nodeId],
		})
			.then((result) => {
				if (result._nay) {
					console.error("[FileNodeViewFolder.handleArchiveNode] Failed to archive node", {
						result,
						nodeId,
					});
				}
			})
			.catch((error) => {
				console.error("[FileNodeViewFolder.handleArchiveNode] Error archiving node", {
					error,
					nodeId,
				});
			})
			.finally(() => {
				setPendingActionNodeIds((current) => {
					const next = new Set(current);
					next.delete(nodeId);
					return next;
				});
			});
	});

	// Collapse the folder table again when navigating into a different folder.
	useEffect(() => {
		setShowAllItems(false);
	}, [folderItemId]);

	const toolbarPortalHostElement = (
		<FileNodeViewFolderToolbar
			disabled={isCreatingNode}
			onToolbarPortalHostChange={setToolbarPortalHost}
			onCreateNode={handleCreateNodeModalOpen}
		/>
	);

	const createNodeModal = (
		<FileNodeViewFolderCreateNodeModal
			ref={createNodeModalRef}
			membershipId={membershipId}
			folderItemId={folderItemId}
			treeItemsList={treeItemsList}
			siblingNames={childItemNames}
			isCreatingNode={isCreatingNode}
			onCreateNode={handleCreateNodeSubmit}
		/>
	);

	const folderBrowserContent = (
		<FileNodeViewFolderBody>
			<FileNodeViewFolderExplorer
				visibleChildItems={visibleChildItems}
				hiddenChildItemsCount={hiddenChildItemsCount}
				editorMode={editorMode}
				workspaceName={workspaceName}
				projectName={projectName}
				pendingActionNodeIds={pendingActionNodeIds}
				onArchiveNode={handleArchiveNode}
				onShowMoreClick={handleShowMoreClick}
			/>
			<FileNodeViewFolderReadme
				readmeNodeId={readmeNodeId}
				treeItemsList={treeItemsList}
				isCreatingReadme={isCreatingReadme}
				onCreateReadmeClick={handleCreateReadmeClick}
			/>
		</FileNodeViewFolderBody>
	);

	const readmeEditor = readmeNodeId ? (
		<FileNodeViewFolderReadmeEditor
			readmeNodeId={readmeNodeId}
			pendingUpdateId={pendingUpdateId}
			serverSequence={serverSequence}
			editorMode={editorMode}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			topStickyFloatingSlot={topStickyFloatingSlot}
			topViewZoneSlot={editorMode !== "rich_text_editor" ? folderBrowserContent : undefined}
			onEditorModeChange={onEditorModeChange}
		/>
	) : null;

	return (
		<div
			className={cn(
				"FileNodeViewFolder" satisfies FileNodeViewFolder_ClassNames,
				editorMode !== "rich_text_editor" &&
					readmeNodeId &&
					("FileNodeViewFolder-mode-monaco" satisfies FileNodeViewFolder_ClassNames),
			)}
		>
			{createNodeModal}
			{editorMode !== "rich_text_editor" && readmeNodeId ? (
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
// #endregion folder

// #region folder toolbar
type FileNodeViewFolderToolbar_ClassNames =
	| "FileNodeViewFolderToolbar"
	| "FileNodeViewFolderToolbar-actions"
	| "FileNodeViewFolderToolbar-action"
	| "FileNodeViewFolderToolbar-action-icon";

type FileNodeViewFolderToolbar_Props = {
	disabled: boolean;
	onToolbarPortalHostChange: (element: HTMLElement | null) => void;
	onCreateNode: (kind: files_TreeItem["kind"]) => void;
};

const FileNodeViewFolderToolbar = memo(function FileNodeViewFolderToolbar(props: FileNodeViewFolderToolbar_Props) {
	const { disabled, onToolbarPortalHostChange, onCreateNode } = props;

	return (
		<div
			ref={onToolbarPortalHostChange}
			className={"FileNodeViewFolderToolbar" satisfies FileNodeViewFolderToolbar_ClassNames}
		>
			<div
				role="toolbar"
				aria-label="Folder actions"
				className={"FileNodeViewFolderToolbar-actions" satisfies FileNodeViewFolderToolbar_ClassNames}
			>
				<MyIconButton
					className={"FileNodeViewFolderToolbar-action" satisfies FileNodeViewFolderToolbar_ClassNames}
					variant="ghost"
					tooltip="New file in current folder"
					disabled={disabled}
					onClick={() => onCreateNode("file")}
				>
					<MyIconButtonIcon
						className={"FileNodeViewFolderToolbar-action-icon" satisfies FileNodeViewFolderToolbar_ClassNames}
					>
						<FilePlus />
					</MyIconButtonIcon>
				</MyIconButton>
				<MyIconButton
					className={"FileNodeViewFolderToolbar-action" satisfies FileNodeViewFolderToolbar_ClassNames}
					variant="ghost"
					tooltip="New folder in current folder"
					disabled={disabled}
					onClick={() => onCreateNode("folder")}
				>
					<MyIconButtonIcon
						className={"FileNodeViewFolderToolbar-action-icon" satisfies FileNodeViewFolderToolbar_ClassNames}
					>
						<FolderPlus />
					</MyIconButtonIcon>
				</MyIconButton>
			</div>
		</div>
	);
});
// #endregion folder toolbar

// #region folder create node modal
type FileNodeViewFolderCreateNodeModal_ClassNames =
	| "FileNodeViewFolderCreateNodeModal"
	| "FileNodeViewFolderCreateNodeModal-form"
	| "FileNodeViewFolderCreateNodeModal-field"
	| "FileNodeViewFolderCreateNodeModal-validation";

type FileNodeViewFolderCreateNodeModal_Ref = {
	open: (kind: files_TreeItem["kind"]) => void;
};

type FileNodeViewFolderCreateNodeModal_Props = {
	ref: React.Ref<FileNodeViewFolderCreateNodeModal_Ref>;
	membershipId: app_convex_Id<"workspaces_projects_users">;
	folderItemId: FileNodeViewFolder_Props["folderItemId"];
	treeItemsList: FileNodeViewFolder_Props["treeItemsList"];
	siblingNames: Iterable<string>;
	isCreatingNode: boolean;
	onCreateNode: (args: { kind: files_TreeItem["kind"]; name: string }) => Promise<string | null>;
};

const FileNodeViewFolderCreateNodeModal = memo(function FileNodeViewFolderCreateNodeModal(
	props: FileNodeViewFolderCreateNodeModal_Props,
) {
	const { ref, membershipId, folderItemId, treeItemsList, siblingNames, isCreatingNode, onCreateNode } = props;

	const [kind, setKind] = useState<files_TreeItem["kind"] | null>(null);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const renderPromise = useRenderPromise();

	const kindLabel = kind === "folder" ? "folder" : "file";
	const nodePathValidation = files_get_node_path_validation({
		scopeId: membershipId,
		parentId: folderItemId,
		treeItemsList,
		kind,
		nameOrPath: name,
	});
	const displayedValidationMessage = error ?? nodePathValidation.validationMessage;
	const isSubmitBlocked = Boolean(nodePathValidation.validationMessage);

	const closeModal = useFn(() => {
		files_clear_node_path_cached_validation_messages();
		setKind(null);
		setName("");
		setError(null);
	});

	const handleNameChange = useFn<React.ComponentProps<typeof MyInputControl>["onChange"]>((event) => {
		setName(event.currentTarget.value);
		setError(null);
	});

	const handleOpenChange = useFn((open: boolean) => {
		if (open || isCreatingNode) {
			return;
		}

		closeModal();
	});

	const handleSubmit = useFn<React.ComponentProps<"form">["onSubmit"]>((event) => {
		event.preventDefault();
		if (!kind) {
			return;
		}

		const trimmedName = name.trim();
		if (!trimmedName) {
			setError(`Enter a ${kind} name.`);
			return;
		}
		if (nodePathValidation.validationMessage) {
			nodePathValidation.cacheValidationMessage(nodePathValidation.validationMessage);
			setError(nodePathValidation.validationMessage);
			return;
		}

		setError(null);
		onCreateNode({ kind, name: trimmedName })
			.then((serverErrorMessage) => {
				if (!serverErrorMessage) {
					closeModal();
					return;
				}

				nodePathValidation.cacheValidationMessage(serverErrorMessage);
				setError(serverErrorMessage);
			})
			.catch((caughtError) => {
				setError(`Failed to create ${kind}.`);
				console.error("[FileNodeViewFolderCreateNodeModal.handleSubmit] Error creating node", {
					error: caughtError,
					folderItemId,
					kind,
				});
			});
	});

	useImperativeHandle(
		ref,
		() => ({
			open: (kind) => {
				const defaultName = files_get_default_node_name({
					kind: kind,
					siblingNames,
				});
				const selectionEnd =
					kind === "file" ? files_find_file_stem_end_index({ fileName: defaultName }) : defaultName.length;
				setKind(kind);
				setName(defaultName);
				setError(null);
				renderPromise
					.wait()
					.then((result) => {
						if (result._nay) {
							return;
						}

						const input = inputRef.current;
						if (!input) {
							return;
						}

						input.focus();
						input.setSelectionRange(0, selectionEnd);
					})
					.catch((error) => {
						console.error("[FileNodeViewFolderCreateNodeModal.open] Error selecting default node name", { error });
					});
			},
		}),
		[ref, renderPromise, siblingNames],
	);

	// Keep client-side path conflicts in the shared cache so repeated values fail immediately.
	useEffect(() => {
		if (!nodePathValidation.validationMessage) {
			return;
		}

		nodePathValidation.cacheValidationMessage(nodePathValidation.validationMessage);
	}, [nodePathValidation.validationCacheKey, nodePathValidation.validationMessage]);

	// Use native validity for invalid styling while keeping the app helper text as the visible message.
	useLayoutEffect(() => {
		const input = inputRef.current;
		if (!input) {
			return;
		}

		input.setCustomValidity(kind ? (displayedValidationMessage ?? "") : "");
		return () => {
			input.setCustomValidity("");
		};
	}, [displayedValidationMessage, inputRef, kind]);

	return (
		<MyModal open={kind !== null} setOpen={handleOpenChange}>
			<MyModalPopover
				className={"FileNodeViewFolderCreateNodeModal" satisfies FileNodeViewFolderCreateNodeModal_ClassNames}
			>
				<form
					className={"FileNodeViewFolderCreateNodeModal-form" satisfies FileNodeViewFolderCreateNodeModal_ClassNames}
					onSubmit={handleSubmit}
				>
					<MyModalHeader>
						<MyModalHeading>New {kindLabel}</MyModalHeading>
					</MyModalHeader>
					<div
						className={"FileNodeViewFolderCreateNodeModal-field" satisfies FileNodeViewFolderCreateNodeModal_ClassNames}
					>
						<MyInput variant="surface">
							<MyInputLabel>Name</MyInputLabel>
							<MyInputArea>
								<MyInputBox />
								<MyInputControl
									ref={inputRef}
									autoFocus
									required
									value={name}
									disabled={isCreatingNode}
									aria-invalid={Boolean(displayedValidationMessage)}
									onChange={handleNameChange}
								/>
							</MyInputArea>
							<MyInputHelperText
								className={
									"FileNodeViewFolderCreateNodeModal-validation" satisfies FileNodeViewFolderCreateNodeModal_ClassNames
								}
								aria-live="polite"
							>
								{displayedValidationMessage}
							</MyInputHelperText>
						</MyInput>
					</div>
					<MyModalFooter>
						<MyModalCloseTrigger disabled={isCreatingNode}>
							<MyButton variant="ghost">Cancel</MyButton>
						</MyModalCloseTrigger>
						<MyButton
							type="submit"
							disabled={!name.trim() || isSubmitBlocked || isCreatingNode}
							aria-busy={isCreatingNode}
						>
							{isCreatingNode ? `Creating ${kindLabel}...` : `Create ${kindLabel}`}
						</MyButton>
					</MyModalFooter>
				</form>
				<MyModalCloseTrigger disabled={isCreatingNode} />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion folder create node modal

// #region folder body
type FileNodeViewFolderBody_ClassNames = "FileNodeViewFolderBody";

type FileNodeViewFolderBody_Props = {
	children: React.ReactNode;
};

const FileNodeViewFolderBody = memo(function FileNodeViewFolderBody(props: FileNodeViewFolderBody_Props) {
	const { children } = props;

	return <div className={"FileNodeViewFolderBody" satisfies FileNodeViewFolderBody_ClassNames}>{children}</div>;
});
// #endregion folder body

// #region folder explorer
type FileNodeViewFolderExplorer_ClassNames =
	| "FileNodeViewFolderExplorer"
	| "FileNodeViewFolderExplorer-table"
	| "FileNodeViewFolderExplorer-row"
	| "FileNodeViewFolderExplorer-row-action"
	| "FileNodeViewFolderExplorer-cell"
	| "FileNodeViewFolderExplorer-cell-name"
	| "FileNodeViewFolderExplorer-cell-updated-by"
	| "FileNodeViewFolderExplorer-cell-updated"
	| "FileNodeViewFolderExplorer-cell-actions"
	| "FileNodeViewFolderExplorer-link"
	| "FileNodeViewFolderExplorer-icon"
	| "FileNodeViewFolderExplorer-more-action"
	| "FileNodeViewFolderExplorer-show-more";

type FileNodeViewFolderExplorer_Props = {
	visibleChildItems: files_TreeItem[];
	hiddenChildItemsCount: number;
	editorMode: FileEditor_Mode;
	workspaceName: string;
	projectName: string;
	pendingActionNodeIds: ReadonlySet<string>;
	onArchiveNode: (nodeId: app_convex_Id<"files_nodes">) => void;
	onShowMoreClick: () => void;
};

const FileNodeViewFolderExplorer = memo(function FileNodeViewFolderExplorer(props: FileNodeViewFolderExplorer_Props) {
	const {
		visibleChildItems,
		hiddenChildItemsCount,
		editorMode,
		workspaceName,
		projectName,
		pendingActionNodeIds,
		onArchiveNode,
		onShowMoreClick,
	} = props;

	if (visibleChildItems.length === 0 && hiddenChildItemsCount <= 0) {
		return null;
	}

	return (
		<div className={"FileNodeViewFolderExplorer" satisfies FileNodeViewFolderExplorer_ClassNames}>
			{visibleChildItems.length > 0 && (
				<MyGridTable
					aria-label="Folder contents"
					className={"FileNodeViewFolderExplorer-table" satisfies FileNodeViewFolderExplorer_ClassNames}
				>
					<MyGridTableBody>
						{visibleChildItems.map((child) => {
							const childNodeId = child.index as app_convex_Id<"files_nodes">;
							const isPendingAction = pendingActionNodeIds.has(child.index);

							return (
								<MyGridTableRow
									key={child.index}
									className={"FileNodeViewFolderExplorer-row" satisfies FileNodeViewFolderExplorer_ClassNames}
								>
									<Link
										aria-label={`Open ${child.title}`}
										className={"FileNodeViewFolderExplorer-row-action" satisfies FileNodeViewFolderExplorer_ClassNames}
										to="/w/$workspaceName/$projectName/files"
										params={{ workspaceName, projectName }}
										search={{ nodeId: child.index, view: editorMode }}
									/>
									<MyGridTableCell
										className={cn(
											"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorer_ClassNames,
											"FileNodeViewFolderExplorer-cell-name" satisfies FileNodeViewFolderExplorer_ClassNames,
										)}
									>
										<MyIcon
											className={"FileNodeViewFolderExplorer-icon" satisfies FileNodeViewFolderExplorer_ClassNames}
										>
											{child.kind === "folder" ? <Folder /> : <FileText />}
										</MyIcon>
										<span className={"FileNodeViewFolderExplorer-link" satisfies FileNodeViewFolderExplorer_ClassNames}>
											{child.title}
										</span>
									</MyGridTableCell>
									<MyGridTableCell
										className={cn(
											"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorer_ClassNames,
											"FileNodeViewFolderExplorer-cell-updated-by" satisfies FileNodeViewFolderExplorer_ClassNames,
										)}
									>
										{child.updatedBy || "Unknown"}
									</MyGridTableCell>
									<MyGridTableCell
										className={cn(
											"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorer_ClassNames,
											"FileNodeViewFolderExplorer-cell-updated" satisfies FileNodeViewFolderExplorer_ClassNames,
										)}
									>
										{format_relative_time(child.updatedAt)}
									</MyGridTableCell>
									<MyGridTableCell
										className={cn(
											"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorer_ClassNames,
											"FileNodeViewFolderExplorer-cell-actions" satisfies FileNodeViewFolderExplorer_ClassNames,
										)}
									>
										<MyMenu>
											<MyMenuTrigger>
												<MyIconButton
													className={
														"FileNodeViewFolderExplorer-more-action" satisfies FileNodeViewFolderExplorer_ClassNames
													}
													variant="ghost-highlightable"
													tooltip="More actions"
													disabled={isPendingAction}
													aria-label={`More actions for ${child.title}`}
												>
													<MyIconButtonIcon>
														<EllipsisVertical />
													</MyIconButtonIcon>
												</MyIconButton>
											</MyMenuTrigger>
											<MyMenuPopover placement="bottom-end" unmountOnHide>
												<MyMenuPopoverContent>
													<MyMenuItem
														variant="destructive"
														disabled={isPendingAction}
														hideOnClick
														onClick={() => onArchiveNode(childNodeId)}
													>
														<MyMenuItemContent>
															<MyMenuItemContentIcon>
																<Archive />
															</MyMenuItemContentIcon>
															<MyMenuItemContentPrimary>Archive</MyMenuItemContentPrimary>
														</MyMenuItemContent>
													</MyMenuItem>
												</MyMenuPopoverContent>
											</MyMenuPopover>
										</MyMenu>
									</MyGridTableCell>
								</MyGridTableRow>
							);
						})}
					</MyGridTableBody>
				</MyGridTable>
			)}

			{hiddenChildItemsCount > 0 && (
				<MyButton
					className={"FileNodeViewFolderExplorer-show-more" satisfies FileNodeViewFolderExplorer_ClassNames}
					variant="outline"
					onClick={onShowMoreClick}
				>
					Show more
				</MyButton>
			)}
		</div>
	);
});
// #endregion folder explorer

// #region folder readme
type FileNodeViewFolderReadme_ClassNames =
	| "FileNodeViewFolderReadme"
	| "FileNodeViewFolderReadme-header"
	| "FileNodeViewFolderReadme-icon"
	| "FileNodeViewFolderReadme-title"
	| "FileNodeViewFolderReadme-empty"
	| "FileNodeViewFolderReadme-empty-title"
	| "FileNodeViewFolderReadme-empty-description"
	| "FileNodeViewFolderReadme-empty-action"
	| "FileNodeViewFolderReadme-empty-action-icon";

type FileNodeViewFolderReadme_Props = {
	readmeNodeId: app_convex_Id<"files_nodes"> | null;
	treeItemsList: FileNodeViewContent_Props["treeItemsList"];
	isCreatingReadme: boolean;
	onCreateReadmeClick: () => void;
};

const FileNodeViewFolderReadme = memo(function FileNodeViewFolderReadme(props: FileNodeViewFolderReadme_Props) {
	const { readmeNodeId, treeItemsList, isCreatingReadme, onCreateReadmeClick } = props;

	return (
		<section className={"FileNodeViewFolderReadme" satisfies FileNodeViewFolderReadme_ClassNames}>
			{readmeNodeId ? (
				<div className={"FileNodeViewFolderReadme-header" satisfies FileNodeViewFolderReadme_ClassNames}>
					<MyIcon className={"FileNodeViewFolderReadme-icon" satisfies FileNodeViewFolderReadme_ClassNames}>
						<BookOpen />
					</MyIcon>
					<h2 className={"FileNodeViewFolderReadme-title" satisfies FileNodeViewFolderReadme_ClassNames}>README.md</h2>
				</div>
			) : treeItemsList === undefined ? (
				<div className={"FileNodeView-loading-text" satisfies FileNodeView_ClassNames}>Loading...</div>
			) : (
				<div className={"FileNodeViewFolderReadme-empty" satisfies FileNodeViewFolderReadme_ClassNames}>
					<h2 className={"FileNodeViewFolderReadme-empty-title" satisfies FileNodeViewFolderReadme_ClassNames}>
						No README.md
					</h2>
					<p className={"FileNodeViewFolderReadme-empty-description" satisfies FileNodeViewFolderReadme_ClassNames}>
						Creating a README.md file will show its content in this area.
					</p>
					<MyButton
						className={"FileNodeViewFolderReadme-empty-action" satisfies FileNodeViewFolderReadme_ClassNames}
						variant="outline"
						disabled={isCreatingReadme}
						aria-busy={isCreatingReadme}
						onClick={onCreateReadmeClick}
					>
						<MyButtonIcon
							className={"FileNodeViewFolderReadme-empty-action-icon" satisfies FileNodeViewFolderReadme_ClassNames}
						>
							<FilePlus />
						</MyButtonIcon>
						Create a README.md
					</MyButton>
				</div>
			)}
		</section>
	);
});
// #endregion folder readme

// #region folder readme editor
type FileNodeViewFolderReadmeEditor_ClassNames = "FileNodeViewFolderReadmeEditor";

type FileNodeViewFolderReadmeEditor_Props = {
	readmeNodeId: app_convex_Id<"files_nodes">;
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	serverSequence?: number;
	editorMode: FileEditor_Mode;
	presenceStore: FileEditor_Props["presenceStore"];
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement | null;
	topStickyFloatingSlot?: React.ReactNode;
	topViewZoneSlot?: React.ReactNode;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
};

const FileNodeViewFolderReadmeEditor = memo(function FileNodeViewFolderReadmeEditor(
	props: FileNodeViewFolderReadmeEditor_Props,
) {
	const {
		readmeNodeId,
		pendingUpdateId,
		serverSequence,
		editorMode,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		topStickyFloatingSlot,
		topViewZoneSlot,
		onEditorModeChange,
	} = props;

	return (
		<div className={"FileNodeViewFolderReadmeEditor" satisfies FileNodeViewFolderReadmeEditor_ClassNames}>
			<FileNodeViewFileEditor
				key={readmeNodeId}
				nodeId={readmeNodeId}
				pendingUpdateId={pendingUpdateId}
				serverSequence={serverSequence}
				editorMode={editorMode}
				layout="embedded"
				presenceStore={presenceStore}
				commentsPortalHost={commentsPortalHost}
				toolbarPortalHost={toolbarPortalHost}
				topStickyFloatingSlot={topStickyFloatingSlot}
				topViewZoneSlot={topViewZoneSlot}
				onEditorModeChange={onEditorModeChange}
			/>
		</div>
	);
});
// #endregion folder readme editor

// #region content
type FileNodeViewContent_Props = {
	selectedNodeId: string | null | undefined;
	node: app_convex_Doc<"files_nodes"> | null | undefined;
	treeItemsList: app_convex_FunctionReturnType<typeof app_convex_api.files_nodes.get_tree_nodes_list> | undefined;
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	serverSequence?: number;
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	presenceStore: FileEditor_Props["presenceStore"];
	onlineUsers: FileEditor_OnlineUser[];
	commentsPortalHost: HTMLElement | null;
	topStickyFloatingSlot?: React.ReactNode;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
};

const FileNodeViewContent = memo(function FileNodeViewContent(props: FileNodeViewContent_Props) {
	const {
		selectedNodeId,
		node,
		treeItemsList,
		pendingUpdateId,
		serverSequence,
		editorMode,
		filesSidebarOpen,
		presenceStore,
		onlineUsers,
		commentsPortalHost,
		topStickyFloatingSlot,
		onEditorModeChange,
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
					onlineUsers={onlineUsers}
					onEditorModeChange={onEditorModeChange}
				/>
				<FileNodeViewFolder
					folderItemId={files_ROOT_ID}
					treeItemsList={treeItemsList}
					pendingUpdateId={pendingUpdateId}
					serverSequence={serverSequence}
					editorMode={editorMode}
					presenceStore={presenceStore}
					commentsPortalHost={commentsPortalHost}
					topStickyFloatingSlot={topStickyFloatingSlot}
					onEditorModeChange={onEditorModeChange}
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
					onlineUsers={onlineUsers}
					onEditorModeChange={onEditorModeChange}
				/>
				<FileNodeViewFolder
					folderItemId={node._id}
					treeItemsList={treeItemsList}
					pendingUpdateId={pendingUpdateId}
					serverSequence={serverSequence}
					editorMode={editorMode}
					presenceStore={presenceStore}
					commentsPortalHost={commentsPortalHost}
					topStickyFloatingSlot={topStickyFloatingSlot}
					onEditorModeChange={onEditorModeChange}
				/>
			</>
		);
	}

	return (
		<FileNodeViewFile
			node={node}
			treeItemsList={treeItemsList}
			pendingUpdateId={pendingUpdateId}
			serverSequence={serverSequence}
			editorMode={editorMode}
			filesSidebarOpen={filesSidebarOpen}
			presenceStore={presenceStore}
			onlineUsers={onlineUsers}
			commentsPortalHost={commentsPortalHost}
			topStickyFloatingSlot={topStickyFloatingSlot}
			onEditorModeChange={onEditorModeChange}
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
	const authenticated = AppAuthProvider.useAuthenticated();

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

	// Treat a folder README as the active editor node so pending-update and sync subscriptions
	// have the same owner for selected files and folder README editors.
	const activeEditorNodeId = isRootNodeSelected
		? get_folder_readme_node_id(treeItemsList, files_ROOT_ID)
		: resolvedNode?.kind === "file"
			? resolvedNode._id
			: resolvedNode?.kind === "folder"
				? get_folder_readme_node_id(treeItemsList, resolvedNode._id)
				: null;

	const allPendingUpdatesResult = useQuery(app_convex_api.files_pending_updates.list_files_pending_updates, {
		membershipId,
	});
	const activeEditorServerSequenceData = useQuery(
		app_convex_api.files_nodes.get_file_last_yjs_sequence,
		activeEditorNodeId && effectiveView !== "rich_text_editor"
			? {
					membershipId,
					nodeId: activeEditorNodeId,
				}
			: "skip",
	);

	const navigateToNode = useFn((nodeId?: string, nextEditorMode: files_EditorView = effectiveView) => {
		const view = nextEditorMode === "rich_text_editor" ? undefined : nextEditorMode;

		onNavigateSearch({ nodeId, view });
	});

	const navigateToView = useFn<FileNodeViewContent_Props["onEditorModeChange"]>((nextView) => {
		const nodeId = searchNodeId ?? files_ROOT_ID;
		const view = nextView === "rich_text_editor" ? undefined : nextView;
		onNavigateSearch({ nodeId, view });
	});

	const pendingUpdates = allPendingUpdatesResult ?? [];
	const currentPendingUpdateIndex = activeEditorNodeId
		? pendingUpdates.findIndex((pendingUpdate) => pendingUpdate.nodeId === activeEditorNodeId)
		: -1;
	const currentPendingUpdate = pendingUpdates[currentPendingUpdateIndex];
	const hasCurrentPendingUpdates = currentPendingUpdateIndex >= 0;
	const activePendingUpdateIndex = hasCurrentPendingUpdates ? currentPendingUpdateIndex : 0;
	const canNavigatePendingUpdates =
		pendingUpdates.length > 1 || (pendingUpdates.length === 1 && !hasCurrentPendingUpdates);
	const reviewPagerLabel = hasCurrentPendingUpdates
		? `Review ${activePendingUpdateIndex + 1} of ${pendingUpdates.length}`
		: "Review pending updates";

	const handleReviewPendingUpdates = useFn(() => {
		navigateToView("diff_editor");
	});

	const handleNavigatePendingUpdates = useFn(
		(args: { nodeId: app_convex_Id<"files_nodes">; forceDiffEditor: boolean }) => {
			const nextView = args.forceDiffEditor ? "diff_editor" : effectiveView;
			navigateToNode(args.nodeId, nextView);
		},
	);

	const handleNavigatePendingUpdatesDirection = useFn((direction: "prev" | "next") => {
		if (pendingUpdates.length <= 1) {
			if (!pendingUpdates[0] || hasCurrentPendingUpdates) {
				return;
			}

			handleNavigatePendingUpdates({
				nodeId: pendingUpdates[0].nodeId,
				forceDiffEditor: true,
			});
			return;
		}

		const nextIndex =
			direction === "prev"
				? (activePendingUpdateIndex - 1 + pendingUpdates.length) % pendingUpdates.length
				: (activePendingUpdateIndex + 1) % pendingUpdates.length;
		const nextPendingUpdate = pendingUpdates[nextIndex];
		if (!nextPendingUpdate) {
			return;
		}

		handleNavigatePendingUpdates({
			nodeId: nextPendingUpdate.nodeId,
			forceDiffEditor: !hasCurrentPendingUpdates,
		});
	});

	const handleNavigatePendingUpdatesPrevious = useFn(() => {
		handleNavigatePendingUpdatesDirection("prev");
	});

	const handleNavigatePendingUpdatesNext = useFn(() => {
		handleNavigatePendingUpdatesDirection("next");
	});

	const topStickyFloatingSlot =
		pendingUpdates.length > 0 ? (
			<FileEditorPendingUpdatesFloating
				updatedAt={currentPendingUpdate?.updatedAt}
				showReviewButton={hasCurrentPendingUpdates && effectiveView !== "diff_editor"}
				reviewPagerLabel={reviewPagerLabel}
				canNavigate={canNavigatePendingUpdates}
				onReviewChanges={handleReviewPendingUpdates}
				onNavigatePrevious={handleNavigatePendingUpdatesPrevious}
				onNavigateNext={handleNavigatePendingUpdatesNext}
			/>
		) : null;

	const handleArchive = useFn<React.ComponentProps<typeof FilesSidebar>["onArchive"]>((itemId) => {
		// When the selected node is archived, leave the user on the root folder instead of a stale node id.
		if (searchNodeId === itemId) {
			navigateToNode(files_ROOT_ID);
		}
	});

	const handlePrimaryAction = useFn<React.ComponentProps<typeof FilesSidebar>["onPrimaryAction"]>((itemId) => {
		if (searchNodeId !== itemId) {
			navigateToNode(itemId);
		}
	});

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

	const renderContent: FileEditorPresenceSupplier_Props["children"] = (presenceProps) => {
		return resolvedNodeId ? (
			<FileNodeViewContent
				selectedNodeId={searchNodeId}
				node={resolvedNode}
				treeItemsList={treeItemsList}
				pendingUpdateId={currentPendingUpdate?._id}
				serverSequence={activeEditorServerSequenceData?.lastSequence}
				editorMode={effectiveView}
				filesSidebarOpen={filesSidebarOpen}
				presenceStore={presenceProps.presenceStore}
				onlineUsers={presenceProps.onlineUsers}
				commentsPortalHost={commentsPortalHost}
				topStickyFloatingSlot={topStickyFloatingSlot}
				onEditorModeChange={navigateToView}
			/>
		) : searchNodeId ? (
			<div className={"FileNodeView-loading-text" satisfies FileNodeView_ClassNames}>Loading...</div>
		) : null;
	};

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
							{activeEditorNodeId ? (
								<FileEditorPresenceSupplier userId={authenticated.userId} nodeId={activeEditorNodeId}>
									{renderContent}
								</FileEditorPresenceSupplier>
							) : (
								renderContent({ presenceStore: null, onlineUsers: [] })
							)}
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
