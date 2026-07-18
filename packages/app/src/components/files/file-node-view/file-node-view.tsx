import "./file-node-view.css";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { FileEditorSidebar } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar.tsx";
import { FileEditorPresence } from "@/components/files/file-editor/file-editor-presence.tsx";
import {
	FileEditor,
	FileEditorPendingUpdatesFloating,
	FileEditorPresenceSupplier,
	type FileEditor_Mode,
	type FileEditor_OnlineUser,
	type FileEditorPresenceSupplier_Props,
	type FileEditor_Props,
} from "@/components/files/file-editor/file-editor.tsx";
import { FilesSidebarToggle } from "../files-sidebar-toggle.tsx";
import { MainAppHeaderBillingIndicator } from "@/components/main-app-header-billing-indicator.tsx";
import { MainAppSidebarToggle } from "@/components/main-app-sidebar-toggle.tsx";
import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyButtonGroup, MyButtonGroupItem } from "@/components/my-button-group.tsx";
import { MyFloatingSurface } from "@/components/my-floating-surface.tsx";
import { MyGridTable, MyGridTableBody, MyGridTableCell, MyGridTableRow } from "@/components/my-grid-table.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
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
import { MySeparator } from "@/components/my-separator.tsx";
import { MySkeleton } from "@/components/my-skeleton.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { useFn, useRenderPromise } from "@/hooks/utils-hooks.ts";
import { useFileNodeActivities } from "@/lib/activities.ts";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { format_relative_time } from "@/lib/date.ts";
import type { AppElementId } from "@/lib/dom-utils.ts";
import {
	files_ROOT_ID,
	files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE,
	files_clear_node_path_cached_validation_messages,
	files_download_blob,
	files_find_file_stem_end_index,
	files_format_size,
	files_get_default_node_name,
	files_get_node_path_validation,
	files_get_normalized_node_path_segments,
	files_get_upload_pipeline_state,
	files_node_has_editable_yjs_state,
	files_pending_update_has_yjs_content,
	type files_EditorView,
	type files_SpecialFileName,
	type files_VisibleTreeNode,
} from "@/lib/files.ts";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import { cn, sx } from "@/lib/utils.ts";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { Link } from "@tanstack/react-router";
import { useConvex, useQuery } from "convex/react";
import {
	Archive,
	BookOpen,
	CircleAlert,
	Download,
	EllipsisVertical,
	FileDigit,
	FilePlus,
	FileText,
	Folder,
	FolderPlus,
	Home,
} from "lucide-react";
import React, { memo, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { FilesSidebar } from "../files-sidebar.tsx";
import { users_SYSTEM_AUTHOR } from "../../../../shared/users.ts";

function get_breadcrumb_path(fileNodesList: files_VisibleTreeNode[] | undefined, nodeId: string | null | undefined) {
	if (!fileNodesList || !nodeId || nodeId === files_ROOT_ID) {
		return [];
	}

	const path: files_VisibleTreeNode[] = [];
	let currentId = nodeId;
	const nodesMap = new Map<string, files_VisibleTreeNode>();

	for (const node of fileNodesList) {
		nodesMap.set(node._id, node);
		if (node._id === nodeId) {
			currentId = node._id;
		}
	}

	while (currentId !== files_ROOT_ID) {
		const node = nodesMap.get(currentId);
		if (!node) {
			break;
		}

		path.unshift(node);
		currentId = node.parentId;
	}

	return path;
}

function get_folder_readme_node_id(
	fileNodesList: files_VisibleTreeNode[] | undefined,
	folderItemId: string | null | undefined,
): app_convex_Id<"files_nodes"> | null {
	const readmeNode = fileNodesList?.find((node) => {
		return (
			node.parentId === folderItemId &&
			node.kind === "file" &&
			node.archiveOperationId === undefined &&
			node.name.toLowerCase() === ("README.md" satisfies files_SpecialFileName).toLowerCase()
		);
	});

	return readmeNode?._id ?? null;
}

function can_move_file_node_to_parent(args: {
	fileNodesList: files_VisibleTreeNode[] | undefined;
	fileNodeId: app_convex_Id<"files_nodes">;
	targetParentId: app_convex_Doc<"files_nodes">["parentId"];
}) {
	const fileNode = args.fileNodesList?.find((candidate) => candidate._id === args.fileNodeId);
	if (!fileNode || fileNode.archiveOperationId !== undefined) {
		return false;
	}
	if (fileNode._id === args.targetParentId || fileNode.parentId === args.targetParentId) {
		return false;
	}

	let nextParentId = args.targetParentId;
	while (nextParentId !== files_ROOT_ID) {
		if (nextParentId === fileNode._id) {
			return false;
		}

		const nextParent = args.fileNodesList?.find((candidate) => candidate._id === nextParentId);
		if (!nextParent) {
			return false;
		}

		nextParentId = nextParent.parentId;
	}

	return true;
}

type FileNodeViewFolderExplorerDragData = Record<string, unknown> & {
	type: typeof files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE;
	fileNodeId: app_convex_Id<"files_nodes">;
};

function is_file_node_view_folder_explorer_drag_data(
	data: Record<string | symbol, unknown>,
): data is FileNodeViewFolderExplorerDragData {
	return data.type === files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE && typeof data.fileNodeId === "string";
}

const FILE_NODE_VIEW_TOOLBAR_EDITOR_ACTIONS_ID = "app_file_node_view_toolbar_editor_actions" satisfies AppElementId;
const FILE_NODE_VIEW_TOP_SAFE_AREA = 44;

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
	fileNodesList: files_VisibleTreeNode[] | undefined;
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	showFileControls: boolean;
	onlineUsers: FileEditor_OnlineUser[];
	onEditorModeChange: (mode: FileEditor_Mode) => void;
};

const FileNodeViewHeader = memo(function FileNodeViewHeader(props: FileNodeViewHeader_Props) {
	const {
		selectedNodeId,
		fileNodesList,
		editorMode,
		filesSidebarOpen,
		showFileControls,
		onlineUsers,
		onEditorModeChange,
	} = props;

	const { organizationName, workspaceName } = AppTenantProvider.useContext();

	const breadcrumbPath = get_breadcrumb_path(fileNodesList, selectedNodeId);

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
									to="/w/$organizationName/$workspaceName/files"
									params={{ organizationName, workspaceName }}
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
									<React.Fragment key={item._id}>
										{isCurrentNode ? (
											<li
												className={cn(
													"FileNodeViewHeader-breadcrumb-segment-current" satisfies FileNodeViewHeader_ClassNames,
												)}
											>
												{item.name}
											</li>
										) : (
											<li>
												<MyLink
													className={cn(
														"FileNodeViewHeader-breadcrumb-segment" satisfies FileNodeViewHeader_ClassNames,
													)}
													to="/w/$organizationName/$workspaceName/files"
													params={{ organizationName, workspaceName }}
													search={{ nodeId: item._id, view: editorMode }}
													variant="button-tertiary"
												>
													{item.name}
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
							<li>
								<CopyIconButton
									variant="ghost-highlightable"
									tooltipCopy="Copy path"
									text={breadcrumbPath.at(-1)?.path}
								/>
							</li>
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

// #region top floating status
type FileNodeViewTopFloating_ClassNames =
	| "FileNodeViewTopFloating"
	| "FileNodeViewTopFloating-activity"
	| "FileNodeViewTopFloating-activity-icon"
	| "FileNodeViewTopFloating-activity-icon-failed"
	| "FileNodeViewTopFloating-activity-message";

type FileNodeViewTopFloating_Props = {
	nodeId: app_convex_Id<"files_nodes"> | null;
	pendingSlot: React.ReactNode;
};

// The single floating surface of the sticky row: the node's activity status and the
// pending-updates controls, split by a separator like the toolbar. Subscribes to one node's
// activities slice, so the parent view never re-renders on feed traffic.
const FileNodeViewTopFloating = memo(function FileNodeViewTopFloating(props: FileNodeViewTopFloating_Props) {
	const { nodeId, pendingSlot } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const convex = useConvex();

	const activities = useFileNodeActivities({ membershipId, nodeId });
	// Slices come newest first; a rerun in progress wins over an older failure.
	const activity =
		activities.find((item) => item.status === "running") ??
		activities.find((item) => item.status === "failed" || item.status === "timeout") ??
		null;

	const handleDismiss = useFn((activityId: app_convex_Id<"activities">) => {
		convex
			.mutation(app_convex_api.activities.archive_activity, { membershipId, activityId })
			.then((result) => {
				if (result._nay) {
					console.error("[FileNodeViewTopFloating.handleDismiss] Failed to archive activity", { result });
				}
			})
			.catch((error) => {
				console.error("[FileNodeViewTopFloating.handleDismiss] Unexpected archive error", {
					error,
					activityId,
				});
			});
	});

	if (!activity && !pendingSlot) {
		return null;
	}

	// "" means the producer set no per-target text; fall back to the activity title.
	const targetMessage = activity ? activity.targets.find((target) => target.id === nodeId)?.message || undefined : undefined;
	const message = activity
		? activity.status === "running"
			? (targetMessage ?? activity.title)
			: activity.status === "timeout"
				? "Timed out"
				: (activity.errorMessage ?? targetMessage ?? activity.title)
		: null;

	return (
		<MyFloatingSurface
			className={"FileNodeViewTopFloating" satisfies FileNodeViewTopFloating_ClassNames}
			role="status"
			aria-live="polite"
		>
			{activity ? (
				<div className={"FileNodeViewTopFloating-activity" satisfies FileNodeViewTopFloating_ClassNames}>
					{activity.status === "running" ? (
						<MySpinner
							className={"FileNodeViewTopFloating-activity-icon" satisfies FileNodeViewTopFloating_ClassNames}
							size="16px"
							aria-label="Running"
						/>
					) : (
						<MyIcon
							className={cn(
								"FileNodeViewTopFloating-activity-icon" satisfies FileNodeViewTopFloating_ClassNames,
								"FileNodeViewTopFloating-activity-icon-failed" satisfies FileNodeViewTopFloating_ClassNames,
							)}
						>
							<CircleAlert />
						</MyIcon>
					)}
					<span
						className={"FileNodeViewTopFloating-activity-message" satisfies FileNodeViewTopFloating_ClassNames}
						title={activity.title}
					>
						{message}
					</span>
					{activity.status !== "running" ? (
						<MyButton variant="ghost" onClick={() => handleDismiss(activity._id)}>
							Dismiss
						</MyButton>
					) : null}
				</div>
			) : null}
			{activity && pendingSlot ? <MySeparator orientation="vertical" /> : null}
			{pendingSlot}
		</MyFloatingSurface>
	);
});
// #endregion top floating status

// #region file editor
type FileNodeViewFileEditor_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	serverSequence?: number;
	editorMode: FileEditor_Mode;
	topSafeArea?: number;
	presenceStore: FileEditor_Props["presenceStore"];
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
	topViewZoneSlot?: React.ReactNode;
};

const FileNodeViewFileEditor = memo(function FileNodeViewFileEditor(props: FileNodeViewFileEditor_Props) {
	const {
		nodeId,
		pendingUpdateId,
		serverSequence,
		editorMode,
		topSafeArea,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		onEditorModeChange,
		topViewZoneSlot,
	} = props;

	return (
		<FileEditor
			nodeId={nodeId}
			pendingUpdateId={pendingUpdateId}
			serverSequence={serverSequence}
			editorMode={editorMode}
			topSafeArea={topSafeArea}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			onEditorModeChange={onEditorModeChange}
			topViewZoneSlot={topViewZoneSlot}
		/>
	);
});

type FileNodeViewFile_Props = {
	node: app_convex_Doc<"files_nodes">;
	editorNodeId?: app_convex_Id<"files_nodes">;
	fileNodesList: FileNodeViewContent_Props["fileNodesList"];
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	serverSequence?: number;
	topSafeArea: number;
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	presenceStore: FileEditor_Props["presenceStore"];
	onlineUsers: FileEditor_OnlineUser[];
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
};

const FileNodeViewFile = memo(function FileNodeViewFile(props: FileNodeViewFile_Props) {
	const {
		node,
		editorNodeId,
		fileNodesList,
		pendingUpdateId,
		serverSequence,
		topSafeArea,
		editorMode,
		filesSidebarOpen,
		presenceStore,
		onlineUsers,
		commentsPortalHost,
		toolbarPortalHost,
		onEditorModeChange,
	} = props;

	return (
		<>
			<FileNodeViewHeaderPortal
				selectedNodeId={node._id}
				fileNodesList={fileNodesList}
				editorMode={editorMode}
				filesSidebarOpen={filesSidebarOpen}
				showFileControls={true}
				onlineUsers={onlineUsers}
				onEditorModeChange={onEditorModeChange}
			/>
			<FileNodeViewFileEditor
				nodeId={editorNodeId ?? node._id}
				pendingUpdateId={pendingUpdateId}
				serverSequence={serverSequence}
				topSafeArea={topSafeArea}
				editorMode={editorMode}
				presenceStore={presenceStore}
				commentsPortalHost={commentsPortalHost}
				toolbarPortalHost={toolbarPortalHost}
				onEditorModeChange={onEditorModeChange}
			/>
		</>
	);
});
// #endregion file editor

// #region stored file
type FileNodeViewStoredFile_ClassNames =
	| "FileNodeViewStoredFile"
	| "FileNodeViewStoredFile-header"
	| "FileNodeViewStoredFile-icon"
	| "FileNodeViewStoredFile-title-group"
	| "FileNodeViewStoredFile-title"
	| "FileNodeViewStoredFile-metadata"
	| "FileNodeViewStoredFile-metadata-row"
	| "FileNodeViewStoredFile-metadata-label"
	| "FileNodeViewStoredFile-metadata-value"
	| "FileNodeViewStoredFile-metadata-skeleton";

const STORED_FILE_METADATA_SKELETON_ROW_COUNT = 8;

type FileNodeViewStoredFile_Props = {
	node: app_convex_Doc<"files_nodes">;
	fileNodesList: FileNodeViewContent_Props["fileNodesList"];
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	onlineUsers: FileEditor_OnlineUser[];
};

const FileNodeViewStoredFile = memo(function FileNodeViewStoredFile(props: FileNodeViewStoredFile_Props) {
	const { node, fileNodesList, editorMode, filesSidebarOpen, onlineUsers } = props;
	const { membershipId } = AppTenantProvider.useContext();

	const asset = useQuery(app_convex_api.r2.get_asset, {
		membershipId,
		fileNodeId: node._id,
	});

	const createdByAnagraphic = useQuery(
		app_convex_api.users.get_anagraphic,
		node.createdBy === users_SYSTEM_AUTHOR ? "skip" : { userId: node.createdBy },
	);

	const updatedByAnagraphic = useQuery(
		app_convex_api.users.get_anagraphic,
		node.updatedBy === users_SYSTEM_AUTHOR ? "skip" : { userId: node.updatedBy },
	);

	const storedFileMetadataIsLoading = asset === undefined;

	const activeUploadStatusText = ((/* iife */) => {
		if (storedFileMetadataIsLoading) {
			return null;
		}

		switch (files_get_upload_pipeline_state(asset)) {
			case "waiting_for_upload":
				return "Waiting for upload";
			case "pending_processing":
				return "Pending processing";
			case "processing":
				return "Processing";
			case "terminal":
			case "not_applicable":
				return null;
		}
	})();

	const title = node.name;
	const storedFileSize = asset?.size;

	// undefined = still loading, hides the details list
	const createdByDisplayName = ((/* iife */) => {
		if (node.createdBy === users_SYSTEM_AUTHOR) {
			return "System";
		}
		if (createdByAnagraphic === undefined) {
			return undefined;
		}
		return createdByAnagraphic?.displayName ?? "Unknown";
	})();

	const updatedByDisplayName = ((/* iife */) => {
		if (node.updatedBy === users_SYSTEM_AUTHOR) {
			return "System";
		}
		if (updatedByAnagraphic === undefined) {
			return undefined;
		}
		return updatedByAnagraphic?.displayName ?? "Unknown";
	})();

	const location = node.path.slice(0, node.path.lastIndexOf("/")) || "/";

	return (
		<>
			<FileNodeViewHeaderPortal
				selectedNodeId={node._id}
				fileNodesList={fileNodesList}
				editorMode={editorMode}
				filesSidebarOpen={filesSidebarOpen}
				showFileControls={false}
				onlineUsers={onlineUsers}
				onEditorModeChange={() => {}}
			/>
			<section className={"FileNodeViewStoredFile" satisfies FileNodeViewStoredFile_ClassNames}>
				<header className={"FileNodeViewStoredFile-header" satisfies FileNodeViewStoredFile_ClassNames}>
					<MyIcon className={"FileNodeViewStoredFile-icon" satisfies FileNodeViewStoredFile_ClassNames}>
						<FileDigit />
					</MyIcon>
					<div className={"FileNodeViewStoredFile-title-group" satisfies FileNodeViewStoredFile_ClassNames}>
						<h1 className={"FileNodeViewStoredFile-title" satisfies FileNodeViewStoredFile_ClassNames}>{title}</h1>
					</div>
				</header>

				{storedFileMetadataIsLoading || createdByDisplayName === undefined || updatedByDisplayName === undefined ? (
					<dl className={"FileNodeViewStoredFile-metadata" satisfies FileNodeViewStoredFile_ClassNames}>
						{Array.from({ length: STORED_FILE_METADATA_SKELETON_ROW_COUNT }, (_, index) => (
							<div
								key={index}
								className={"FileNodeViewStoredFile-metadata-row" satisfies FileNodeViewStoredFile_ClassNames}
							>
								<dt className={"FileNodeViewStoredFile-metadata-label" satisfies FileNodeViewStoredFile_ClassNames}>
									<MySkeleton
										className={"FileNodeViewStoredFile-metadata-skeleton" satisfies FileNodeViewStoredFile_ClassNames}
									/>
								</dt>
								<dd className={"FileNodeViewStoredFile-metadata-value" satisfies FileNodeViewStoredFile_ClassNames}>
									<MySkeleton
										className={"FileNodeViewStoredFile-metadata-skeleton" satisfies FileNodeViewStoredFile_ClassNames}
									/>
								</dd>
							</div>
						))}
					</dl>
				) : (
					<dl className={"FileNodeViewStoredFile-metadata" satisfies FileNodeViewStoredFile_ClassNames}>
						<div className={"FileNodeViewStoredFile-metadata-row" satisfies FileNodeViewStoredFile_ClassNames}>
							<dt className={"FileNodeViewStoredFile-metadata-label" satisfies FileNodeViewStoredFile_ClassNames}>
								Filename
							</dt>
							<dd className={"FileNodeViewStoredFile-metadata-value" satisfies FileNodeViewStoredFile_ClassNames}>
								{title}
							</dd>
						</div>
						{activeUploadStatusText ? (
							<div className={"FileNodeViewStoredFile-metadata-row" satisfies FileNodeViewStoredFile_ClassNames}>
								<dt className={"FileNodeViewStoredFile-metadata-label" satisfies FileNodeViewStoredFile_ClassNames}>
									Status
								</dt>
								<dd className={"FileNodeViewStoredFile-metadata-value" satisfies FileNodeViewStoredFile_ClassNames}>
									{activeUploadStatusText}
								</dd>
							</div>
						) : null}
						<div className={"FileNodeViewStoredFile-metadata-row" satisfies FileNodeViewStoredFile_ClassNames}>
							<dt className={"FileNodeViewStoredFile-metadata-label" satisfies FileNodeViewStoredFile_ClassNames}>
								Content type
							</dt>
							<dd className={"FileNodeViewStoredFile-metadata-value" satisfies FileNodeViewStoredFile_ClassNames}>
								{node.contentType ?? "Unknown"}
							</dd>
						</div>
						<div className={"FileNodeViewStoredFile-metadata-row" satisfies FileNodeViewStoredFile_ClassNames}>
							<dt className={"FileNodeViewStoredFile-metadata-label" satisfies FileNodeViewStoredFile_ClassNames}>
								Size
							</dt>
							<dd className={"FileNodeViewStoredFile-metadata-value" satisfies FileNodeViewStoredFile_ClassNames}>
								{files_format_size(storedFileSize)}
							</dd>
						</div>
						<div className={"FileNodeViewStoredFile-metadata-row" satisfies FileNodeViewStoredFile_ClassNames}>
							<dt className={"FileNodeViewStoredFile-metadata-label" satisfies FileNodeViewStoredFile_ClassNames}>
								Location
							</dt>
							<dd className={"FileNodeViewStoredFile-metadata-value" satisfies FileNodeViewStoredFile_ClassNames}>
								{location}
							</dd>
						</div>
						<div className={"FileNodeViewStoredFile-metadata-row" satisfies FileNodeViewStoredFile_ClassNames}>
							<dt className={"FileNodeViewStoredFile-metadata-label" satisfies FileNodeViewStoredFile_ClassNames}>
								Created
							</dt>
							<dd className={"FileNodeViewStoredFile-metadata-value" satisfies FileNodeViewStoredFile_ClassNames}>
								{format_relative_time(node._creationTime)}
							</dd>
						</div>
						<div className={"FileNodeViewStoredFile-metadata-row" satisfies FileNodeViewStoredFile_ClassNames}>
							<dt className={"FileNodeViewStoredFile-metadata-label" satisfies FileNodeViewStoredFile_ClassNames}>
								Created by
							</dt>
							<dd className={"FileNodeViewStoredFile-metadata-value" satisfies FileNodeViewStoredFile_ClassNames}>
								{createdByDisplayName}
							</dd>
						</div>
						<div className={"FileNodeViewStoredFile-metadata-row" satisfies FileNodeViewStoredFile_ClassNames}>
							<dt className={"FileNodeViewStoredFile-metadata-label" satisfies FileNodeViewStoredFile_ClassNames}>
								Last edited
							</dt>
							<dd className={"FileNodeViewStoredFile-metadata-value" satisfies FileNodeViewStoredFile_ClassNames}>
								{format_relative_time(node.updatedAt)}
							</dd>
						</div>
						<div className={"FileNodeViewStoredFile-metadata-row" satisfies FileNodeViewStoredFile_ClassNames}>
							<dt className={"FileNodeViewStoredFile-metadata-label" satisfies FileNodeViewStoredFile_ClassNames}>
								Last edited by
							</dt>
							<dd className={"FileNodeViewStoredFile-metadata-value" satisfies FileNodeViewStoredFile_ClassNames}>
								{updatedByDisplayName}
							</dd>
						</div>
					</dl>
				)}
			</section>
		</>
	);
});
// #endregion stored file

// #region folder
const FILE_NODE_VIEW_FOLDER_INITIAL_VISIBLE_ITEMS_COUNT = 5;

type FileNodeViewFolder_ClassNames = "FileNodeViewFolder" | "FileNodeViewFolder-mode-monaco";

type FileNodeViewFolder_Props = {
	folderItemId: app_convex_Doc<"files_nodes">["parentId"];
	fileNodesList: FileNodeViewContent_Props["fileNodesList"];
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	serverSequence?: number;
	topSafeArea: number;
	editorMode: FileEditor_Mode;
	presenceStore: FileEditor_Props["presenceStore"];
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
};

const FileNodeViewFolder = memo(function FileNodeViewFolder(props: FileNodeViewFolder_Props) {
	const {
		folderItemId,
		fileNodesList,
		pendingUpdateId,
		serverSequence,
		topSafeArea,
		editorMode,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		onEditorModeChange,
	} = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const convex = useConvex();

	const [showAllItems, setShowAllItems] = useState(false);
	const [isCreatingReadme, setIsCreatingReadme] = useState(false);
	const [pendingActionNodeIds, setPendingActionNodeIds] = useState(() => new Set<string>());

	const childItems = (fileNodesList ?? [])
		.filter((item) => item.parentId === folderItemId && item.archiveOperationId === undefined)
		.sort((a, b) => {
			if (a.kind !== b.kind) {
				return a.kind === "folder" ? -1 : 1;
			}

			return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
		});
	const visibleChildItems = showAllItems
		? childItems
		: childItems.slice(0, FILE_NODE_VIEW_FOLDER_INITIAL_VISIBLE_ITEMS_COUNT);
	const hiddenChildItemsCount = childItems.length - visibleChildItems.length;
	const readmeNodeId = get_folder_readme_node_id(fileNodesList, folderItemId);

	const handleShowMoreClick = useFn(() => {
		setShowAllItems(true);
	});

	const handleShowLessClick = useFn(() => {
		setShowAllItems(false);
	});

	const handleCreateReadmeClick = useFn(() => {
		setIsCreatingReadme(true);
		convex
			.action(app_convex_api.files_nodes.create_markdown_node, {
				membershipId,
				parentId: folderItemId,
				path: "README.md" satisfies files_SpecialFileName,
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
		convex
			.mutation(app_convex_api.files_nodes.archive_nodes, {
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

	const handleCanMoveFileNodeToParent = useFn(
		(args: { fileNodeId: app_convex_Id<"files_nodes">; targetParentId: app_convex_Doc<"files_nodes">["parentId"] }) => {
			return can_move_file_node_to_parent({
				fileNodesList,
				fileNodeId: args.fileNodeId,
				targetParentId: args.targetParentId,
			});
		},
	);

	const handleMoveFileNodesToParent = useFn(
		(args: {
			fileNodeIds: app_convex_Id<"files_nodes">[];
			targetParentId: app_convex_Doc<"files_nodes">["parentId"];
		}) => {
			const movedFileNodeIds = args.fileNodeIds.filter((fileNodeId) => {
				return handleCanMoveFileNodeToParent({
					fileNodeId,
					targetParentId: args.targetParentId,
				});
			});
			if (movedFileNodeIds.length === 0) {
				return;
			}

			setPendingActionNodeIds((current) => new Set([...current, ...movedFileNodeIds]));
			convex
				.mutation(app_convex_api.files_nodes.move_nodes, {
					membershipId,
					itemIds: movedFileNodeIds,
					targetParentId: args.targetParentId,
				})
				.then((result) => {
					if (result._nay) {
						console.error("[FileNodeViewFolder.handleMoveFileNodesToParent] Failed to move nodes", {
							result,
							fileNodeIds: movedFileNodeIds,
							targetParentId: args.targetParentId,
						});
					}
				})
				.catch((error) => {
					console.error("[FileNodeViewFolder.handleMoveFileNodesToParent] Error moving nodes", {
						error,
						fileNodeIds: movedFileNodeIds,
						targetParentId: args.targetParentId,
					});
				})
				.finally(() => {
					setPendingActionNodeIds((current) => {
						const next = new Set(current);
						for (const fileNodeId of movedFileNodeIds) {
							next.delete(fileNodeId);
						}
						return next;
					});
				});
		},
	);

	// Collapse the folder table again when navigating into a different folder.
	useEffect(() => {
		setShowAllItems(false);
	}, [folderItemId]);

	const folderBrowserContent = (
		<FileNodeViewFolderBody topSafeArea={topSafeArea}>
			<FileNodeViewFolderExplorer
				visibleChildItems={visibleChildItems}
				hiddenChildItemsCount={hiddenChildItemsCount}
				editorMode={editorMode}
				organizationName={organizationName}
				workspaceName={workspaceName}
				pendingActionNodeIds={pendingActionNodeIds}
				canMoveFileNodeToParent={handleCanMoveFileNodeToParent}
				onArchiveNode={handleArchiveNode}
				onMoveFileNodesToParent={handleMoveFileNodesToParent}
				onShowMoreClick={handleShowMoreClick}
				canShowLess={showAllItems && childItems.length > FILE_NODE_VIEW_FOLDER_INITIAL_VISIBLE_ITEMS_COUNT}
				onShowLessClick={handleShowLessClick}
			/>
			<FileNodeViewFolderReadme
				readmeNodeId={readmeNodeId}
				fileNodesList={fileNodesList}
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
			onEditorModeChange={onEditorModeChange}
			topViewZoneSlot={editorMode !== "rich_text_editor" ? folderBrowserContent : undefined}
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
			{editorMode !== "rich_text_editor" && readmeNodeId ? (
				readmeEditor
			) : (
				<>
					{folderBrowserContent}
					{readmeEditor}
				</>
			)}
		</div>
	);
});
// #endregion folder

// #region toolbar
type FileNodeViewToolbarFolderActions_ClassNames =
	| "FileNodeViewToolbarFolderActions"
	| "FileNodeViewToolbarFolderActions-action"
	| "FileNodeViewToolbarFolderActions-action-icon";

type FileNodeViewToolbarFolderActions_Props = {
	disabled: boolean;
	onCreateNode: (kind: app_convex_Doc<"files_nodes">["kind"]) => void;
};

const FileNodeViewToolbarFolderActions = memo(function FileNodeViewToolbarFolderActions(
	props: FileNodeViewToolbarFolderActions_Props,
) {
	const { disabled, onCreateNode } = props;

	return (
		<div
			role="group"
			aria-label="Create files and folders"
			className={"FileNodeViewToolbarFolderActions" satisfies FileNodeViewToolbarFolderActions_ClassNames}
		>
			<MyIconButton
				className={"FileNodeViewToolbarFolderActions-action" satisfies FileNodeViewToolbarFolderActions_ClassNames}
				variant="ghost-highlightable"
				tooltip="New file"
				disabled={disabled}
				onClick={() => onCreateNode("file")}
			>
				<MyIconButtonIcon
					className={
						"FileNodeViewToolbarFolderActions-action-icon" satisfies FileNodeViewToolbarFolderActions_ClassNames
					}
				>
					<FilePlus />
				</MyIconButtonIcon>
			</MyIconButton>
			<MyIconButton
				className={"FileNodeViewToolbarFolderActions-action" satisfies FileNodeViewToolbarFolderActions_ClassNames}
				variant="ghost-highlightable"
				tooltip="New folder"
				disabled={disabled}
				onClick={() => onCreateNode("folder")}
			>
				<MyIconButtonIcon
					className={
						"FileNodeViewToolbarFolderActions-action-icon" satisfies FileNodeViewToolbarFolderActions_ClassNames
					}
				>
					<FolderPlus />
				</MyIconButtonIcon>
			</MyIconButton>
		</div>
	);
});

// #endregion folder actions

// #region file download action
type FileNodeViewToolbarFileDownloadAction_ClassNames =
	| "FileNodeViewToolbarFileDownloadAction"
	| "FileNodeViewToolbarFileDownloadAction-button"
	| "FileNodeViewToolbarFileDownloadAction-button-icon";

type FileNodeViewToolbarFileDownloadAction_Props = {
	node: app_convex_Doc<"files_nodes"> | null | undefined;
};

const FileNodeViewToolbarFileDownloadAction = memo(function FileNodeViewToolbarFileDownloadAction(
	props: FileNodeViewToolbarFileDownloadAction_Props,
) {
	const { node } = props;

	const convex = useConvex();

	const { membershipId } = AppTenantProvider.useContext();

	const downloadCandidates: { fileNodeId: app_convex_Id<"files_nodes">; label: string }[] = [];
	if (node?.kind === "file") {
		if (node.assetId) {
			downloadCandidates.push({
				fileNodeId: node._id,
				label: node.name,
			});
		}
	}

	const [downloadingFileNodeId, setDownloadingFileNodeId] = useState<app_convex_Id<"files_nodes"> | null>(null);
	const isDownloading = downloadingFileNodeId !== null;

	const handleDownload = useFn((fileNodeId: app_convex_Id<"files_nodes">) => {
		if (!node || isDownloading) {
			return;
		}
		const downloadCandidate = downloadCandidates.find((candidate) => candidate.fileNodeId === fileNodeId);

		setDownloadingFileNodeId(fileNodeId);
		void convex
			.action(app_convex_api.r2.create_signed_download_url, {
				membershipId,
				fileNodeId,
			})
			.then(async (signedDownloadUrl) => {
				if (signedDownloadUrl._nay) {
					console.error("[FileNodeViewToolbarFileDownloadAction.handleDownload] Failed to create download URL", {
						result: signedDownloadUrl,
						fileNodeId,
					});
					toast.error(signedDownloadUrl._nay.message ?? "Failed to create download URL");
					return;
				}

				const response = await fetch(signedDownloadUrl._yay.url);
				if (!response.ok) {
					console.error("[FileNodeViewToolbarFileDownloadAction.handleDownload] Failed to fetch download", {
						status: response.status,
						fileNodeId,
					});
					toast.error("Failed to download file");
					return;
				}

				const responseBlob = await response.blob();
				files_download_blob({
					blob: responseBlob,
					filename: downloadCandidate?.label ?? node.name,
				});
			})
			.catch((error) => {
				console.error("[FileNodeViewToolbarFileDownloadAction.handleDownload] Error downloading file", {
					error,
					fileNodeId,
				});
				toast.error(error instanceof Error ? error.message : "Failed to download file");
			})
			.finally(() => {
				setDownloadingFileNodeId(null);
			});
	});

	if (!node || node.kind !== "file" || downloadCandidates.length === 0) {
		return null;
	}

	const singleCandidate = downloadCandidates[0];

	return (
		<div
			role="group"
			aria-label="Download selected file"
			className={"FileNodeViewToolbarFileDownloadAction" satisfies FileNodeViewToolbarFileDownloadAction_ClassNames}
		>
			{downloadCandidates.length === 1 && singleCandidate ? (
				<MyButton
					className={
						"FileNodeViewToolbarFileDownloadAction-button" satisfies FileNodeViewToolbarFileDownloadAction_ClassNames
					}
					variant="ghost-highlightable"
					disabled={isDownloading}
					aria-busy={downloadingFileNodeId === singleCandidate.fileNodeId}
					onClick={() => handleDownload(singleCandidate.fileNodeId)}
				>
					<MyButtonIcon
						className={
							"FileNodeViewToolbarFileDownloadAction-button-icon" satisfies FileNodeViewToolbarFileDownloadAction_ClassNames
						}
					>
						<Download />
					</MyButtonIcon>
					{singleCandidate.label}
				</MyButton>
			) : (
				<MyMenu placement="bottom-start">
					<MyMenuTrigger>
						<MyButton
							className={
								"FileNodeViewToolbarFileDownloadAction-button" satisfies FileNodeViewToolbarFileDownloadAction_ClassNames
							}
							variant="ghost-highlightable"
							disabled={isDownloading}
							aria-busy={isDownloading}
						>
							<MyButtonIcon
								className={
									"FileNodeViewToolbarFileDownloadAction-button-icon" satisfies FileNodeViewToolbarFileDownloadAction_ClassNames
								}
							>
								<Download />
							</MyButtonIcon>
							Download
						</MyButton>
					</MyMenuTrigger>
					<MyMenuPopover>
						<MyMenuPopoverContent>
							{downloadCandidates.map((downloadCandidate) => (
								<MyMenuItem
									key={downloadCandidate.fileNodeId}
									disabled={isDownloading}
									onClick={() => handleDownload(downloadCandidate.fileNodeId)}
								>
									<MyMenuItemContent>
										<MyMenuItemContentIcon>
											<Download />
										</MyMenuItemContentIcon>
										<MyMenuItemContentPrimary>{downloadCandidate.label}</MyMenuItemContentPrimary>
									</MyMenuItemContent>
								</MyMenuItem>
							))}
						</MyMenuPopoverContent>
					</MyMenuPopover>
				</MyMenu>
			)}
		</div>
	);
});

// #endregion file download action

type FileNodeViewToolbar_ClassNames =
	| "FileNodeViewToolbar"
	| "FileNodeViewToolbar-surface"
	| "FileNodeViewToolbar-editor-actions";

type FileNodeViewToolbar_Props = {
	editorActionsRef: React.Ref<HTMLDivElement>;
	folderActionsSlot: React.ReactNode;
	fileActionsSlot: React.ReactNode;
};

const FileNodeViewToolbar = memo(function FileNodeViewToolbar(props: FileNodeViewToolbar_Props) {
	const { editorActionsRef, folderActionsSlot, fileActionsSlot } = props;

	return (
		<div className={"FileNodeViewToolbar" satisfies FileNodeViewToolbar_ClassNames}>
			<div
				role="toolbar"
				aria-label="File actions"
				className={"FileNodeViewToolbar-surface" satisfies FileNodeViewToolbar_ClassNames}
			>
				{folderActionsSlot}
				{fileActionsSlot}
				<div
					id={FILE_NODE_VIEW_TOOLBAR_EDITOR_ACTIONS_ID}
					ref={editorActionsRef}
					className={"FileNodeViewToolbar-editor-actions" satisfies FileNodeViewToolbar_ClassNames}
				></div>
			</div>
		</div>
	);
});
// #endregion toolbar

// #region folder create node modal
type FileNodeViewFolderCreateNodeModal_ClassNames =
	| "FileNodeViewFolderCreateNodeModal"
	| "FileNodeViewFolderCreateNodeModal-form"
	| "FileNodeViewFolderCreateNodeModal-field"
	| "FileNodeViewFolderCreateNodeModal-validation";

type FileNodeViewFolderCreateNodeModal_Ref = {
	open: (kind: app_convex_Doc<"files_nodes">["kind"]) => void;
};

type FileNodeViewFolderCreateNodeModal_Props = {
	ref: React.Ref<FileNodeViewFolderCreateNodeModal_Ref>;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderItemId: FileNodeViewFolder_Props["folderItemId"];
	fileNodesList: FileNodeViewFolder_Props["fileNodesList"];
	siblingNames: Iterable<string>;
	isCreatingNode: boolean;
	onCreateNode: (args: { kind: app_convex_Doc<"files_nodes">["kind"]; path: string }) => Promise<string | null>;
};

const FileNodeViewFolderCreateNodeModal = memo(function FileNodeViewFolderCreateNodeModal(
	props: FileNodeViewFolderCreateNodeModal_Props,
) {
	const { ref, membershipId, folderItemId, fileNodesList, siblingNames, isCreatingNode, onCreateNode } = props;

	const [kind, setKind] = useState<app_convex_Doc<"files_nodes">["kind"] | null>(null);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const renderPromise = useRenderPromise();

	const kindLabel = kind === "folder" ? "folder" : "file";
	const nodePathValidation = files_get_node_path_validation({
		scopeId: membershipId,
		parentId: folderItemId,
		fileNodesList,
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
		const normalizedPath = files_get_normalized_node_path_segments({ kind, nameOrPath: trimmedName });
		if (!normalizedPath || "validationMessage" in normalizedPath) {
			setError(normalizedPath?.validationMessage ?? `Enter a ${kind} name.`);
			return;
		}

		setError(null);
		onCreateNode({ kind, path: normalizedPath.normalizedPathSegments.join("/") })
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

	// Keep native validity and the explicit visible-invalid class in sync with the app helper.
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
						<MyInput className={cn(displayedValidationMessage && "userInvalid")}>
							<MyInputLabel>Name</MyInputLabel>
							<MyInputBackground />
							<MyInputArea>
								<MyInputControl
									ref={inputRef}
									autoFocus
									required
									value={name}
									disabled={isCreatingNode}
									onChange={handleNameChange}
								/>
							</MyInputArea>
							<MyInputBox />
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

type FileNodeViewToolbarCreateNodeActions_Props = {
	children: (folderActionsSlot: FileNodeViewToolbar_Props["folderActionsSlot"]) => React.ReactNode;
	folderItemId: FileNodeViewFolder_Props["folderItemId"] | null;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	fileNodesList: FileNodeViewFolder_Props["fileNodesList"];
};

const FileNodeViewToolbarCreateNodeActions = memo(function FileNodeViewToolbarCreateNodeActions(
	props: FileNodeViewToolbarCreateNodeActions_Props,
) {
	const { children, folderItemId, membershipId, fileNodesList } = props;

	const convex = useConvex();

	const createNodeModalRef = useRef<FileNodeViewFolderCreateNodeModal_Ref | null>(null);
	const [isCreatingNode, setIsCreatingNode] = useState(false);

	const siblingNames =
		folderItemId && fileNodesList
			? fileNodesList
					.filter((item) => item.parentId === folderItemId && item.archiveOperationId === undefined)
					.map((child) => child.name)
			: [];

	const handleCreateNodeModalOpen = useFn((kind: app_convex_Doc<"files_nodes">["kind"]) => {
		if (!folderItemId) {
			return;
		}

		createNodeModalRef.current?.open(kind);
	});

	const handleCreateNodeSubmit = useFn((args: { kind: app_convex_Doc<"files_nodes">["kind"]; path: string }) => {
		const { kind, path } = args;
		if (!folderItemId) {
			return Promise.resolve("Select a folder before creating a node.");
		}

		setIsCreatingNode(true);
		const createNodePromise =
			kind === "folder"
				? convex.mutation(app_convex_api.files_nodes.create_folder_node, {
						membershipId,
						parentId: folderItemId,
						path,
					})
				: convex.action(app_convex_api.files_nodes.create_markdown_node, {
						membershipId,
						parentId: folderItemId,
						path,
					});

		return createNodePromise
			.then((result) => {
				if (result._nay) {
					console.error("[FileNodeViewToolbarCreateNodeActions.handleCreateNodeSubmit] Failed to create node", {
						result,
						folderItemId,
						kind,
					});
					return result._nay.message;
				}

				return null;
			})
			.catch((error) => {
				console.error("[FileNodeViewToolbarCreateNodeActions.handleCreateNodeSubmit] Error creating node", {
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

	const folderActionsSlot = folderItemId ? (
		<FileNodeViewToolbarFolderActions disabled={isCreatingNode} onCreateNode={handleCreateNodeModalOpen} />
	) : null;

	return (
		<>
			{folderItemId && (
				<FileNodeViewFolderCreateNodeModal
					ref={createNodeModalRef}
					membershipId={membershipId}
					folderItemId={folderItemId}
					fileNodesList={fileNodesList}
					siblingNames={siblingNames}
					isCreatingNode={isCreatingNode}
					onCreateNode={handleCreateNodeSubmit}
				/>
			)}
			{children(folderActionsSlot)}
		</>
	);
});
// #endregion folder create node modal

// #region folder body
type FileNodeViewFolderBody_ClassNames = "FileNodeViewFolderBody";

type FileNodeViewFolderBody_CssVars = {
	"--FileNodeViewFolderBody-top-safe-area": string;
};

type FileNodeViewFolderBody_Props = {
	topSafeArea: number;
	children: React.ReactNode;
};

const FileNodeViewFolderBody = memo(function FileNodeViewFolderBody(props: FileNodeViewFolderBody_Props) {
	const { topSafeArea, children } = props;

	return (
		<div
			className={"FileNodeViewFolderBody" satisfies FileNodeViewFolderBody_ClassNames}
			style={sx({
				"--FileNodeViewFolderBody-top-safe-area": `${topSafeArea}px`,
			} satisfies Partial<FileNodeViewFolderBody_CssVars>)}
		>
			{children}
		</div>
	);
});
// #endregion folder body

// #region folder explorer row
type FileNodeViewFolderExplorerRow_ClassNames =
	| "FileNodeViewFolderExplorer-row"
	| "FileNodeViewFolderExplorer-row-dragging"
	| "FileNodeViewFolderExplorer-row-drop-target"
	| "FileNodeViewFolderExplorer-row-action"
	| "FileNodeViewFolderExplorer-cell"
	| "FileNodeViewFolderExplorer-cell-name"
	| "FileNodeViewFolderExplorer-cell-updated-by"
	| "FileNodeViewFolderExplorer-cell-updated"
	| "FileNodeViewFolderExplorer-cell-actions"
	| "FileNodeViewFolderExplorer-link"
	| "FileNodeViewFolderExplorer-icon"
	| "FileNodeViewFolderExplorer-more-action";

type FileNodeViewFolderExplorerRow_Props = {
	child: files_VisibleTreeNode;
	editorMode: FileEditor_Mode;
	organizationName: string;
	workspaceName: string;
	isPendingAction: boolean;
	canMoveFileNodeToParent: (args: {
		fileNodeId: app_convex_Id<"files_nodes">;
		targetParentId: app_convex_Doc<"files_nodes">["parentId"];
	}) => boolean;
	onArchiveNode: (nodeId: app_convex_Id<"files_nodes">) => void;
	onMoveFileNodesToParent: (args: {
		fileNodeIds: app_convex_Id<"files_nodes">[];
		targetParentId: app_convex_Doc<"files_nodes">["parentId"];
	}) => void;
};

const FileNodeViewFolderExplorerRow = memo(function FileNodeViewFolderExplorerRow(
	props: FileNodeViewFolderExplorerRow_Props,
) {
	const {
		child,
		editorMode,
		organizationName,
		workspaceName,
		isPendingAction,
		canMoveFileNodeToParent,
		onArchiveNode,
		onMoveFileNodesToParent,
	} = props;

	const rowRef = useRef<HTMLDivElement | null>(null);
	const [isDragging, setIsDragging] = useState(false);
	const [isDropTarget, setIsDropTarget] = useState(false);

	useEffect(() => {
		const element = rowRef.current;
		if (!element) {
			return;
		}

		const cleanupFns: Array<() => void> = [];

		if (!isPendingAction) {
			cleanupFns.push(
				draggable({
					element,
					getInitialData: (): FileNodeViewFolderExplorerDragData => ({
						type: files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE,
						fileNodeId: child._id,
					}),
					// Keep folder-table drags compatible with the Headless Tree sidebar foreign-drop path.
					getInitialDataForExternal: () => ({
						[files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE]: child._id,
					}),
					onDragStart() {
						setIsDragging(true);
					},
					onDrop() {
						setIsDragging(false);
					},
				}),
			);
		}

		if (child.kind === "folder" && !isPendingAction) {
			cleanupFns.push(
				dropTargetForElements({
					element,
					canDrop({ source }) {
						return (
							is_file_node_view_folder_explorer_drag_data(source.data) &&
							canMoveFileNodeToParent({
								fileNodeId: source.data.fileNodeId,
								targetParentId: child._id,
							})
						);
					},
					getDropEffect: () => "move",
					onDragEnter({ source }) {
						if (
							is_file_node_view_folder_explorer_drag_data(source.data) &&
							canMoveFileNodeToParent({
								fileNodeId: source.data.fileNodeId,
								targetParentId: child._id,
							})
						) {
							setIsDropTarget(true);
						}
					},
					onDragLeave() {
						setIsDropTarget(false);
					},
					onDrop({ source }) {
						setIsDropTarget(false);
						if (!is_file_node_view_folder_explorer_drag_data(source.data)) {
							return;
						}
						if (
							!canMoveFileNodeToParent({
								fileNodeId: source.data.fileNodeId,
								targetParentId: child._id,
							})
						) {
							return;
						}

						onMoveFileNodesToParent({
							fileNodeIds: [source.data.fileNodeId],
							targetParentId: child._id,
						});
					},
				}),
			);
		}

		if (cleanupFns.length === 0) {
			return;
		}

		return combine(...cleanupFns);
	}, [canMoveFileNodeToParent, child._id, child.kind, isPendingAction, onMoveFileNodesToParent]);

	return (
		<MyGridTableRow
			ref={rowRef}
			className={cn(
				"FileNodeViewFolderExplorer-row" satisfies FileNodeViewFolderExplorerRow_ClassNames,
				isDragging && ("FileNodeViewFolderExplorer-row-dragging" satisfies FileNodeViewFolderExplorerRow_ClassNames),
				isDropTarget &&
					("FileNodeViewFolderExplorer-row-drop-target" satisfies FileNodeViewFolderExplorerRow_ClassNames),
			)}
			data-file-node-id={child._id}
		>
			<Link
				aria-label={`Open ${child.name}`}
				className={"FileNodeViewFolderExplorer-row-action" satisfies FileNodeViewFolderExplorerRow_ClassNames}
				to="/w/$organizationName/$workspaceName/files"
				params={{ organizationName, workspaceName }}
				search={{ nodeId: child._id, view: editorMode }}
				draggable={false}
			/>
			<MyGridTableCell
				className={cn(
					"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
					"FileNodeViewFolderExplorer-cell-name" satisfies FileNodeViewFolderExplorerRow_ClassNames,
				)}
			>
				<MyIcon className={"FileNodeViewFolderExplorer-icon" satisfies FileNodeViewFolderExplorerRow_ClassNames}>
					{child.kind === "folder" ? <Folder /> : <FileText />}
				</MyIcon>
				<span className={"FileNodeViewFolderExplorer-link" satisfies FileNodeViewFolderExplorerRow_ClassNames}>
					{child.name}
				</span>
			</MyGridTableCell>
			<MyGridTableCell
				className={cn(
					"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
					"FileNodeViewFolderExplorer-cell-updated-by" satisfies FileNodeViewFolderExplorerRow_ClassNames,
				)}
			>
				{child.updatedBy || "Unknown"}
			</MyGridTableCell>
			<MyGridTableCell
				className={cn(
					"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
					"FileNodeViewFolderExplorer-cell-updated" satisfies FileNodeViewFolderExplorerRow_ClassNames,
				)}
			>
				{format_relative_time(child.updatedAt)}
			</MyGridTableCell>
			<MyGridTableCell
				className={cn(
					"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
					"FileNodeViewFolderExplorer-cell-actions" satisfies FileNodeViewFolderExplorerRow_ClassNames,
				)}
			>
				<MyMenu placement="bottom-end">
					<MyMenuTrigger>
						<MyIconButton
							className={"FileNodeViewFolderExplorer-more-action" satisfies FileNodeViewFolderExplorerRow_ClassNames}
							variant="ghost-highlightable"
							tooltip="More actions"
							disabled={isPendingAction}
							aria-label={`More actions for ${child.name}`}
						>
							<MyIconButtonIcon>
								<EllipsisVertical />
							</MyIconButtonIcon>
						</MyIconButton>
					</MyMenuTrigger>
					<MyMenuPopover unmountOnHide>
						<MyMenuPopoverContent>
							<MyMenuItem
								variant="destructive"
								disabled={isPendingAction}
								hideOnClick
								onClick={() => onArchiveNode(child._id)}
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
});
// #endregion folder explorer row

// #region folder explorer
type FileNodeViewFolderExplorer_ClassNames =
	| "FileNodeViewFolderExplorer"
	| "FileNodeViewFolderExplorer-table"
	| "FileNodeViewFolderExplorer-show-more"
	| "FileNodeViewFolderExplorer-show-less";

type FileNodeViewFolderExplorer_Props = {
	visibleChildItems: files_VisibleTreeNode[];
	hiddenChildItemsCount: number;
	editorMode: FileEditor_Mode;
	organizationName: string;
	workspaceName: string;
	pendingActionNodeIds: ReadonlySet<string>;
	canMoveFileNodeToParent: (args: {
		fileNodeId: app_convex_Id<"files_nodes">;
		targetParentId: app_convex_Doc<"files_nodes">["parentId"];
	}) => boolean;
	onArchiveNode: (nodeId: app_convex_Id<"files_nodes">) => void;
	onMoveFileNodesToParent: (args: {
		fileNodeIds: app_convex_Id<"files_nodes">[];
		targetParentId: app_convex_Doc<"files_nodes">["parentId"];
	}) => void;
	onShowMoreClick: () => void;
	canShowLess: boolean;
	onShowLessClick: () => void;
};

const FileNodeViewFolderExplorer = memo(function FileNodeViewFolderExplorer(props: FileNodeViewFolderExplorer_Props) {
	const {
		visibleChildItems,
		hiddenChildItemsCount,
		editorMode,
		organizationName,
		workspaceName,
		pendingActionNodeIds,
		canMoveFileNodeToParent,
		onArchiveNode,
		onMoveFileNodesToParent,
		onShowMoreClick,
		canShowLess,
		onShowLessClick,
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
							const isPendingAction = pendingActionNodeIds.has(child._id);

							return (
								<FileNodeViewFolderExplorerRow
									key={child._id}
									child={child}
									editorMode={editorMode}
									organizationName={organizationName}
									workspaceName={workspaceName}
									isPendingAction={isPendingAction}
									canMoveFileNodeToParent={canMoveFileNodeToParent}
									onArchiveNode={onArchiveNode}
									onMoveFileNodesToParent={onMoveFileNodesToParent}
								/>
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

			{canShowLess && (
				<MyButton
					className={"FileNodeViewFolderExplorer-show-less" satisfies FileNodeViewFolderExplorer_ClassNames}
					variant="outline"
					onClick={onShowLessClick}
				>
					Show less
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
	fileNodesList: FileNodeViewContent_Props["fileNodesList"];
	isCreatingReadme: boolean;
	onCreateReadmeClick: () => void;
};

const FileNodeViewFolderReadme = memo(function FileNodeViewFolderReadme(props: FileNodeViewFolderReadme_Props) {
	const { readmeNodeId, fileNodesList, isCreatingReadme, onCreateReadmeClick } = props;

	return (
		<section className={"FileNodeViewFolderReadme" satisfies FileNodeViewFolderReadme_ClassNames}>
			{readmeNodeId ? (
				<div className={"FileNodeViewFolderReadme-header" satisfies FileNodeViewFolderReadme_ClassNames}>
					<MyIcon className={"FileNodeViewFolderReadme-icon" satisfies FileNodeViewFolderReadme_ClassNames}>
						<BookOpen />
					</MyIcon>
					<h2 className={"FileNodeViewFolderReadme-title" satisfies FileNodeViewFolderReadme_ClassNames}>README.md</h2>
				</div>
			) : fileNodesList === undefined ? (
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
	toolbarPortalHost: HTMLElement;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
	topViewZoneSlot?: React.ReactNode;
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
		onEditorModeChange,
		topViewZoneSlot,
	} = props;

	return (
		<div className={"FileNodeViewFolderReadmeEditor" satisfies FileNodeViewFolderReadmeEditor_ClassNames}>
			<FileNodeViewFileEditor
				key={readmeNodeId}
				nodeId={readmeNodeId}
				pendingUpdateId={pendingUpdateId}
				serverSequence={serverSequence}
				editorMode={editorMode}
				presenceStore={presenceStore}
				commentsPortalHost={commentsPortalHost}
				toolbarPortalHost={toolbarPortalHost}
				onEditorModeChange={onEditorModeChange}
				topViewZoneSlot={topViewZoneSlot}
			/>
		</div>
	);
});
// #endregion folder readme editor

// #region content
type FileNodeViewContent_Props = {
	selectedNodeId: string | null | undefined;
	node: app_convex_Doc<"files_nodes"> | null | undefined;
	fileNodesList: files_VisibleTreeNode[] | undefined;
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	serverSequence?: number;
	topSafeArea: number;
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	presenceStore: FileEditor_Props["presenceStore"];
	onlineUsers: FileEditor_OnlineUser[];
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	onEditorModeChange: (mode: FileEditor_Mode) => void;
};

const FileNodeViewContent = memo(function FileNodeViewContent(props: FileNodeViewContent_Props) {
	const {
		selectedNodeId,
		node,
		fileNodesList,
		pendingUpdateId,
		serverSequence,
		topSafeArea,
		editorMode,
		filesSidebarOpen,
		presenceStore,
		onlineUsers,
		commentsPortalHost,
		toolbarPortalHost,
		onEditorModeChange,
	} = props;

	if (selectedNodeId === files_ROOT_ID) {
		return (
			<>
				<FileNodeViewHeaderPortal
					selectedNodeId={files_ROOT_ID}
					fileNodesList={fileNodesList}
					editorMode={editorMode}
					filesSidebarOpen={filesSidebarOpen}
					showFileControls={true}
					onlineUsers={onlineUsers}
					onEditorModeChange={onEditorModeChange}
				/>
				<FileNodeViewFolder
					folderItemId={files_ROOT_ID}
					fileNodesList={fileNodesList}
					pendingUpdateId={pendingUpdateId}
					serverSequence={serverSequence}
					topSafeArea={topSafeArea}
					editorMode={editorMode}
					presenceStore={presenceStore}
					commentsPortalHost={commentsPortalHost}
					toolbarPortalHost={toolbarPortalHost}
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
					fileNodesList={fileNodesList}
					editorMode={editorMode}
					filesSidebarOpen={filesSidebarOpen}
					showFileControls={true}
					onlineUsers={onlineUsers}
					onEditorModeChange={onEditorModeChange}
				/>
				<FileNodeViewFolder
					folderItemId={node._id}
					fileNodesList={fileNodesList}
					pendingUpdateId={pendingUpdateId}
					serverSequence={serverSequence}
					topSafeArea={topSafeArea}
					editorMode={editorMode}
					presenceStore={presenceStore}
					commentsPortalHost={commentsPortalHost}
					toolbarPortalHost={toolbarPortalHost}
					onEditorModeChange={onEditorModeChange}
				/>
			</>
		);
	}

	if (!files_node_has_editable_yjs_state(node)) {
		return (
			<FileNodeViewStoredFile
				node={node}
				fileNodesList={fileNodesList}
				editorMode={editorMode}
				filesSidebarOpen={filesSidebarOpen}
				onlineUsers={onlineUsers}
			/>
		);
	}

	return (
		<FileNodeViewFile
			node={node}
			fileNodesList={fileNodesList}
			pendingUpdateId={pendingUpdateId}
			serverSequence={serverSequence}
			topSafeArea={topSafeArea}
			editorMode={editorMode}
			filesSidebarOpen={filesSidebarOpen}
			presenceStore={presenceStore}
			onlineUsers={onlineUsers}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			onEditorModeChange={onEditorModeChange}
		/>
	);
});
// #endregion content

// #region top sticky floating container
type FileNodeViewTopStickyFloatingContainer_ClassNames = "FileNodeViewTopStickyFloatingContainer";

type FileNodeViewTopStickyFloatingContainer_Props = {
	children: React.ReactNode;
};

const FileNodeViewTopStickyFloatingContainer = memo(function FileNodeViewTopStickyFloatingContainer(
	props: FileNodeViewTopStickyFloatingContainer_Props,
) {
	const { children } = props;

	return (
		<div
			className={"FileNodeViewTopStickyFloatingContainer" satisfies FileNodeViewTopStickyFloatingContainer_ClassNames}
		>
			{children}
		</div>
	);
});
// #endregion top sticky floating container

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

const DEFAULT_PANEL_LAYOUT = [24, 76] satisfies [number, number];
const DEFAULT_EDITOR_PANEL_LAYOUT = [75, 25] satisfies [number, number];

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
	const panelLayoutRef = useRef(savedPanelLayout ?? DEFAULT_PANEL_LAYOUT);
	const editorPanelLayoutRef = useRef(savedEditorPanelLayout ?? DEFAULT_EDITOR_PANEL_LAYOUT);
	const filesSidebarState: FileNodeView_SidebarState = filesSidebarOpen ? "expanded" : "closed";
	const [commentsPortalHost, setCommentsPortalHost] = useState<HTMLElement | null>(null);
	const [toolbarPortalHost, setToolbarPortalHost] = useState<HTMLElement | null>(null);

	const [lastOpenNodeId, setLastOpenNodeId] = useAppLocalStorageStateValue(
		`app_state::files_last_open::scope::${membershipId}`,
	);

	const searchNodeId = searchParams.nodeId;
	const isRootNodeSelected = searchNodeId === files_ROOT_ID;

	const fileNodesList = useStableQuery(app_convex_api.files_nodes.list_tree, { membershipId });

	const resolvedNode = useStableQuery(
		app_convex_api.files_nodes.get_file_node_for_membership,
		searchNodeId && !isRootNodeSelected
			? {
					membershipId,
					fileNodeId: searchNodeId,
				}
			: "skip",
	);
	const resolvedNodeId = isRootNodeSelected ? files_ROOT_ID : (resolvedNode?._id ?? null);
	// Keep create actions scoped to the visible folder/root selection; file views use this toolbar only for editor actions.
	const targetFolderId = isRootNodeSelected ? files_ROOT_ID : resolvedNode?.kind === "folder" ? resolvedNode._id : null;
	const resolvedNodeHasEditableYjsState = files_node_has_editable_yjs_state(resolvedNode);

	// Treat a folder README as the active editor node so pending-update and sync subscriptions
	// have the same owner for selected files and folder README editors.
	const activeEditorNodeId = isRootNodeSelected
		? get_folder_readme_node_id(fileNodesList, files_ROOT_ID)
		: resolvedNode && resolvedNode.kind === "file"
			? resolvedNodeHasEditableYjsState
				? resolvedNode._id
				: null
			: resolvedNode?.kind === "folder"
				? get_folder_readme_node_id(fileNodesList, resolvedNode._id)
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

	const handleToolbarPortalHostChange = useFn((element: HTMLDivElement | null) => {
		setToolbarPortalHost(element);
	});

	// The pager/floating bar reviews diffs, so count only content-bearing rows; pure moves are
	// reviewed in the Pending panel only.
	const pendingUpdates = (allPendingUpdatesResult ?? []).filter(files_pending_update_has_yjs_content);
	const hasPendingUpdates = pendingUpdates.length > 0;
	// 44px = 40px for the floating content area plus 4px of spacing.
	// Keep this reserve visible even without pending updates so folder and file content
	// start below the route toolbar with the same top breathing room.
	const topSafeArea = FILE_NODE_VIEW_TOP_SAFE_AREA;
	const currentPendingUpdateIndex = activeEditorNodeId
		? pendingUpdates.findIndex((pendingUpdate) => pendingUpdate.fileNodeId === activeEditorNodeId)
		: -1;
	const currentPendingUpdate = pendingUpdates[currentPendingUpdateIndex];
	const hasCurrentPendingUpdates = currentPendingUpdateIndex >= 0;
	const activePendingUpdateIndex = hasCurrentPendingUpdates ? currentPendingUpdateIndex : 0;
	const canNavigatePendingUpdates =
		pendingUpdates.length > 1 || (pendingUpdates.length === 1 && !hasCurrentPendingUpdates);
	const reviewPagerLabel = hasCurrentPendingUpdates
		? `${activePendingUpdateIndex + 1} of ${pendingUpdates.length}`
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
				nodeId: pendingUpdates[0].fileNodeId,
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
			nodeId: nextPendingUpdate.fileNodeId,
			forceDiffEditor: !hasCurrentPendingUpdates,
		});
	});

	const handleNavigatePendingUpdatesPrevious = useFn(() => {
		handleNavigatePendingUpdatesDirection("prev");
	});

	const handleNavigatePendingUpdatesNext = useFn(() => {
		handleNavigatePendingUpdatesDirection("next");
	});

	// One shared floating surface; the component hides itself when there is nothing to show.
	const topStickyFloatingSlot = (
		<FileNodeViewTopFloating
			nodeId={resolvedNode?.kind === "file" ? resolvedNode._id : null}
			pendingSlot={
				hasPendingUpdates ? (
					<FileEditorPendingUpdatesFloating
						updatedAt={currentPendingUpdate?.updatedAt}
						showReviewButton={hasCurrentPendingUpdates && effectiveView !== "diff_editor"}
						reviewPagerLabel={reviewPagerLabel}
						canNavigate={canNavigatePendingUpdates}
						onReviewChanges={handleReviewPendingUpdates}
						onNavigatePrevious={handleNavigatePendingUpdatesPrevious}
						onNavigateNext={handleNavigatePendingUpdatesNext}
					/>
				) : null
			}
		/>
	);

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

	const handlePanelReset = useFn<NonNullable<React.ComponentProps<typeof MyPanelGroup>["onLayoutReset"]>>((layout) => {
		panelLayoutRef.current = layout;
		setMainPanelLayout(null);
	});

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

	const handleEditorPanelReset = useFn<NonNullable<React.ComponentProps<typeof MyPanelGroup>["onLayoutReset"]>>(
		(layout) => {
			editorPanelLayoutRef.current = layout;
			setEditorPanelLayout(null);
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

	const renderContent = (
		presenceProps: Parameters<FileEditorPresenceSupplier_Props["children"]>[0],
		toolbarPortalHost: HTMLElement,
	) => {
		return resolvedNodeId ? (
			<FileNodeViewContent
				selectedNodeId={searchNodeId}
				node={resolvedNode}
				fileNodesList={fileNodesList}
				pendingUpdateId={currentPendingUpdate?._id}
				serverSequence={activeEditorServerSequenceData?.lastSequence}
				topSafeArea={topSafeArea}
				editorMode={effectiveView}
				filesSidebarOpen={filesSidebarOpen}
				presenceStore={presenceProps.presenceStore}
				onlineUsers={presenceProps.onlineUsers}
				commentsPortalHost={commentsPortalHost}
				toolbarPortalHost={toolbarPortalHost}
				onEditorModeChange={navigateToView}
			/>
		) : searchNodeId ? (
			<div className={"FileNodeView-loading-text" satisfies FileNodeView_ClassNames}>Loading...</div>
		) : null;
	};

	return (
		<MyPanelGroup
			className={"FileNodeView" satisfies FileNodeView_ClassNames}
			defaultLayout={DEFAULT_PANEL_LAYOUT}
			direction="horizontal"
			onLayout={handlePanelLayout}
			onLayoutReset={handlePanelReset}
		>
			<MyPanel
				defaultSize={savedPanelLayout?.[0] ?? DEFAULT_PANEL_LAYOUT[0]}
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
			<MyPanelResizeHandle
				isOpen={filesSidebarOpen}
				closeBehavior="unmount"
				aria-label="Resize files sidebar"
				onDragging={handlePanelDragging}
			/>
			<MyPanel
				defaultSize={filesSidebarState === "closed" ? 100 : (savedPanelLayout?.[1] ?? DEFAULT_PANEL_LAYOUT[1])}
				minSize={40}
				className={"FileNodeView-main-panel" satisfies FileNodeView_ClassNames}
			>
				<div className={"FileNodeView-editor-area" satisfies FileNodeView_ClassNames}>
					<MyPanelGroup
						className={"FileNodeView-content-group" satisfies FileNodeView_ClassNames}
						defaultLayout={DEFAULT_EDITOR_PANEL_LAYOUT}
						direction="horizontal"
						onLayout={handleEditorPanelLayout}
						onLayoutReset={handleEditorPanelReset}
						style={{
							height: "max-content",
							overflow: "visible",
						}}
					>
						<MyPanel
							defaultSize={savedEditorPanelLayout?.[0] ?? DEFAULT_EDITOR_PANEL_LAYOUT[0]}
							minSize={40}
							className={"FileNodeView-content-panel" satisfies FileNodeView_ClassNames}
							style={contentPanelStyle}
						>
							<FileNodeViewToolbarCreateNodeActions
								membershipId={membershipId}
								folderItemId={targetFolderId}
								fileNodesList={fileNodesList}
							>
								{(folderActionsSlot) => (
									<FileNodeViewToolbar
										editorActionsRef={handleToolbarPortalHostChange}
										folderActionsSlot={folderActionsSlot}
										fileActionsSlot={<FileNodeViewToolbarFileDownloadAction node={resolvedNode} />}
									/>
								)}
							</FileNodeViewToolbarCreateNodeActions>
							{topStickyFloatingSlot ? (
								<FileNodeViewTopStickyFloatingContainer>{topStickyFloatingSlot}</FileNodeViewTopStickyFloatingContainer>
							) : null}
							{/* Wait for the toolbar action slot before mounting editor content so editor portals receive a host. */}
							{toolbarPortalHost && activeEditorNodeId ? (
								<FileEditorPresenceSupplier userId={authenticated.userId} nodeId={activeEditorNodeId}>
									{(presenceProps) => renderContent(presenceProps, toolbarPortalHost)}
								</FileEditorPresenceSupplier>
							) : toolbarPortalHost ? (
								renderContent({ presenceStore: null, onlineUsers: [] }, toolbarPortalHost)
							) : null}
						</MyPanel>
						<MyPanelResizeHandle
							aria-label="Resize comments and agent sidebar"
							onDragging={handleEditorPanelDragging}
						/>
						<MyPanel
							className={"FileNodeView-editor-sidebar-panel" satisfies FileNodeView_ClassNames}
							collapsible={false}
							defaultSize={savedEditorPanelLayout?.[1] ?? DEFAULT_EDITOR_PANEL_LAYOUT[1]}
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
