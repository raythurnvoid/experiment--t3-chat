import "./file-node-view.css";

import { AppAuthProvider } from "@/components/app-auth.tsx";
import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
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
	type FileEditor_Ref,
} from "@/components/files/file-editor/file-editor.tsx";
import { FileHtmlPreview, type FileHtmlPreview_Source } from "./file-html-preview.tsx";
import { FilesBrowser } from "./files-browser.tsx";
import {
	FileNodeViewFolderCreateNodeModal,
	type FileNodeViewFolderCreateNodeModal_Ref,
} from "./file-node-view-folder-create-node-modal.tsx";
import { FilesSidebarToggle } from "../files-sidebar-toggle.tsx";
import { FilesShareModal } from "../files-share-modal.tsx";
import { FilesPropertiesModal } from "../files-properties-modal.tsx";
import { FilesClipboardMenuItems, FilesClipboardProvider, FilesClipboardToolbar } from "../files-clipboard.tsx";
import { MainAppHeaderBillingIndicator } from "@/components/main-app-header-billing-indicator.tsx";
import { MainAppSidebarToggle } from "@/components/main-app-sidebar-toggle.tsx";
import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyFloatingSurface } from "@/components/my-floating-surface.tsx";
import { MyGridTable, MyGridTableBody, MyGridTableCell, MyGridTableRow } from "@/components/my-grid-table.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyLink, MyLinkIcon } from "@/components/my-link.tsx";
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
import {
	MySearchSelect,
	MySearchSelectItem,
	MySearchSelectList,
	MySearchSelectPopover,
	MySearchSelectPopoverContent,
	MySearchSelectPopoverScrollableArea,
	MySearchSelectSearch,
	MySearchSelectTrigger,
} from "@/components/my-search-select.tsx";
import { MySeparator } from "@/components/my-separator.tsx";
import { MySkeleton } from "@/components/my-skeleton.tsx";
import { MySpinner } from "@/components/my-spinner.tsx";
import { PluginsUiFrame, type PluginsUiFrame_Props } from "@/components/plugins-ui-frame.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { useFilesVisibleEntries } from "@/hooks/files-search-hooks.ts";
import { useFileNodeActivities } from "@/lib/activities.ts";
import { app_convex, app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import { FilesTreeProvider } from "@/lib/files-tree-context.tsx";
import { format_relative_time } from "@/lib/date.ts";
import type { AppClassName, AppElementId } from "@/lib/dom-utils.ts";
import { file_editor_get_content_too_large_message } from "@/lib/file-editor.ts";
import {
	files_ROOT_ID,
	files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE,
	files_can_move_node_between_restricted_scopes,
	files_collect_protected_descendant_ids,
	files_download_blob,
	files_editable_text_content_type_of,
	files_format_size,
	files_get_read_only_capabilities,
	files_get_read_only_row_labels,
	files_get_signed_download_serving,
	files_get_upload_pipeline_state,
	files_monaco_language_id_of_content_type,
	files_node_has_editable_text_content,
	files_pending_update_has_content,
	files_resolve_effective_editor_view,
	type files_EditorView,
	type files_PendingTarget,
	type files_VisibleEntry,
	type files_SpecialFileName,
	type files_VisibleTreeNode,
	type files_YjsRootKind,
} from "@/lib/files.ts";
import { useAppLocalStorageStateValue } from "@/lib/storage.ts";
import { useGlobalCustomEvent } from "@/lib/global-event.tsx";
import { url_path_file_by_node_id } from "@/lib/urls.ts";
import { cn, sx } from "@/lib/utils.ts";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { Link } from "@tanstack/react-router";
import { useConvex, usePaginatedQuery, useQueries, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
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
	Link2,
	Lock,
	LockKeyhole,
	Users,
} from "lucide-react";
import React, { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { FilesSidebar } from "../files-sidebar.tsx";
import {
	files_metadata_MAX_FRONTMATTER_FIELDS,
	files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS,
} from "../../../../shared/files-metadata.ts";
import { plugins_list_file_view_matches } from "../../../../shared/plugins.ts";
import { users_SYSTEM_AUTHOR } from "../../../../shared/users.ts";

type FileNodeViewResolvedNode = NonNullable<
	FunctionReturnType<typeof app_convex_api.files_nodes.get_file_node_for_membership>
>;

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
			node.archiveOperationId === null &&
			node.name.toLowerCase() === ("README.md" satisfies files_SpecialFileName).toLowerCase()
		);
	});

	return readmeNode?._id ?? null;
}

function can_move_file_node_to_parent(args: {
	fileNodesList: files_VisibleTreeNode[] | undefined;
	fileNodeId: app_convex_Id<"files_nodes">;
	targetParentId: app_convex_Doc<"files_nodes">["parentId"];
	canManageRestrictedScope: (scopeNodeId: app_convex_Id<"files_nodes">) => boolean;
}) {
	const fileNode = args.fileNodesList?.find((candidate) => candidate._id === args.fileNodeId);
	if (!fileNode || fileNode.archiveOperationId !== null) {
		return false;
	}
	if (fileNode._id === args.targetParentId || fileNode.parentId === args.targetParentId) {
		return false;
	}

	const targetParent =
		args.targetParentId === files_ROOT_ID
			? undefined
			: args.fileNodesList?.find((candidate) => candidate._id === args.targetParentId);
	if (
		!files_can_move_node_between_restricted_scopes({
			nodeId: fileNode._id,
			sourceRestrictedScopeNodeId: fileNode.restrictedScopeNodeId,
			targetRestrictedScopeNodeId: targetParent?.restrictedScopeNodeId ?? null,
			canManageRestrictedScope: args.canManageRestrictedScope,
		})
	) {
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
	| "FileNodeViewHeader-switch-group";

type FileNodeViewHeader_Props = {
	selectedNodeId: string | null | undefined;
	privateEntry?: Extract<files_VisibleEntry, { kind: "private" }>;
	fileNodesList: files_VisibleTreeNode[] | undefined;
	protectedDescendantIds: ReadonlySet<app_convex_Id<"files_nodes">>;
	filesSidebarOpen: boolean;
	showFileControls: boolean;
	onlineUsers: FileEditor_OnlineUser[];
	onNavigateNode: (nodeId: app_convex_Id<"files_nodes">) => void;
};

const FileNodeViewHeader = memo(function FileNodeViewHeader(props: FileNodeViewHeader_Props) {
	const {
		selectedNodeId,
		privateEntry,
		fileNodesList,
		filesSidebarOpen,
		showFileControls,
		onlineUsers,
	} = props;

	const { organizationName, workspaceName } = AppTenantProvider.useContext();

	const breadcrumbPath = get_breadcrumb_path(fileNodesList, selectedNodeId);

	const currentNode = breadcrumbPath.at(-1);
	const currentNodePath = currentNode?.path;
	const currentNodeLink = selectedNodeId
		? `${window.location.origin}${url_path_file_by_node_id({ organizationName, workspaceName, nodeId: selectedNodeId })}`
		: undefined;
	// Restricted anywhere at or above this node, so the button says "restricted" for a file inside a
	// restricted folder too. The dialog is what explains where the restriction comes from. `null` means
	// nothing restricts it, and the two other values say whether this node is the one carrying the
	// restriction or is only inside one.
	const restrictedState =
		currentNode?.restrictedScopeNodeId == null
			? null
			: currentNode.restrictedScopeNodeId === currentNode._id
				? "self"
				: "inherited";

	const [shareNodeId, setShareNodeId] = useState<app_convex_Id<"files_nodes"> | null>(null);
	const [propertiesNodeId, setPropertiesNodeId] = useState<app_convex_Id<"files_nodes"> | null>(null);
	const propertiesTriggerRef = useRef<HTMLButtonElement>(null);

	const handleShareClick = useFn(() => {
		if (currentNode) {
			setShareNodeId(currentNode._id);
		}
	});

	const handleShareModalClose = useFn(() => {
		setShareNodeId(null);
	});

	const handlePropertiesClick = useFn(() => {
		if (currentNode) {
			setPropertiesNodeId(currentNode._id);
		}
	});

	const handlePropertiesModalClose = useFn(() => {
		setPropertiesNodeId(null);
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
					{privateEntry ? (
						<>
							<li>
								<MyLink
									aria-label="Home"
									className={cn("FileNodeViewHeader-breadcrumb-home" satisfies FileNodeViewHeader_ClassNames)}
									to="/w/$organizationName/$workspaceName/files"
									params={{ organizationName, workspaceName }}
									search={(prev) => ({ ...prev, nodeId: files_ROOT_ID, pendingNodeId: undefined, view: undefined })}
									variant="button-icon-ghost-highlightable"
									tooltip="Home"
								>
									<MyLinkIcon aria-hidden>
										<Home />
									</MyLinkIcon>
								</MyLink>
							</li>
							<li aria-hidden="true">/</li>
							<li
								className={cn("FileNodeViewHeader-breadcrumb-segment-current" satisfies FileNodeViewHeader_ClassNames)}
							>
								{privateEntry.path}
							</li>
							<li>
								<CopyIconButton variant="ghost-highlightable" tooltipCopy="Copy path" text={privateEntry.path} />
							</li>
							<li>
								<CopyIconButton
									variant="ghost-highlightable"
									tooltipCopy="Copy link"
									icon={<Link2 />}
									text={window.location.href}
								/>
							</li>
						</>
					) : selectedNodeId && breadcrumbPath.length > 0 ? (
						<>
							<li>
								<MyLink
									aria-label="Home"
									className={cn("FileNodeViewHeader-breadcrumb-home" satisfies FileNodeViewHeader_ClassNames)}
									to="/w/$organizationName/$workspaceName/files"
									params={{ organizationName, workspaceName }}
									// Keep `q` so the URL stays in step with the still-filled sidebar search box.
									// Drop `view` so the target node opens on its own default editor.
									search={(prev) => ({ ...prev, nodeId: files_ROOT_ID, pendingNodeId: undefined, view: undefined })}
									variant="button-icon-ghost-highlightable"
									tooltip="Home"
								>
									<MyLinkIcon aria-hidden>
										<Home />
									</MyLinkIcon>
								</MyLink>
							</li>
							<li>
								<MyIconButton
									ref={propertiesTriggerRef}
									variant="ghost-highlightable"
									// The lock icon already shows whether the file is locked, so the tooltip says what
									// the button opens instead of repeating that. Keep the word "read-only" in the
									// tooltip of a locked file, because on a locked file the icon is the warning.
									tooltip={currentNode?.canWrite ? "Properties" : "Read-only. Open properties"}
									aria-label={`Properties of ${currentNode?.name}`}
									data-file-write-policy={currentNode?.writePolicyState ?? undefined}
									onClick={handlePropertiesClick}
								>
									<MyIconButtonIcon>
										<LockKeyhole aria-hidden />
									</MyIconButtonIcon>
								</MyIconButton>
							</li>
							{/* Separators are list items too: an `ol` may own only `li`, and a screen reader
							    should not read the slashes out. */}
							<li aria-hidden="true">/</li>
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
													search={(prev) => ({ ...prev, nodeId: item._id, pendingNodeId: undefined, view: undefined })}
													variant="button-tertiary"
												>
													{item.name}
												</MyLink>
											</li>
										)}
										{index < breadcrumbPath.length - 1 && <li aria-hidden="true">/</li>}
									</React.Fragment>
								);
							})}
							<li>
								<CopyIconButton variant="ghost-highlightable" tooltipCopy="Copy path" text={currentNodePath} />
							</li>
							<li>
								<CopyIconButton
									variant="ghost-highlightable"
									tooltipCopy="Copy link"
									icon={<Link2 />}
									text={currentNodeLink}
								/>
							</li>
							{/* One button with two faces: the lock says the answer at a glance, and opening it is
							    how you change the answer. `data-file-restricted` carries the same values the sidebar
							    row uses, except the sidebar only ever marks the node holding the restriction while
							    this also reports `"inherited"` for a file inside a restricted folder. */}
							<li>
								<MyIconButton
									variant="ghost-highlightable"
									tooltip={restrictedState ? "Restricted. Manage who can open this" : "Share"}
									aria-label={
										restrictedState ? `Sharing for ${currentNode?.name}, restricted` : `Share ${currentNode?.name}`
									}
									data-file-restricted={restrictedState ?? undefined}
									onClick={handleShareClick}
								>
									<MyIconButtonIcon>{restrictedState ? <Lock /> : <Users />}</MyIconButtonIcon>
								</MyIconButton>
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
			</div>

			<FilesShareModal nodeId={shareNodeId} onClose={handleShareModalClose} />
			<FilesPropertiesModal
				nodeId={propertiesNodeId}
				nodeName={currentNode?.name ?? "file"}
				nodeKind={currentNode?.kind ?? "file"}
				returnFocusRef={propertiesTriggerRef}
				onClose={handlePropertiesModalClose}
			/>
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
	| "FileNodeViewTopFloating-activity-message"
	| "FileNodeViewTopFloating-content-too-large"
	| "FileNodeViewTopFloating-content-too-large-icon"
	| "FileNodeViewTopFloating-content-too-large-message"
	| "FileNodeViewTopFloating-frontmatter-too-large"
	| "FileNodeViewTopFloating-frontmatter-too-large-icon"
	| "FileNodeViewTopFloating-frontmatter-too-large-message"
	| "FileNodeViewTopFloating-read-only"
	| "FileNodeViewTopFloating-read-only-icon"
	| "FileNodeViewTopFloating-read-only-message";

type FileNodeViewTopFloating_Props = {
	nodeId: app_convex_Id<"files_nodes"> | null;
	/** Byte size recorded by `files_nodes.contentTooLargeByteSize`, or `null` while the content fits. */
	contentTooLargeByteSize: number | null;
	frontmatterTooLarge: { fieldCount: number; indexDocumentCount: number } | null;
	readOnlyMessage: string | null;
	pendingSlot: React.ReactNode;
};

// The single floating surface of the sticky row: the node's activity status, durable content
// warnings and the pending-updates controls, split by separators like the toolbar. Subscribes to
// one node's activities slice, so the parent view never re-renders on feed traffic.
const FileNodeViewTopFloating = memo(function FileNodeViewTopFloating(props: FileNodeViewTopFloating_Props) {
	const { nodeId, contentTooLargeByteSize, frontmatterTooLarge, readOnlyMessage, pendingSlot } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const convex = useConvex();
	const activities = useFileNodeActivities({ membershipId, nodeId });
	// Slices come newest first; a rerun in progress wins over an older failure.
	const activity =
		activities.find((item) => item.finishedAt === undefined) ??
		activities.find((item) => item.status === "failed" || item.status === "partial" || item.status === "timed_out") ??
		null;

	const handleDismiss = useFn((activityId: app_convex_Id<"activities">) => {
		if (!activity?.controls.canDismiss) return;

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

	// Carries the measured size on purpose, unlike the editor toolbar live regions, which say the
	// same thing for every size so they do not speak on each keystroke. This size only changes when
	// a materialization run fails, which is at most every 30 seconds, and a user who is trimming
	// the file needs to hear whether the number is going down.
	const contentTooLargeMessage =
		contentTooLargeByteSize == null ? null : file_editor_get_content_too_large_message(contentTooLargeByteSize);
	const frontmatterTooLargeMessage = frontmatterTooLarge
		? `Frontmatter is not indexed: ${frontmatterTooLarge.fieldCount} fields and ${frontmatterTooLarge.indexDocumentCount} index entries. The limits are ${files_metadata_MAX_FRONTMATTER_FIELDS} fields and ${files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS} index entries.`
		: null;

	if (!activity && !contentTooLargeMessage && !frontmatterTooLargeMessage && !readOnlyMessage && !pendingSlot) {
		return null;
	}

	// "" means the producer set no per-target text; fall back to the activity title.
	const targetMessage = activity
		? activity.targets.find((target) => target.id === nodeId)?.message || undefined
		: undefined;
	const message = activity
		? activity.finishedAt === undefined
			? (targetMessage ?? activity.title)
			: activity.status === "timed_out"
				? "Timed out"
				: (activity.errorMessage ?? targetMessage ?? activity.title)
		: null;

	return (
		<MyFloatingSurface
			className={"FileNodeViewTopFloating" satisfies FileNodeViewTopFloating_ClassNames}
			role="status"
			aria-live="polite"
		>
			{readOnlyMessage ? (
				<div className={"FileNodeViewTopFloating-read-only" satisfies FileNodeViewTopFloating_ClassNames}>
					<MyIcon className={"FileNodeViewTopFloating-read-only-icon" satisfies FileNodeViewTopFloating_ClassNames}>
						<LockKeyhole aria-hidden />
					</MyIcon>
					<span className={"FileNodeViewTopFloating-read-only-message" satisfies FileNodeViewTopFloating_ClassNames}>
						{readOnlyMessage}
					</span>
				</div>
			) : null}
			{readOnlyMessage && activity ? <MySeparator orientation="vertical" /> : null}
			{activity ? (
				<div className={"FileNodeViewTopFloating-activity" satisfies FileNodeViewTopFloating_ClassNames}>
					{activity.finishedAt === undefined ? (
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
					{activity.controls.canDismiss ? (
						<MyButton variant="ghost" onClick={() => handleDismiss(activity._id)}>
							Dismiss
						</MyButton>
					) : null}
				</div>
			) : null}
			{(readOnlyMessage || activity) && contentTooLargeMessage ? <MySeparator orientation="vertical" /> : null}
			{contentTooLargeMessage ? (
				<div className={"FileNodeViewTopFloating-content-too-large" satisfies FileNodeViewTopFloating_ClassNames}>
					<MyIcon
						className={"FileNodeViewTopFloating-content-too-large-icon" satisfies FileNodeViewTopFloating_ClassNames}
					>
						<CircleAlert />
					</MyIcon>
					<span
						className={"FileNodeViewTopFloating-content-too-large-message" satisfies FileNodeViewTopFloating_ClassNames}
						title={contentTooLargeMessage}
					>
						{contentTooLargeMessage}
					</span>
				</div>
			) : null}
			{(readOnlyMessage || activity || contentTooLargeMessage) && frontmatterTooLargeMessage ? (
				<MySeparator orientation="vertical" />
			) : null}
			{frontmatterTooLargeMessage ? (
				<div className={"FileNodeViewTopFloating-frontmatter-too-large" satisfies FileNodeViewTopFloating_ClassNames}>
					<MyIcon
						className={
							"FileNodeViewTopFloating-frontmatter-too-large-icon" satisfies FileNodeViewTopFloating_ClassNames
						}
					>
						<CircleAlert />
					</MyIcon>
					<span
						className={
							"FileNodeViewTopFloating-frontmatter-too-large-message" satisfies FileNodeViewTopFloating_ClassNames
						}
						title={frontmatterTooLargeMessage}
					>
						{frontmatterTooLargeMessage}
					</span>
				</div>
			) : null}
			{(readOnlyMessage || activity || contentTooLargeMessage || frontmatterTooLargeMessage) && pendingSlot ? (
				<MySeparator orientation="vertical" />
			) : null}
			{pendingSlot}
		</MyFloatingSurface>
	);
});
// #endregion top floating status

// #region file editor
type FileNodeViewFileEditor_Props = {
	ref?: React.Ref<FileEditor_Ref>;
	isActive?: boolean;
	nodeId: app_convex_Id<"files_nodes">;
	writeBlockedReason: files_VisibleTreeNode["writeBlockedReason"];
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	rootKind: FileEditor_Props["rootKind"];
	monacoLanguageId: FileEditor_Props["monacoLanguageId"];
	nonCollaborative: FileEditor_Props["nonCollaborative"];
	committedAssetId: FileEditor_Props["committedAssetId"];
	pendingUpdatesLoaded: FileEditor_Props["pendingUpdatesLoaded"];
	serverSequence?: number;
	yjsLastSequenceId?: app_convex_Id<"files_yjs_docs_last_sequences">;
	editorMode: FileEditor_Mode;
	topSafeArea?: number;
	presenceStore: FileEditor_Props["presenceStore"];
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	onEditorModeChange: (mode: FileEditor_Mode, options?: { replace?: boolean }) => void;
	onAutomaticEditorModeChange?: FileEditor_Props["onEditorModeChange"];
	onPreviewSnapshotChange?: () => void;
	topViewZoneSlot?: React.ReactNode;
};

const FileNodeViewFileEditor = memo(function FileNodeViewFileEditor(props: FileNodeViewFileEditor_Props) {
	const {
		ref,
		isActive,
		nodeId,
		writeBlockedReason,
		pendingUpdateId,
		rootKind,
		monacoLanguageId,
		nonCollaborative,
		committedAssetId,
		pendingUpdatesLoaded,
		serverSequence,
		yjsLastSequenceId,
		editorMode,
		topSafeArea,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		onEditorModeChange,
		onAutomaticEditorModeChange,
		onPreviewSnapshotChange,
		topViewZoneSlot,
	} = props;

	return (
		<FileEditor
			ref={ref}
			isActive={isActive}
			target={{ kind: "saved", id: nodeId }}
			writeBlockedReason={writeBlockedReason}
			pendingUpdateId={pendingUpdateId}
			rootKind={rootKind}
			monacoLanguageId={monacoLanguageId}
			nonCollaborative={nonCollaborative}
			committedAssetId={committedAssetId}
			pendingUpdatesLoaded={pendingUpdatesLoaded}
			serverSequence={serverSequence}
			yjsLastSequenceId={yjsLastSequenceId}
			editorMode={editorMode}
			topSafeArea={topSafeArea}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			onEditorModeChange={onEditorModeChange}
			onAutomaticEditorModeChange={onAutomaticEditorModeChange}
			onPreviewSnapshotChange={onPreviewSnapshotChange}
			topViewZoneSlot={topViewZoneSlot}
		/>
	);
});

// #endregion file editor

// #region view select
type FileNodeViewViewSelect_ClassNames =
	| "FileNodeViewViewSelect-trigger"
	| "FileNodeViewViewSelect-popover"
	| "FileNodeViewViewSelect-search"
	| "FileNodeViewViewSelect-item"
	| "FileNodeViewViewSelect-empty";

type FileNodeViewViewSelect_Props = {
	options: { value: string; label: string }[];
	value: string;
	onValueChange: (value: string) => void;
};

const FileNodeViewViewSelect = memo(function FileNodeViewViewSelect(props: FileNodeViewViewSelect_Props) {
	const { options, value, onValueChange } = props;

	const [searchText, setSearchText] = useState("");

	// Never crash on a stale value: the owner resets it on the next render.
	const selectedOption = options.find((option) => option.value === value) ?? { value, label: value };
	const normalizedSearchText = searchText.trim().toLowerCase();
	const shownOptions = options.filter((option) => option.label.toLowerCase().includes(normalizedSearchText));

	const handleOpenChange = useFn((open: boolean) => {
		if (!open) {
			setSearchText("");
		}
	});

	return (
		<MySearchSelect value={value} setValue={onValueChange} setOpen={handleOpenChange} setValueOnMove={false}>
			{/* Closed-trigger navigation must not start a preview or plugin session. */}
			<MySearchSelectTrigger aria-label={`View: ${selectedOption.label}`} moveOnKeyDown={false} typeahead={false}>
				<MyButton
					type="button"
					variant="outline"
					className={"FileNodeViewViewSelect-trigger" satisfies FileNodeViewViewSelect_ClassNames}
				>
					<span>View: {selectedOption.label}</span>
				</MyButton>
			</MySearchSelectTrigger>
			<MySearchSelectPopover
				aria-label="File views"
				className={"FileNodeViewViewSelect-popover" satisfies FileNodeViewViewSelect_ClassNames}
			>
				<MySearchSelectPopoverScrollableArea>
					<MySearchSelectPopoverContent>
						<MySearchSelectSearch
							className={"FileNodeViewViewSelect-search" satisfies FileNodeViewViewSelect_ClassNames}
							aria-label="Search views"
							placeholder="Search views"
							value={searchText}
							onChange={(event) => setSearchText(event.currentTarget.value)}
						/>
						<MySearchSelectList aria-label="File views">
							{shownOptions.map((option) => (
								<MySearchSelectItem
									key={option.value}
									value={option.value}
									className={"FileNodeViewViewSelect-item" satisfies FileNodeViewViewSelect_ClassNames}
								>
									{option.label}
								</MySearchSelectItem>
							))}
						</MySearchSelectList>
						{shownOptions.length === 0 && (
							<div role="status" className={"FileNodeViewViewSelect-empty" satisfies FileNodeViewViewSelect_ClassNames}>
								No views found
							</div>
						)}
					</MySearchSelectPopoverContent>
				</MySearchSelectPopoverScrollableArea>
			</MySearchSelectPopover>
		</MySearchSelect>
	);
});

function get_editor_view_options(rootKind: files_YjsRootKind) {
	const options: { value: FileEditor_Mode; label: string }[] = [];
	if (rootKind === "rich_text") {
		options.push({ value: "rich_text_editor", label: "Rich text" });
	}

	options.push(
		{ value: "plain_text_editor", label: rootKind === "rich_text" ? "Markdown" : "Code" },
		{ value: "diff_editor", label: "Review changes" },
	);

	return options;
}
// #endregion view select

// #region file views
type FileNodeViewFile_ClassNames =
	| "FileNodeViewFile"
	| "FileNodeViewFile-rich-text"
	| "FileNodeViewFile-panel"
	| "FileNodeViewFile-split";

function file_view_id(match: { plugin: { pluginName: string }; fileView: { id: string } }) {
	return `plugin_${match.plugin.pluginName}_${match.fileView.id}`;
}

type FileNodeViewFile_Props = {
	node: FileNodeViewResolvedNode;
	selectedFileView: string;
	fileNodesList: FileNodeViewContent_Props["fileNodesList"];
	protectedDescendantIds: FileNodeViewHeader_Props["protectedDescendantIds"];
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	committedAssetId: FileEditor_Props["committedAssetId"];
	pendingUpdatesLoaded: FileEditor_Props["pendingUpdatesLoaded"];
	serverSequence?: number;
	yjsLastSequenceId?: app_convex_Id<"files_yjs_docs_last_sequences">;
	topSafeArea: number;
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	presenceStore: FileEditor_Props["presenceStore"];
	onlineUsers: FileEditor_OnlineUser[];
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	viewSelectPortalHost: HTMLElement;
	onEditorModeChange: (mode: FileEditor_Mode, options?: { replace?: boolean }) => void;
	onAutomaticEditorModeChange: FileEditor_Props["onEditorModeChange"];
	onFileViewChange: (view: string) => void;
	onNavigateNode: FileNodeViewHeader_Props["onNavigateNode"];
};

const FileNodeViewFile = memo(function FileNodeViewFile(props: FileNodeViewFile_Props) {
	const {
		node,
		selectedFileView,
		fileNodesList,
		protectedDescendantIds,
		pendingUpdateId,
		committedAssetId,
		pendingUpdatesLoaded,
		serverSequence,
		yjsLastSequenceId,
		topSafeArea,
		editorMode,
		filesSidebarOpen,
		presenceStore,
		onlineUsers,
		commentsPortalHost,
		toolbarPortalHost,
		viewSelectPortalHost,
		onEditorModeChange,
		onAutomaticEditorModeChange,
		onFileViewChange,
		onNavigateNode,
	} = props;
	const { membershipId } = AppTenantProvider.useContext();
	const editorRef = useRef<FileEditor_Ref>(null);
	const primaryPanelRef = useRef<HTMLDivElement>(null);
	const [previewRevision, setPreviewRevision] = useState(0);
	const [previewSource, setPreviewSource] = useState<FileHtmlPreview_Source>();
	const asset = useQuery(app_convex_api.r2.get_asset_by_file_node_id, {
		membershipId,
		fileNodeId: node._id,
	});
	const fileViewPlugins = useQuery(app_convex_api.plugins_ui.list_file_views, { membershipId });
	const isEditable = files_node_has_editable_text_content(node);
	const hasHtmlPreview =
		isEditable && files_editable_text_content_type_of(node.contentType) === "text/html;charset=utf-8";
	const uploadState = files_get_upload_pipeline_state(asset);
	// Plugin views read stored bytes. Wait for an upload's final object before opening them.
	const fileViewMatches =
		isEditable || (asset !== undefined && (uploadState === "terminal" || uploadState === "not_applicable"))
			? plugins_list_file_view_matches(fileViewPlugins, node.contentType)
			: [];

	const selectedViewExists =
		selectedFileView === "default" ||
		(selectedFileView === "details" && isEditable) ||
		(selectedFileView === "preview" && hasHtmlPreview) ||
		(selectedFileView === "code" && hasHtmlPreview) ||
		(selectedFileView === "review" && hasHtmlPreview) ||
		(selectedFileView === "browser" && hasHtmlPreview) ||
		(selectedFileView === "code_browser" && hasHtmlPreview) ||
		(selectedFileView === "review_browser" && hasHtmlPreview) ||
		fileViewMatches.some((match) => file_view_id(match) === selectedFileView);
	// Flat HTML views live in local file state. Legacy "default" opens Code.
	const activeFileView =
		hasHtmlPreview && selectedViewExists && selectedFileView === "default" ? "code" : selectedViewExists ? selectedFileView : "default";
	const isEditorActive = activeFileView === "default";
	const isFlatEditorVisible =
		!hasHtmlPreview ||
		activeFileView === "code" ||
		activeFileView === "review" ||
		activeFileView === "code_browser" ||
		activeFileView === "review_browser";
	const isFlatBrowserVisible =
		hasHtmlPreview &&
		(activeFileView === "browser" || activeFileView === "code_browser" || activeFileView === "review_browser");
	// Flat views ignore the URL editor mode. Code views use plain text, review views use diff.
	const flatEditorMode: FileEditor_Mode =
		activeFileView === "review" || activeFileView === "review_browser" ? "diff_editor" : "plain_text_editor";

	const editorOptions = isEditable && !hasHtmlPreview ? get_editor_view_options(node.textKind) : [];
	const viewOptions = hasHtmlPreview
		? [
				{ value: "code", label: "Code" },
				{ value: "review", label: "Review changes" },
				{ value: "preview", label: "Preview" },
				{ value: "browser", label: "Browser" },
				{ value: "code_browser", label: "Code + Browser" },
				{ value: "review_browser", label: "Review changes + Browser" },
				{ value: "details", label: "File details" },
				...fileViewMatches.map((match) => ({ value: file_view_id(match), label: match.fileView.title })),
			]
		: [
				...editorOptions,
				{ value: isEditable ? "details" : "default", label: "File details" },
				...fileViewMatches.map((match) => ({ value: file_view_id(match), label: match.fileView.title })),
			];
	const activePluginView = fileViewMatches.find((match) => file_view_id(match) === activeFileView);

	const handleViewChange = useFn((value: string) => {
		if (hasHtmlPreview) {
			onFileViewChange(value);
			return;
		}
		const editorOption = editorOptions.find((option) => option.value === value);
		if (editorOption) {
			onEditorModeChange(editorOption.value);
		} else {
			onFileViewChange(value);
		}
	});

	const handlePreviewSnapshotChange = useFn(() => {
		setPreviewRevision((revision) => revision + 1);
	});

	const getPreviewSnapshot = useFn(() => editorRef.current?.getPreviewSnapshot() ?? null);

	const getBrowserDraftText = useFn(() => {
		const draft = editorRef.current?.getPreviewSnapshot() ?? null;
		if (
			!draft ||
			draft.sourceKind !== "editor_draft" ||
			!draft.isDirty ||
			draft.membershipId !== membershipId ||
			draft.target.kind !== "saved" ||
			draft.target.id !== node._id ||
			draft.rootKind !== node.textKind ||
			draft.yjsLastSequenceId !== yjsLastSequenceId
		) {
			return null;
		}
		return draft.text;
	});

	const getBrowserDraftRevision = useFn(() => previewRevision + 1);

	useEffect(() => {
		if (selectedViewExists) {
			return;
		}
		onFileViewChange("default");
		// Browser views are only wrong-file-type, not removed: fall back quietly.
		const isBrowserView =
			selectedFileView === "browser" ||
			selectedFileView === "code_browser" ||
			selectedFileView === "review_browser";
		if (!isBrowserView) {
			toast.info(`This file view is no longer available. Showing ${isEditable ? "the editor" : "file details"}.`);
		}
		if (document.activeElement === document.body) {
			primaryPanelRef.current?.focus();
		}
	}, [isEditable, onFileViewChange, selectedFileView, selectedViewExists]);

	const editorContent = isEditable ? (
		<FileNodeViewFileEditor
			ref={editorRef}
			isActive={hasHtmlPreview ? isFlatEditorVisible : isEditorActive}
			nodeId={node._id}
			writeBlockedReason={node.writeBlockedReason}
			pendingUpdateId={pendingUpdateId}
			rootKind={node.textKind}
			monacoLanguageId={files_monaco_language_id_of_content_type(node.contentType)}
			nonCollaborative={node.collaborationEnabled === false}
			committedAssetId={committedAssetId}
			pendingUpdatesLoaded={pendingUpdatesLoaded}
			serverSequence={serverSequence}
			yjsLastSequenceId={yjsLastSequenceId}
			topSafeArea={topSafeArea}
			editorMode={hasHtmlPreview ? flatEditorMode : editorMode}
			presenceStore={presenceStore}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			onEditorModeChange={onEditorModeChange}
			onAutomaticEditorModeChange={onAutomaticEditorModeChange}
			onPreviewSnapshotChange={hasHtmlPreview ? handlePreviewSnapshotChange : undefined}
		/>
	) : (
		<FileNodeViewStoredFile node={node} asset={asset} />
	);

	const browserContent = isFlatBrowserVisible ? (
		<FilesBrowser
			targetKind="saved"
			nodeId={node._id}
			path={node.path}
			host="docked"
			editorRevision={previewRevision}
			serverSequence={serverSequence ?? null}
			getDraftText={getBrowserDraftText}
			getDraftRevision={getBrowserDraftRevision}
		/>
	) : null;
	// Standalone views hide the whole split group instead of unmounting it, so the
	// editor keeps its local draft. The editor panel hides instead of unmounting
	// in browser-only view; the lone visible panel fills the width.
	const showStandaloneView =
		hasHtmlPreview &&
		(activeFileView === "preview" ||
			activeFileView === "details" ||
			activePluginView != null);

	return (
		<>
			<FileNodeViewHeaderPortal
				selectedNodeId={node._id}
				fileNodesList={fileNodesList}
				protectedDescendantIds={protectedDescendantIds}
				filesSidebarOpen={filesSidebarOpen}
				showFileControls={isEditable}
				onlineUsers={onlineUsers}
				onNavigateNode={onNavigateNode}
			/>
			{createPortal(
				<FileNodeViewViewSelect
					options={viewOptions}
					value={hasHtmlPreview ? activeFileView : isEditable && isEditorActive ? editorMode : activeFileView}
					onValueChange={handleViewChange}
				/>,
				viewSelectPortalHost,
			)}
			<div
				className={cn(
					"FileNodeViewFile" satisfies FileNodeViewFile_ClassNames,
					!hasHtmlPreview &&
						isEditable &&
						isEditorActive &&
						editorMode === "rich_text_editor" &&
						("FileNodeViewFile-rich-text" satisfies FileNodeViewFile_ClassNames),
				)}
			>
				{/* The split group stays mounted across views so the editor keeps its
				    local draft. Standalone views hide it instead of unmounting it. */}
				{hasHtmlPreview ? (
					<div
						className={"FileNodeViewFile-split" satisfies FileNodeViewFile_ClassNames}
						hidden={showStandaloneView}
						inert={showStandaloneView}
					>
						<MyPanelGroup direction="horizontal">
							<MyPanel
								id="file-node-view-editor"
								order={1}
								defaultSize={isFlatBrowserVisible ? 55 : 100}
								minSize={30}
								isOpen={isFlatEditorVisible}
								closeBehavior="hidden"
							>
								<div
									ref={primaryPanelRef}
									className={"FileNodeViewFile-panel" satisfies FileNodeViewFile_ClassNames}
									role="region"
									aria-label="File editor"
									tabIndex={-1}
								>
									{editorContent}
								</div>
							</MyPanel>
							{isFlatBrowserVisible && (
								<>
									<MyPanelResizeHandle
										isOpen
										closeBehavior="unmount"
										aria-label="Resize editor and browser"
									/>
									<MyPanel id="file-node-view-browser" order={2} defaultSize={45} minSize={30}>
										{browserContent}
									</MyPanel>
								</>
							)}
						</MyPanelGroup>
					</div>
				) : (
					<div
						ref={primaryPanelRef}
						className={"FileNodeViewFile-panel" satisfies FileNodeViewFile_ClassNames}
						role="region"
						aria-label={isEditable ? "File editor" : "Stored file"}
						tabIndex={-1}
						hidden={!isEditorActive}
						inert={!isEditorActive}
					>
						{editorContent}
					</div>
				)}
				{isEditable && activeFileView === "details" && (
					<div className={"FileNodeViewFile-panel" satisfies FileNodeViewFile_ClassNames}>
						<FileNodeViewStoredFile node={node} asset={asset} />
					</div>
				)}
				{hasHtmlPreview && activeFileView === "preview" && (
					<div className={"FileNodeViewFile-panel" satisfies FileNodeViewFile_ClassNames}>
						<FileHtmlPreview
							entry={{ kind: "saved", node, pendingUpdate: null, path: node.path }}
							getEditorSnapshot={getPreviewSnapshot}
							editorRevision={previewRevision}
							selectedSource={previewSource}
							onSourceChange={setPreviewSource}
						/>
					</div>
				)}
				{activePluginView && (
					<div
						className={cn(
							"FileNodeViewFile-panel" satisfies FileNodeViewFile_ClassNames,
							"app-scrollable" satisfies AppClassName,
						)}
					>
						<FileNodeViewPluginView
							key={file_view_id(activePluginView)}
							node={node}
							contentType={activePluginView.contentType}
							pluginName={activePluginView.plugin.pluginName}
							pluginVersionId={activePluginView.plugin.pluginVersionId}
							fileViewId={activePluginView.fileView.id}
							fileViewTitle={activePluginView.fileView.title}
							entry={activePluginView.fileView.entry}
						/>
					</div>
				)}
			</div>
		</>
	);
});
// #endregion file views

// #region private file views
type FileNodeViewPrivate_ClassNames =
	| "FileNodeViewPrivate-actions"
	| "FileNodeViewPrivate-status"
	| "FileNodeViewPrivate-body"
	| "FileNodeViewPrivate-media"
	| "FileNodeViewPrivate-table"
	| "FileNodeViewPrivate-name";

type FileNodeViewPrivateView = NonNullable<
	FunctionReturnType<typeof app_convex_api.files_pending_updates.get_file_pending_target>
> & { entry: Extract<files_VisibleEntry, { kind: "private" }> };

const FileNodeViewPrivateActions = memo(function FileNodeViewPrivateActions(props: {
	view: FileNodeViewPrivateView;
	onTargetChange: NonNullable<FileEditor_Props["onTargetChange"]>;
}) {
	const { view, onTargetChange } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const { startReview, isStartingReview } = AppActivitiesProvider.useContext();
	const [busy, setBusy] = useState(false);
	const pendingUpdate = view.entry.pendingUpdate;
	const handleSave = useFn(() => {
		if (busy || !view.canAccept || view.readiness !== "ready") return;
		setBusy(true);
		void app_convex
			.action(app_convex_api.files_pending_updates.save_file_pending_update, {
				membershipId,
				target: { kind: "private", id: view.entry.node._id },
				pendingUpdateId: pendingUpdate._id,
				reviewedRevision: pendingUpdate.revision,
			})
			.then((result) => {
				if (result._nay) toast.error(result._nay.message);
				else onTargetChange(result._yay.target, { keepReview: result._yay.pendingUpdateRevision != null });
			})
			.catch(() => {
				toast.error("The draft could not be saved. Try again.");
			})
			.finally(() => {
				setBusy(false);
			});
	});
	const handleDiscard = useFn(() => {
		if (busy || isStartingReview) return;
		setBusy(true);
		void startReview({
			kind: "discard",
			items: [
				{
					pendingUpdateId: pendingUpdate._id,
					reviewedRevision: pendingUpdate.revision,
					selectedContentStateId: null,
				},
			],
		})
			.catch((error: unknown) => {
				toast.error(error instanceof Error ? error.message : "The draft could not be discarded. Try again.");
			})
			.finally(() => {
				setBusy(false);
			});
	});

	return (
		<div className={"FileNodeViewPrivate-actions" satisfies FileNodeViewPrivate_ClassNames}>
			<span className={"FileNodeViewPrivate-status" satisfies FileNodeViewPrivate_ClassNames} role="status">
				{view.readiness === "preparing"
					? "Preparing…"
					: view.entry.node.kind === "folder"
						? "Added folder"
						: "Added file"}
			</span>
			{pendingUpdate.createIntent?.kind !== "text" && (
				<MyButton
					variant="outline"
					disabled={busy || !view.canAccept || view.readiness !== "ready"}
					onClick={handleSave}
				>
					Save
				</MyButton>
			)}
			<MyButton variant="outline" disabled={busy || isStartingReview} onClick={handleDiscard}>
				Discard
			</MyButton>
		</div>
	);
});

const FileNodeViewPrivateFolder = memo(function FileNodeViewPrivateFolder(props: {
	folderPath: string;
	onNavigateTarget: (target: files_PendingTarget) => void;
}) {
	const { folderPath, onNavigateTarget } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const { entries: children, isFailed } = useFilesVisibleEntries(membershipId, folderPath, "children");

	return isFailed ? (
		<p role="alert">This folder could not be loaded.</p>
	) : children === undefined ? (
		<p role="status">Loading folder…</p>
	) : children.length === 0 ? (
		<p>This folder is empty.</p>
	) : (
		<MyGridTable
			aria-label="Folder contents"
			className={"FileNodeViewPrivate-table" satisfies FileNodeViewPrivate_ClassNames}
		>
			<MyGridTableBody>
				{children.map((entry) => (
					<MyGridTableRow key={`${entry.target.kind}:${entry.target.id}`}>
						<MyGridTableCell>
							<MyButton
								variant="ghost"
								className={"FileNodeViewPrivate-name" satisfies FileNodeViewPrivate_ClassNames}
								onClick={() => onNavigateTarget(entry.target)}
							>
								<MyButtonIcon aria-hidden>{entry.kind === "folder" ? <Folder /> : <FileText />}</MyButtonIcon>
								{entry.name}
							</MyButton>
						</MyGridTableCell>
						<MyGridTableCell>
							{entry.preparing ? "Preparing…" : entry.target.kind === "private" ? "Added" : ""}
						</MyGridTableCell>
					</MyGridTableRow>
				))}
			</MyGridTableBody>
		</MyGridTable>
	);
});

const FileNodeViewPrivateStoredFile = memo(function FileNodeViewPrivateStoredFile(props: {
	entry: Extract<files_VisibleEntry, { kind: "private" }>;
	intent: Extract<NonNullable<app_convex_Doc<"files_pending_updates">["createIntent"]>, { kind: "stored" }>;
}) {
	const { entry, intent } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const serving = files_get_signed_download_serving({ contentType: intent.contentType, fileName: entry.node.name });
	const canPreview = serving.responseContentDisposition.startsWith("inline");
	const handleRead = useFn((download: boolean) => {
		if (busy) return;
		setBusy(true);
		void app_convex
			.action(app_convex_api.files_pending_updates.create_private_pending_download_url, {
				membershipId,
				target: { kind: "private", id: entry.node._id },
				pendingUpdateId: entry.pendingUpdate._id,
				reviewedRevision: entry.pendingUpdate.revision,
				creationGeneration: entry.node.creationGeneration,
			})
			.then(async (result) => {
				if (result._nay) {
					toast.error(result._nay.message);
					return;
				}
				if (!download) {
					setPreviewUrl(result._yay.url);
					return;
				}
				const response = await fetch(result._yay.url);
				if (!response.ok) {
					toast.error("The file could not be downloaded. Try again.");
					return;
				}
				files_download_blob({ blob: await response.blob(), filename: entry.node.name });
			})
			.catch(() => {
				toast.error("The file could not be loaded. Try again.");
			})
			.finally(() => {
				setBusy(false);
			});
	});

	return (
		<>
			<h2>{entry.node.name}</h2>
			<p>
				{intent.contentType} · {files_format_size(intent.size)}
			</p>
			<div className={"FileNodeViewPrivate-actions" satisfies FileNodeViewPrivate_ClassNames}>
				{canPreview && (
					<MyButton variant="outline" disabled={busy} onClick={() => handleRead(false)}>
						Preview
					</MyButton>
				)}
				<MyButton variant="outline" disabled={busy} onClick={() => handleRead(true)}>
					Download
				</MyButton>
			</div>
			{previewUrl &&
				(serving.responseContentType.startsWith("image/") ? (
					<img
						className={"FileNodeViewPrivate-media" satisfies FileNodeViewPrivate_ClassNames}
						src={previewUrl}
						alt={entry.node.name}
					/>
				) : serving.responseContentType.startsWith("video/") ? (
					<video
						className={"FileNodeViewPrivate-media" satisfies FileNodeViewPrivate_ClassNames}
						src={previewUrl}
						controls
						aria-label={entry.node.name}
					/>
				) : (
					<audio
						className={"FileNodeViewPrivate-media" satisfies FileNodeViewPrivate_ClassNames}
						src={previewUrl}
						controls
						aria-label={entry.node.name}
					/>
				))}
		</>
	);
});

const FileNodeViewPrivateContent = memo(function FileNodeViewPrivateContent(props: {
	view: FileNodeViewPrivateView;
	selectedFileView: string;
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	fileNodesList: FileNodeViewHeader_Props["fileNodesList"];
	protectedDescendantIds: FileNodeViewHeader_Props["protectedDescendantIds"];
	topSafeArea: number;
	toolbarPortalHost: HTMLElement;
	viewSelectPortalHost: HTMLElement;
	presenceStore: FileEditor_Props["presenceStore"];
	onEditorModeChange: FileEditor_Props["onEditorModeChange"];
	onAutomaticEditorModeChange: FileEditor_Props["onEditorModeChange"];
	onFileViewChange: (view: string) => void;
	onTargetChange: NonNullable<FileEditor_Props["onTargetChange"]>;
	onNavigateTarget: (target: files_PendingTarget) => void;
	onNavigateNode: FileNodeViewHeader_Props["onNavigateNode"];
}) {
	const {
		view,
		selectedFileView,
		editorMode,
		filesSidebarOpen,
		fileNodesList,
		protectedDescendantIds,
		topSafeArea,
		toolbarPortalHost,
		viewSelectPortalHost,
		presenceStore,
		onEditorModeChange,
		onAutomaticEditorModeChange,
		onFileViewChange,
		onTargetChange,
		onNavigateTarget,
		onNavigateNode,
	} = props;
	const { entry } = view;
	const editorRef = useRef<FileEditor_Ref>(null);
	const [previewRevision, setPreviewRevision] = useState(0);
	const [previewSource, setPreviewSource] = useState<FileHtmlPreview_Source>();
	const intent = entry.pendingUpdate.createIntent;
	const textIntent = intent?.kind === "text" ? intent : null;
	const hasHtmlPreview =
		textIntent?.textKind === "plain_text" &&
		files_editable_text_content_type_of(textIntent.contentType) === "text/html;charset=utf-8";
	const isPreview = selectedFileView === "preview" && hasHtmlPreview;
	// Same guard as saved files: unknown views fall back instead of blanking.
	const privateSelectedViewExists =
		selectedFileView === "default" ||
		(hasHtmlPreview &&
			(selectedFileView === "code" ||
				selectedFileView === "review" ||
				selectedFileView === "preview" ||
				selectedFileView === "browser" ||
				selectedFileView === "code_browser" ||
				selectedFileView === "review_browser"));
	// Flat HTML views live in local file state. Legacy "default" opens Code.
	const activePrivateView =
		!privateSelectedViewExists || (hasHtmlPreview && selectedFileView === "default")
			? hasHtmlPreview
				? "code"
				: "default"
			: selectedFileView;
	const isPrivateBrowserView =
		hasHtmlPreview &&
		(activePrivateView === "browser" ||
			activePrivateView === "code_browser" ||
			activePrivateView === "review_browser");
	const isPrivateEditorVisible =
		!hasHtmlPreview ||
		activePrivateView === "default" ||
		activePrivateView === "code" ||
		activePrivateView === "review" ||
		activePrivateView === "code_browser" ||
		activePrivateView === "review_browser";
	const isPrivateBrowserVisible = isPrivateBrowserView;
	const flatPrivateEditorMode: FileEditor_Mode =
		activePrivateView === "review" || activePrivateView === "review_browser" ? "diff_editor" : "plain_text_editor";
	const editorOptions = textIntent && !hasHtmlPreview ? get_editor_view_options(textIntent.textKind) : [];
	const privateViewOptions = hasHtmlPreview
		? [
				{ value: "code", label: "Code" },
				{ value: "review", label: "Review changes" },
				{ value: "preview", label: "Preview" },
				{ value: "browser", label: "Browser" },
				{ value: "code_browser", label: "Code + Browser" },
				{ value: "review_browser", label: "Review changes + Browser" },
			]
		: [...editorOptions];
	const handleViewChange = useFn((value: string) => {
		if (hasHtmlPreview) {
			onFileViewChange(value);
			return;
		}
		const option = editorOptions.find((item) => item.value === value);
		if (option) onEditorModeChange(option.value);
		else onFileViewChange(value);
	});
	const handlePreviewSnapshotChange = useFn(() => setPreviewRevision((revision) => revision + 1));
	const getPreviewSnapshot = useFn(() => editorRef.current?.getPreviewSnapshot() ?? null);

	useEffect(() => {
		if (privateSelectedViewExists) {
			return;
		}
		onFileViewChange("default");
		// Browser views are only wrong-file-type, not removed: fall back quietly.
		const isBrowserView =
			selectedFileView === "browser" ||
			selectedFileView === "code_browser" ||
			selectedFileView === "review_browser";
		if (!isBrowserView) {
			toast.info("This file view is no longer available. Showing the editor.");
		}
	}, [onFileViewChange, privateSelectedViewExists, selectedFileView]);

	const editorContent = textIntent ? (
		<FileEditor
			ref={editorRef}
			isActive={hasHtmlPreview ? isPrivateEditorVisible : !isPreview}
			target={{ kind: "private", id: entry.node._id }}
			privateCanEdit={view.canEdit}
			writeBlockedReason={null}
			pendingUpdateId={entry.pendingUpdate._id}
			rootKind={textIntent.textKind}
			monacoLanguageId={files_monaco_language_id_of_content_type(textIntent.contentType)}
			nonCollaborative
			committedAssetId={null}
			pendingUpdatesLoaded
			editorMode={hasHtmlPreview ? flatPrivateEditorMode : editorMode}
			topSafeArea={topSafeArea}
			presenceStore={presenceStore}
			commentsPortalHost={null}
			toolbarPortalHost={toolbarPortalHost}
			onEditorModeChange={onEditorModeChange}
			onAutomaticEditorModeChange={onAutomaticEditorModeChange}
			onPreviewSnapshotChange={handlePreviewSnapshotChange}
			onTargetChange={onTargetChange}
		/>
	) : null;

	const privateBrowserContent = isPrivateBrowserVisible ? (
		<FilesBrowser
			targetKind="private"
			nodeId={entry.node._id}
			path={entry.path}
			host="docked"
			editorRevision={previewRevision}
			serverSequence={null}
			getDraftText={null}
			getDraftRevision={null}
		/>
	) : null;
	// Same stable-group pattern as saved files: hide instead of unmount so the
	// editor keeps its local draft. The lone visible panel fills the width.

	return (
		<>
			<FileNodeViewHeaderPortal
				selectedNodeId={null}
				privateEntry={entry}
				fileNodesList={fileNodesList}
				protectedDescendantIds={protectedDescendantIds}
				filesSidebarOpen={filesSidebarOpen}
				showFileControls={false}
				onlineUsers={[]}
				onNavigateNode={onNavigateNode}
			/>
			{view.readiness === "ready" && textIntent ? (
				<>
					{createPortal(
						<FileNodeViewViewSelect
							options={privateViewOptions}
							value={hasHtmlPreview ? activePrivateView : isPreview ? "preview" : editorMode}
							onValueChange={handleViewChange}
						/>,
						viewSelectPortalHost,
					)}
					<div
						className={cn(
							"FileNodeViewFile" satisfies FileNodeViewFile_ClassNames,
							!hasHtmlPreview &&
								!isPreview &&
								editorMode === "rich_text_editor" &&
								("FileNodeViewFile-rich-text" satisfies FileNodeViewFile_ClassNames),
						)}
					>
						{hasHtmlPreview ? (
							<div
								className={"FileNodeViewFile-split" satisfies FileNodeViewFile_ClassNames}
								hidden={isPreview}
								inert={isPreview}
							>
								<MyPanelGroup direction="horizontal">
									<MyPanel
										id="file-node-view-editor"
										order={1}
										defaultSize={isPrivateBrowserVisible ? 55 : 100}
										minSize={30}
										isOpen={isPrivateEditorVisible}
										closeBehavior="hidden"
									>
										<div
											className={"FileNodeViewFile-panel" satisfies FileNodeViewFile_ClassNames}
											role="region"
											aria-label="File editor"
										>
											{editorContent}
										</div>
									</MyPanel>
									{isPrivateBrowserVisible && (
										<>
											<MyPanelResizeHandle
												isOpen
												closeBehavior="unmount"
												aria-label="Resize editor and browser"
											/>
											<MyPanel id="file-node-view-browser" order={2} defaultSize={45} minSize={30}>
												{privateBrowserContent}
											</MyPanel>
										</>
									)}
								</MyPanelGroup>
							</div>
						) : (
							<div
								className={"FileNodeViewFile-panel" satisfies FileNodeViewFile_ClassNames}
								role="region"
								aria-label="File editor"
								hidden={isPreview}
								inert={isPreview}
							>
								{editorContent}
							</div>
						)}
						{isPreview && (
							<div className={"FileNodeViewFile-panel" satisfies FileNodeViewFile_ClassNames}>
								<FileHtmlPreview
									entry={entry}
									getEditorSnapshot={getPreviewSnapshot}
									editorRevision={previewRevision}
									selectedSource={previewSource}
									onSourceChange={setPreviewSource}
								/>
							</div>
						)}
					</div>
				</>
			) : (
				<div className={"FileNodeViewPrivate-body" satisfies FileNodeViewPrivate_ClassNames}>
					{view.readiness === "preparing" ? (
						<p role="status">Preparing this {entry.node.kind}…</p>
					) : entry.node.kind === "folder" ? (
						<FileNodeViewPrivateFolder folderPath={entry.path} onNavigateTarget={onNavigateTarget} />
					) : intent?.kind === "stored" ? (
						<FileNodeViewPrivateStoredFile key={entry.pendingUpdate.revision} entry={entry} intent={intent} />
					) : null}
				</div>
			)}
		</>
	);
});
// #endregion private file views

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
	node: FileNodeViewResolvedNode;
	asset: FunctionReturnType<typeof app_convex_api.r2.get_asset_by_file_node_id> | undefined;
};

const FileNodeViewStoredFile = memo(function FileNodeViewStoredFile(props: FileNodeViewStoredFile_Props) {
	const { node, asset } = props;

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
		<section aria-label="File details" className={"FileNodeViewStoredFile" satisfies FileNodeViewStoredFile_ClassNames}>
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
	);
});
// #endregion stored file

// #region plugin view
/**
 * May this view move focus right now?
 *
 * Yes when the member's focus is already inside the view. Yes too when focus sits on the document
 * body, because that is where the browser leaves it after the iframe holding it is removed, and yes
 * when the document reports no focused element at all. No while the member is working somewhere else
 * on the screen: this view is one content panel next to the files sidebar, and that sidebar cancels a
 * rename when its input loses focus. The moves below run on events the member never asked for.
 */
function can_take_focus(region: HTMLElement | null) {
	const focused = document.activeElement;
	return focused === null || focused === document.body || region?.contains(focused) === true;
}

type FileNodeViewPluginView_ClassNames = "FileNodeViewPluginView";

type FileNodeViewPluginView_Props = {
	node: FileNodeViewResolvedNode;
	/** The file's content type that matched the view's declared list. Sent to the plugin in bonobo:init. */
	contentType: string;
	pluginName: string;
	pluginVersionId: app_convex_Id<"plugins_versions">;
	fileViewId: string;
	fileViewTitle: string;
	entry: string;
};

const FileNodeViewPluginView = memo(function FileNodeViewPluginView(props: FileNodeViewPluginView_Props) {
	const { node, contentType, pluginName, pluginVersionId, fileViewId, fileViewTitle, entry } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const sectionRef = useRef<HTMLElement | null>(null);
	// Incremented by Retry. It is part of the frame key below, so each attempt gets a fresh frame.
	const [attempt, setAttempt] = useState(0);

	// Any tenant, version, view, file, or Retry change creates a new iframe and nonce. The key also
	// keys the child below, so React throws that child away and builds a new one for every new frame.
	// That remount is what keeps the child's error and its "started" flag honest: each belongs to one
	// frame and dies with it, so the child never has to ask which frame a message came from.
	const frameKey = `${membershipId}:${pluginVersionId}:${fileViewId}:${node._id}:${attempt}`;
	// The frame key the effect below has already handled. It is how that effect tells the first frame
	// apart from a frame that replaced a running one. A plain "first run" flag would not do: React
	// StrictMode runs a mount effect twice in development, so the second run would read the flag as a
	// replacement and steal focus the first time the member opens this view.
	const handledFrameKeyRef = useRef(frameKey);

	const handleRetry = useFn(() => {
		// The press is about to unmount this button, and focus would fall back to the document body:
		// a keyboard member would lose their place and have to tab from the top of the page. So take
		// focus to this view while the button is still there, and let the next Tab reach the frame.
		sectionRef.current?.focus();
		setAttempt((current) => current + 1);
	});

	// A new frame key throws the running iframe away. An admin upgrading the plugin does that while
	// nobody asked for it: the member can be reading the view with focus inside the iframe, and the
	// browser then leaves them on the document body. The new frame is covered and inert while it
	// starts, so there is nothing inside this view to tab to until the handshake finishes. Park focus
	// on this view instead. The first frame is skipped: opening the view took nobody's focus away.
	useEffect(() => {
		if (handledFrameKeyRef.current === frameKey) {
			return;
		}

		handledFrameKeyRef.current = frameKey;
		if (can_take_focus(sectionRef.current)) {
			sectionRef.current?.focus();
		}
	}, [frameKey]);

	return (
		// tabIndex -1 makes this view the target the focus moves above land on. It stays out of the tab
		// order, so nothing changes for a member whose frame never fails and never gets replaced. The
		// label is what turns the section into a named region, so a screen reader announces where the
		// focus landed.
		<section
			ref={sectionRef}
			tabIndex={-1}
			aria-label={fileViewTitle}
			className={"FileNodeViewPluginView" satisfies FileNodeViewPluginView_ClassNames}
		>
			<FileNodeViewPluginViewFrame
				key={frameKey}
				regionRef={sectionRef}
				node={node}
				contentType={contentType}
				pluginName={pluginName}
				pluginVersionId={pluginVersionId}
				fileViewId={fileViewId}
				fileViewTitle={fileViewTitle}
				entry={entry}
				onRetry={handleRetry}
			/>
		</section>
	);
});

type FileNodeViewPluginViewFrame_ClassNames =
	| "FileNodeViewPluginViewFrame"
	| "FileNodeViewPluginViewFrame-loading"
	| "FileNodeViewPluginViewFrame-error";

type FileNodeViewPluginViewFrame_Props = {
	/**
	 * The `<section>` the view above renders. The focus move below asks whether focus is still in it.
	 */
	regionRef: RefObject<HTMLElement | null>;
	node: FileNodeViewResolvedNode;
	/**
	 * The file's content type that matched the view's declared list. Sent to the plugin in bonobo:init.
	 */
	contentType: string;
	pluginName: string;
	pluginVersionId: app_convex_Id<"plugins_versions">;
	fileViewId: string;
	fileViewTitle: string;
	entry: string;
	onRetry: () => void;
};

/**
 * One plugin frame and the two things the member sees around it: the alert when the frame fails, and
 * the cover until the frame starts.
 *
 * The view above keys this component with the frame key, so all of its state belongs to exactly one
 * frame. A frame that goes away takes that state with it, and the frame replacing it starts clean.
 */
const FileNodeViewPluginViewFrame = memo(function FileNodeViewPluginViewFrame(
	props: FileNodeViewPluginViewFrame_Props,
) {
	const { regionRef, node, contentType, pluginName, pluginVersionId, fileViewId, fileViewTitle, entry, onRetry } =
		props;
	const { membershipId, organizationId, workspaceId } = AppTenantProvider.useContext();
	const retryButtonRef = useRef<HTMLButtonElement | null>(null);
	// Names the message inside the alert, so the Retry button can point at it and say what failed.
	const errorMessageId = `FileNodeViewPluginViewFrame-${useId()}-error`;
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [isFrameStarted, setIsFrameStarted] = useState(false);
	// What the live region below says. It starts empty on purpose; the effect that fills it says why.
	const [statusMessage, setStatusMessage] = useState("");

	const loadingMessage = `Loading ${fileViewTitle}...`;
	const readyMessage = `${fileViewTitle} is ready.`;

	const mintSession = useFn(() =>
		app_convex.action(app_convex_api.plugins_ui.mint_file_view_session, {
			membershipId,
			pluginName,
			fileViewId,
			fileNodeId: node._id,
		}),
	);

	const getInitContext = useFn<PluginsUiFrame_Props["getInitContext"]>(() => ({
		kind: "file_view",
		pluginName,
		fileViewId,
		fileViewTitle,
		organizationId,
		workspaceId,
		file: {
			fileNodeId: node._id,
			name: node.name,
			path: node.path,
			contentType,
		},
	}));

	// The error replaces the iframe, and any focus that was inside it, so move focus to the one
	// available action. The move is not unconditional. The frame reports failures nobody is waiting
	// for: the mint refusing a session, the startup deadline running out, the plugin flooding the
	// bridge with ready messages, the frame loading a second document, or a renewal refused much
	// later. By then the member may be working elsewhere on the screen, so ask where focus is first.
	useEffect(() => {
		if (sessionError !== null && can_take_focus(regionRef.current)) {
			retryButtonRef.current?.focus();
		}
	}, [sessionError]);

	// A polite live region is read out when new text lands in a region the screen reader is already
	// watching. Inserting the region with its text already inside it is the one case that is not
	// reliably announced. So the region below is always in the DOM and starts empty, and this effect
	// writes the sentence one commit later. The same region also says when the wait is over. A start
	// that fails already tells the member: the alert speaks, and focus moves onto Retry. A start that
	// works moves no focus, and the cover is hidden from screen readers, so without this second
	// sentence the member would hear the wait begin and never hear it end.
	useEffect(() => {
		setStatusMessage(isFrameStarted ? readyMessage : loadingMessage);
	}, [isFrameStarted, loadingMessage, readyMessage]);

	if (sessionError !== null) {
		return (
			<div
				className={"FileNodeViewPluginViewFrame-error" satisfies FileNodeViewPluginViewFrame_ClassNames}
				role="alert"
			>
				{/* Focus moves onto Retry as this alert appears, and a screen reader then describes the
				    focused button. Its whole name is "Retry", so the member would hear nothing about what
				    failed. aria-describedby ties the message to the button and gives them the reason. */}
				<span id={errorMessageId}>{sessionError}</span>
				<MyButton ref={retryButtonRef} aria-describedby={errorMessageId} onClick={onRetry}>
					Retry
				</MyButton>
			</div>
		);
	}

	return (
		<>
			{/* What a screen reader announces. This region is always here and starts empty; the effect
			    above says why. */}
			<div className="sr-only" role="status" aria-live="polite">
				{statusMessage}
			</div>
			{/* The same sentence on screen, hidden from screen readers so it is not said twice. The
			    frame stays mounted under this cover: it is the frame that reports the handshake, so
			    unmounting it would remove the very thing being waited for. */}
			{isFrameStarted ? null : (
				<div
					className={"FileNodeViewPluginViewFrame-loading" satisfies FileNodeViewPluginViewFrame_ClassNames}
					aria-hidden
				>
					<MySpinner size="16px" />
					<span>{loadingMessage}</span>
				</div>
			)}
			{/* `inert` while the cover is up. The cover is opaque, but the iframe underneath still takes
			    clicks and still sits in the tab order. Without this a keyboard member can tab into a
			    frame this view just told them has not started, and land inside a cross-origin document
			    with nothing on screen. It goes on this wrapper because `PluginsUiFrame` renders the
			    iframe from its own fixed prop list and forwards nothing else. */}
			<div
				className={"FileNodeViewPluginViewFrame" satisfies FileNodeViewPluginViewFrame_ClassNames}
				inert={!isFrameStarted}
			>
				<PluginsUiFrame
					membershipId={membershipId}
					pluginName={pluginName}
					pluginVersionId={pluginVersionId}
					entry={entry}
					title={fileViewTitle}
					kindLabel="plugin view"
					mintSession={mintSession}
					getInitContext={getInitContext}
					onStarted={() => setIsFrameStarted(true)}
					// The state setter is the handler: the frame hands over the sentence and this component
					// shows it. A setter identity never changes, and the frame's bridge effect lists
					// `onError` in its dependencies, so a changing one would tear the frame down.
					onError={setSessionError}
				/>
			</div>
		</>
	);
});
// #endregion plugin view

// #region folder
const FILE_NODE_VIEW_FOLDER_INITIAL_VISIBLE_ITEMS_COUNT = 5;

type FileNodeViewFolder_ClassNames = "FileNodeViewFolder" | "FileNodeViewFolder-mode-monaco";

type FileNodeViewFolderEntry = NonNullable<ReturnType<typeof useFilesVisibleEntries>["entries"]>[number];

type FileNodeViewFolder_Props = {
	folderItemId: app_convex_Doc<"files_nodes">["parentId"];
	fileNodesList: FileNodeViewContent_Props["fileNodesList"];
	protectedDescendantIds: ReadonlySet<app_convex_Id<"files_nodes">>;
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	committedAssetId: FileEditor_Props["committedAssetId"];
	pendingUpdatesLoaded: FileEditor_Props["pendingUpdatesLoaded"];
	serverSequence?: number;
	yjsLastSequenceId?: app_convex_Id<"files_yjs_docs_last_sequences">;
	topSafeArea: number;
	editorMode: FileEditor_Mode;
	presenceStore: FileEditor_Props["presenceStore"];
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	viewSelectPortalHost: HTMLElement;
	onEditorModeChange: (mode: FileEditor_Mode, options?: { replace?: boolean }) => void;
};

const FileNodeViewFolder = memo(function FileNodeViewFolder(props: FileNodeViewFolder_Props) {
	const {
		folderItemId,
		fileNodesList,
		protectedDescendantIds,
		pendingUpdateId,
		committedAssetId,
		pendingUpdatesLoaded,
		serverSequence,
		yjsLastSequenceId,
		topSafeArea,
		editorMode,
		presenceStore,
		commentsPortalHost,
		toolbarPortalHost,
		viewSelectPortalHost,
		onEditorModeChange,
	} = props;

	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const convex = useConvex();

	const savedFolderPath = useQuery(
		app_convex_api.files_visible.get_path,
		folderItemId === files_ROOT_ID ? "skip" : { membershipId, target: { kind: "saved", id: folderItemId } },
	);

	const { entries: visibleEntries, isFailed: isFolderFailed } = useFilesVisibleEntries(
		membershipId,
		folderItemId === files_ROOT_ID ? "/" : savedFolderPath,
		"children",
	);

	const canWriteFolder = useQuery(app_convex_api.files_nodes.get_current_user_file_write_permission, {
		membershipId,
		nodeId: folderItemId,
	});
	const folderCanReceiveChildren = canWriteFolder === true;

	// Moving a child out of a restricted folder needs Can manage on its source scope.
	// Keep manual `useMemo` in this group. Convex `useQueries` re-subscribes with a
	// render-phase setState whenever the queries object identity changes, and the React
	// Compiler leaves these hook arguments unmemoized (checked in the served compiled
	// output), so an inline object loops the render until React throws.
	// `restrictedScopeNodeIds` is memoized too because the query objects depend on its identity.
	const restrictedScopeNodeIds = useMemo(
		() => [
			...new Set(
				(fileNodesList ?? []).flatMap((node) => (node.restrictedScopeNodeId ? [node.restrictedScopeNodeId] : [])),
			),
		],
		[fileNodesList],
	);

	const restrictedScopeShareStates = useQueries(
		useMemo(
			() =>
				Object.fromEntries(
					restrictedScopeNodeIds.map((nodeId) => [
						nodeId,
						{
							query: app_convex_api.files_sharing.get_node_share_state,
							args: { membershipId, nodeId },
						},
					]),
				),
			[membershipId, restrictedScopeNodeIds],
		),
	);

	const canManageRestrictedScope = useFn((scopeNodeId: app_convex_Id<"files_nodes">) => {
		const shareState = restrictedScopeShareStates[scopeNodeId];
		return shareState != null && !(shareState instanceof Error) && shareState.canManage;
	});

	const [showAllItems, setShowAllItems] = useState(false);
	const [isCreatingReadme, setIsCreatingReadme] = useState(false);
	const [pendingActionNodeIds, setPendingActionNodeIds] = useState(() => new Set<string>());

	const childItems = [...(visibleEntries ?? [])].sort((a, b) => {
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
	const readmeNode = fileNodesList?.find((node) => node._id === readmeNodeId);
	const editorOptions =
		readmeNode && files_node_has_editable_text_content(readmeNode) ? get_editor_view_options(readmeNode.textKind) : [];

	const handleViewChange = useFn((value: string) => {
		const editorOption = editorOptions.find((option) => option.value === value);
		if (editorOption) {
			onEditorModeChange(editorOption.value);
		}
	});

	const handleShowMoreClick = useFn(() => {
		setShowAllItems(true);
	});

	const handleShowLessClick = useFn(() => {
		setShowAllItems(false);
	});

	const handleCreateReadmeClick = useFn(() => {
		if (!folderCanReceiveChildren) {
			return;
		}

		setIsCreatingReadme(true);
		convex
			.action(app_convex_api.files_nodes_content.create_text_node, {
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
			const sourceNode = fileNodesList?.find((node) => node._id === args.fileNodeId);
			const targetNode = fileNodesList?.find((node) => node._id === args.targetParentId);

			// Move needs the named item and its parent. Protected children keep their rules
			// and do not block the folder.
			if (
				!sourceNode ||
				!sourceNode.canWrite ||
				!folderCanReceiveChildren ||
				(args.targetParentId !== files_ROOT_ID && targetNode?.canWrite !== true)
			) {
				return false;
			}
			return can_move_file_node_to_parent({
				fileNodesList,
				fileNodeId: args.fileNodeId,
				targetParentId: args.targetParentId,
				canManageRestrictedScope,
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
			{isFolderFailed ? (
				<p role="alert">This folder could not be loaded.</p>
			) : visibleEntries === undefined ? (
				<p role="status">Loading folder…</p>
			) : null}
			<FileNodeViewFolderExplorer
				visibleChildItems={visibleChildItems}
				fileNodesList={fileNodesList}
				hiddenChildItemsCount={hiddenChildItemsCount}
				organizationName={organizationName}
				workspaceName={workspaceName}
				pendingActionNodeIds={pendingActionNodeIds}
				protectedDescendantIds={protectedDescendantIds}
				canPasteIntoFolder={folderCanReceiveChildren}
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
				canWrite={folderCanReceiveChildren}
				isCreatingReadme={isCreatingReadme}
				onCreateReadmeClick={handleCreateReadmeClick}
			/>
		</FileNodeViewFolderBody>
	);

	const readmeEditor = readmeNodeId ? (
		<FileNodeViewFolderReadmeEditor
			readmeNodeId={readmeNodeId}
			writeBlockedReason={readmeNode?.writeBlockedReason ?? null}
			pendingUpdateId={pendingUpdateId}
			// The README node owns its shape: a README.md created by copying a plain text file is
			// plain text, and the embed must open it the same way the file view does.
			rootKind={readmeNode?.textKind ?? "rich_text"}
			monacoLanguageId={files_monaco_language_id_of_content_type(readmeNode?.contentType)}
			nonCollaborative={readmeNode?.collaborationEnabled === false}
			committedAssetId={committedAssetId}
			pendingUpdatesLoaded={pendingUpdatesLoaded}
			serverSequence={serverSequence}
			yjsLastSequenceId={yjsLastSequenceId}
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
			{editorOptions.length > 0 &&
				createPortal(
					<FileNodeViewViewSelect options={editorOptions} value={editorMode} onValueChange={handleViewChange} />,
					viewSelectPortalHost,
				)}
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
	isBusy: boolean;
	folderItemId: app_convex_Doc<"files_nodes">["parentId"];
	folderName: string;
	onCreateNode: (kind: app_convex_Doc<"files_nodes">["kind"]) => void;
};

const FileNodeViewToolbarFolderActions = memo(function FileNodeViewToolbarFolderActions(
	props: FileNodeViewToolbarFolderActions_Props,
) {
	const { disabled, isBusy, folderItemId, folderName, onCreateNode } = props;
	const actionsRef = useRef<HTMLDivElement | null>(null);
	FilesClipboardProvider.useHotkeys({
		target: actionsRef,
		getSourceIds: () => [],
		getTargetParentId: () => (disabled ? null : folderItemId),
	});

	return (
		<div
			ref={actionsRef}
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
			<FilesClipboardToolbar
				targetParentId={folderItemId}
				targetName={folderName}
				canPaste={!disabled}
				isBusy={isBusy}
			/>
		</div>
	);
});

type FileNodeViewToolbarFileDownloadAction_ClassNames =
	| "FileNodeViewToolbarFileDownloadAction"
	| "FileNodeViewToolbarFileDownloadAction-button"
	| "FileNodeViewToolbarFileDownloadAction-button-icon";

type FileNodeViewToolbarFileDownloadAction_Props = {
	node: FileNodeViewResolvedNode | null | undefined;
};

const FileNodeViewToolbarFileDownloadAction = memo(function FileNodeViewToolbarFileDownloadAction(
	props: FileNodeViewToolbarFileDownloadAction_Props,
) {
	const { node } = props;

	const convex = useConvex();

	const { membershipId } = AppTenantProvider.useContext();

	const [isDownloading, setIsDownloading] = useState(false);

	const handleDownload = useFn(() => {
		if (node?.kind !== "file" || !node.assetId || isDownloading) {
			return;
		}

		const fileNodeId = node._id;
		const filename = node.name;

		setIsDownloading(true);
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
					filename,
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
				setIsDownloading(false);
			});
	});

	// Only an uploaded file has stored bytes to download.
	if (node?.kind !== "file" || !node.assetId) {
		return null;
	}

	return (
		<div className={"FileNodeViewToolbarFileDownloadAction" satisfies FileNodeViewToolbarFileDownloadAction_ClassNames}>
			<MyIconButton
				className={
					"FileNodeViewToolbarFileDownloadAction-button" satisfies FileNodeViewToolbarFileDownloadAction_ClassNames
				}
				variant="ghost-highlightable"
				tooltip="Download"
				// Keep the file name in the accessible name so the button stays identifiable in a page with several actions.
				aria-label={`Download ${node.name}`}
				disabled={isDownloading}
				aria-busy={isDownloading}
				onClick={handleDownload}
			>
				<MyIconButtonIcon
					className={
						"FileNodeViewToolbarFileDownloadAction-button-icon" satisfies FileNodeViewToolbarFileDownloadAction_ClassNames
					}
				>
					<Download />
				</MyIconButtonIcon>
			</MyIconButton>
		</div>
	);
});

type FileNodeViewToolbar_ClassNames =
	| "FileNodeViewToolbar"
	| "FileNodeViewToolbar-surface"
	| "FileNodeViewToolbar-view-select"
	| "FileNodeViewToolbar-editor-actions";

type FileNodeViewToolbar_Props = {
	editorActionsRef: React.Ref<HTMLDivElement>;
	viewSelectRef: React.Ref<HTMLDivElement>;
	showEditorActions: boolean;
	folderActionsSlot: React.ReactNode;
	fileActionsSlot: React.ReactNode;
};

const FileNodeViewToolbar = memo(function FileNodeViewToolbar(props: FileNodeViewToolbar_Props) {
	const { editorActionsRef, viewSelectRef, showEditorActions, folderActionsSlot, fileActionsSlot } = props;

	return (
		<div className={"FileNodeViewToolbar" satisfies FileNodeViewToolbar_ClassNames}>
			<div
				role="toolbar"
				aria-label="File actions"
				className={"FileNodeViewToolbar-surface" satisfies FileNodeViewToolbar_ClassNames}
			>
				<div
					ref={viewSelectRef}
					className={"FileNodeViewToolbar-view-select" satisfies FileNodeViewToolbar_ClassNames}
				></div>
				{folderActionsSlot}
				{fileActionsSlot}
				<div
					id={FILE_NODE_VIEW_TOOLBAR_EDITOR_ACTIONS_ID}
					ref={editorActionsRef}
					hidden={!showEditorActions}
					inert={!showEditorActions}
					className={"FileNodeViewToolbar-editor-actions" satisfies FileNodeViewToolbar_ClassNames}
				></div>
			</div>
		</div>
	);
});
// #endregion toolbar

// #region folder create node modal
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
	const canWrite = useQuery(
		app_convex_api.files_nodes.get_current_user_file_write_permission,
		folderItemId ? { membershipId, nodeId: folderItemId } : "skip",
	);
	const folderNode = fileNodesList?.find((node) => node._id === folderItemId);
	const canReceiveChildren =
		canWrite === true && (folderItemId === files_ROOT_ID || folderNode?.archiveOperationId === null);
	const createUnavailableMessage =
		canWrite === false
			? folderNode?.writeBlockedReason === "read_only"
				? "A file policy blocks creating files here."
				: "You don't have permission to create files here."
			: null;

	const createNodeModalRef = useRef<FileNodeViewFolderCreateNodeModal_Ref | null>(null);
	const [isCreatingNode, setIsCreatingNode] = useState(false);

	const siblingNames =
		folderItemId && fileNodesList
			? fileNodesList
					.filter((item) => item.parentId === folderItemId && item.archiveOperationId === null)
					.map((child) => child.name)
			: [];

	const handleCreateNodeModalOpen = useFn((kind: app_convex_Doc<"files_nodes">["kind"]) => {
		if (!folderItemId || !canReceiveChildren) {
			return;
		}

		createNodeModalRef.current?.open(kind);
	});

	const handleCreateNodeSubmit = useFn((args: { kind: app_convex_Doc<"files_nodes">["kind"]; path: string }) => {
		const { kind, path } = args;
		if (!folderItemId) {
			return Promise.resolve("Select a folder before creating a node.");
		}
		if (canWrite !== true) {
			return Promise.resolve("You don't have permission to create files here.");
		}
		if (!canReceiveChildren) {
			return Promise.resolve("This folder is read-only.");
		}

		setIsCreatingNode(true);
		const createNodePromise =
			kind === "folder"
				? convex.mutation(app_convex_api.files_nodes.create_folder_node, {
						membershipId,
						parentId: folderItemId,
						path,
					})
				: convex.action(app_convex_api.files_nodes_content.create_text_node, {
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
		<FileNodeViewToolbarFolderActions
			disabled={!canReceiveChildren || isCreatingNode}
			isBusy={isCreatingNode}
			folderItemId={folderItemId}
			folderName={folderItemId === files_ROOT_ID ? "root folder" : (folderNode?.name ?? "selected folder")}
			onCreateNode={handleCreateNodeModalOpen}
		/>
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
					canWrite={canReceiveChildren}
					unavailableMessage={createUnavailableMessage}
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
	| "FileNodeViewFolderExplorer-row-cut"
	| "FileNodeViewFolderExplorer-row-drop-target"
	| "FileNodeViewFolderExplorer-row-action"
	| "FileNodeViewFolderExplorer-cell"
	| "FileNodeViewFolderExplorer-cell-name"
	| "FileNodeViewFolderExplorer-cell-updated-by"
	| "FileNodeViewFolderExplorer-cell-updated"
	| "FileNodeViewFolderExplorer-cell-actions"
	| "FileNodeViewFolderExplorer-link"
	| "FileNodeViewFolderExplorer-icon"
	| "FileNodeViewFolderExplorer-read-only"
	| "FileNodeViewFolderExplorer-updated-by"
	| "FileNodeViewFolderExplorer-more-action";

type FileNodeViewFolderExplorerRow_Props = {
	child: files_VisibleTreeNode;
	visibleName: string;
	hasVisibleProtectedDescendant: boolean;
	canPasteIntoFolder: boolean;
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
		visibleName,
		hasVisibleProtectedDescendant,
		canPasteIntoFolder,
		organizationName,
		workspaceName,
		isPendingAction,
		canMoveFileNodeToParent,
		onArchiveNode,
		onMoveFileNodesToParent,
	} = props;
	const { membershipId } = AppTenantProvider.useContext();
	const canWrite = useQuery(app_convex_api.files_nodes.get_current_user_file_write_permission, {
		membershipId,
		nodeId: child._id,
	});
	const capabilities = files_get_read_only_capabilities({
		canWrite: canWrite === true,
		parentCanWrite: canPasteIntoFolder,
		hasVisibleProtectedDescendant,
	});
	const readOnlyLabels = files_get_read_only_row_labels({
		canWrite: child.canWrite,
		writeBlockedReason: child.writeBlockedReason,
		writePolicyState: child.writePolicyState,
	});

	const rowRef = useRef<HTMLDivElement | null>(null);
	const { clipboard } = FilesClipboardProvider.useContext();
	const isCut = clipboard?.mode === "cut" && clipboard.sourceIds.includes(child._id);
	FilesClipboardProvider.useHotkeys({
		target: rowRef,
		enabled: !isPendingAction,
		getSourceIds: (_event, mode) => (mode === "cut" && !capabilities.canRelocateOrRename ? [] : [child._id]),
		getTargetParentId: () =>
			child.kind === "folder"
				? capabilities.canReceiveChildren
					? child._id
					: null
				: canPasteIntoFolder
					? child.parentId
					: null,
	});
	const [isDragging, setIsDragging] = useState(false);
	const [isDropTarget, setIsDropTarget] = useState(false);

	const handleArchiveClick = useFn(() => {
		if (capabilities.canArchiveOrRestore) {
			onArchiveNode(child._id);
		}
	});

	useEffect(() => {
		const element = rowRef.current;
		if (!element) {
			return;
		}

		const cleanupFns: Array<() => void> = [];

		if (capabilities.canRelocateOrRename && !isPendingAction) {
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

		if (capabilities.canReceiveChildren && child.kind === "folder" && !isPendingAction) {
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
	}, [
		canMoveFileNodeToParent,
		capabilities.canReceiveChildren,
		capabilities.canRelocateOrRename,
		child._id,
		child.kind,
		isPendingAction,
		onMoveFileNodesToParent,
	]);

	return (
		<MyGridTableRow
			ref={rowRef}
			className={cn(
				"FileNodeViewFolderExplorer-row" satisfies FileNodeViewFolderExplorerRow_ClassNames,
				isDragging && ("FileNodeViewFolderExplorer-row-dragging" satisfies FileNodeViewFolderExplorerRow_ClassNames),
				isCut && ("FileNodeViewFolderExplorer-row-cut" satisfies FileNodeViewFolderExplorerRow_ClassNames),
				isDropTarget &&
					("FileNodeViewFolderExplorer-row-drop-target" satisfies FileNodeViewFolderExplorerRow_ClassNames),
			)}
			data-file-node-id={child._id}
			aria-label={isCut ? `${visibleName}, ready to move` : undefined}
		>
			<MyGridTableCell
				className={cn(
					"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
					"FileNodeViewFolderExplorer-cell-name" satisfies FileNodeViewFolderExplorerRow_ClassNames,
				)}
			>
				{/* The row-wide open link lives inside the first cell, not next to the cells: a `role="row"`
				    may only own cells, and a link sitting directly under it is an invalid tree for a
				    screen reader. The CSS still stretches it across the whole row. */}
				<Link
					aria-label={`Open ${visibleName}${readOnlyLabels ? `, ${readOnlyLabels.description}` : ""}${isCut ? ", ready to move" : ""}`}
					className={"FileNodeViewFolderExplorer-row-action" satisfies FileNodeViewFolderExplorerRow_ClassNames}
					to="/w/$organizationName/$workspaceName/files"
					params={{ organizationName, workspaceName }}
					// Drop `view` so the target node opens on its own default editor.
					search={(prev) => ({ ...prev, nodeId: child._id, pendingNodeId: undefined, view: undefined })}
					draggable={false}
				/>
				<MyIcon className={"FileNodeViewFolderExplorer-icon" satisfies FileNodeViewFolderExplorerRow_ClassNames}>
					{child.kind === "folder" ? <Folder /> : <FileText />}
				</MyIcon>
				<span className={"FileNodeViewFolderExplorer-link" satisfies FileNodeViewFolderExplorerRow_ClassNames}>
					{visibleName}
				</span>
				{readOnlyLabels ? (
					<MyIcon
						className={"FileNodeViewFolderExplorer-read-only" satisfies FileNodeViewFolderExplorerRow_ClassNames}
						title={readOnlyLabels.tooltip}
					>
						<LockKeyhole aria-hidden />
					</MyIcon>
				) : null}
			</MyGridTableCell>
			<MyGridTableCell
				className={cn(
					"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
					"FileNodeViewFolderExplorer-cell-updated-by" satisfies FileNodeViewFolderExplorerRow_ClassNames,
				)}
			>
				{/* The text needs its own element: the cell is a flex container, and a bare text node inside one
				    becomes an anonymous item that the cell's own `text-overflow` never reaches. */}
				<span className={"FileNodeViewFolderExplorer-updated-by" satisfies FileNodeViewFolderExplorerRow_ClassNames}>
					{child.updatedBy || "Unknown"}
				</span>
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
							aria-label={`More actions for ${visibleName}`}
						>
							<MyIconButtonIcon>
								<EllipsisVertical />
							</MyIconButtonIcon>
						</MyIconButton>
					</MyMenuTrigger>
					<MyMenuPopover unmountOnHide>
						<MyMenuPopoverContent>
							<FilesClipboardMenuItems
								sourceIds={[child._id]}
								canCut={capabilities.canRelocateOrRename && !isPendingAction}
								canCopy={!isPendingAction}
								targetParentId={child.kind === "folder" ? child._id : null}
								targetName={child.kind === "folder" ? child.name : null}
								canPaste={capabilities.canReceiveChildren && !isPendingAction}
							/>
							<MyMenuItem
								variant="destructive"
								disabled={!capabilities.canArchiveOrRestore || isPendingAction}
								hideOnClick
								onClick={handleArchiveClick}
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
	| "FileNodeViewFolderExplorer-show-less"
	| "FileNodeViewFolderExplorer-show-less-cover";

type FileNodeViewFolderExplorer_Props = {
	visibleChildItems: FileNodeViewFolderEntry[];
	fileNodesList: FileNodeViewContent_Props["fileNodesList"];
	hiddenChildItemsCount: number;
	organizationName: string;
	workspaceName: string;
	pendingActionNodeIds: ReadonlySet<string>;
	protectedDescendantIds: ReadonlySet<app_convex_Id<"files_nodes">>;
	canPasteIntoFolder: boolean;
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
		fileNodesList,
		hiddenChildItemsCount,
		organizationName,
		workspaceName,
		pendingActionNodeIds,
		protectedDescendantIds,
		canPasteIntoFolder,
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
						{visibleChildItems.map((entry) => {
							const child =
								entry.target.kind === "saved" ? fileNodesList?.find((node) => node._id === entry.target.id) : undefined;
							if (!child) {
								return (
									<MyGridTableRow
										key={`${entry.target.kind}:${entry.target.id}`}
										className={"FileNodeViewFolderExplorer-row" satisfies FileNodeViewFolderExplorerRow_ClassNames}
									>
										<MyGridTableCell
											className={cn(
												"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
												"FileNodeViewFolderExplorer-cell-name" satisfies FileNodeViewFolderExplorerRow_ClassNames,
											)}
										>
											<Link
												aria-label={`Open ${entry.name}`}
												className={
													"FileNodeViewFolderExplorer-row-action" satisfies FileNodeViewFolderExplorerRow_ClassNames
												}
												to="/w/$organizationName/$workspaceName/files"
												params={{ organizationName, workspaceName }}
												search={(prev) => ({
													...prev,
													nodeId: entry.target.kind === "saved" ? entry.target.id : undefined,
													pendingNodeId: entry.target.kind === "private" ? entry.target.id : undefined,
													view: undefined,
												})}
											/>
											<MyIcon
												className={"FileNodeViewFolderExplorer-icon" satisfies FileNodeViewFolderExplorerRow_ClassNames}
											>
												{entry.kind === "folder" ? <Folder /> : <FileText />}
											</MyIcon>
											<span
												className={"FileNodeViewFolderExplorer-link" satisfies FileNodeViewFolderExplorerRow_ClassNames}
											>
												{entry.name}
											</span>
										</MyGridTableCell>
										<MyGridTableCell
											className={cn(
												"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
												"FileNodeViewFolderExplorer-cell-updated-by" satisfies FileNodeViewFolderExplorerRow_ClassNames,
											)}
										>
											<span
												className={
													"FileNodeViewFolderExplorer-updated-by" satisfies FileNodeViewFolderExplorerRow_ClassNames
												}
											>
												{entry.updatedBy || "Unknown"}
											</span>
										</MyGridTableCell>
										<MyGridTableCell
											className={cn(
												"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
												"FileNodeViewFolderExplorer-cell-updated" satisfies FileNodeViewFolderExplorerRow_ClassNames,
											)}
										>
											{format_relative_time(entry.updatedAt)}
										</MyGridTableCell>
										<MyGridTableCell
											className={cn(
												"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
												"FileNodeViewFolderExplorer-cell-actions" satisfies FileNodeViewFolderExplorerRow_ClassNames,
											)}
										>
											{entry.preparing ? "Preparing…" : entry.target.kind === "private" ? "Added" : ""}
										</MyGridTableCell>
									</MyGridTableRow>
								);
							}
							const isPendingAction = pendingActionNodeIds.has(child._id);

							return (
								<FileNodeViewFolderExplorerRow
									key={child._id}
									child={child}
									visibleName={entry.name}
									hasVisibleProtectedDescendant={protectedDescendantIds.has(child._id)}
									canPasteIntoFolder={canPasteIntoFolder}
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
					variant="ghost"
					onClick={onShowMoreClick}
				>
					Show more
				</MyButton>
			)}

			{canShowLess && (
				<>
					<MyButton
						className={"FileNodeViewFolderExplorer-show-less" satisfies FileNodeViewFolderExplorer_ClassNames}
						variant="ghost"
						onClick={onShowLessClick}
					>
						Show less
					</MyButton>
					{/* Hide the table rows in the 16px gap below the sticky show less button. */}
					<div
						className={"FileNodeViewFolderExplorer-show-less-cover" satisfies FileNodeViewFolderExplorer_ClassNames}
					/>
				</>
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
	canWrite: boolean;
	isCreatingReadme: boolean;
	onCreateReadmeClick: () => void;
};

const FileNodeViewFolderReadme = memo(function FileNodeViewFolderReadme(props: FileNodeViewFolderReadme_Props) {
	const { readmeNodeId, fileNodesList, canWrite, isCreatingReadme, onCreateReadmeClick } = props;

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
						disabled={!canWrite || isCreatingReadme}
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
	writeBlockedReason: files_VisibleTreeNode["writeBlockedReason"];
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	rootKind: files_YjsRootKind;
	monacoLanguageId: string;
	nonCollaborative: FileEditor_Props["nonCollaborative"];
	committedAssetId: FileEditor_Props["committedAssetId"];
	pendingUpdatesLoaded: FileEditor_Props["pendingUpdatesLoaded"];
	serverSequence?: number;
	yjsLastSequenceId?: app_convex_Id<"files_yjs_docs_last_sequences">;
	editorMode: FileEditor_Mode;
	presenceStore: FileEditor_Props["presenceStore"];
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	onEditorModeChange: (mode: FileEditor_Mode, options?: { replace?: boolean }) => void;
	topViewZoneSlot?: React.ReactNode;
};

const FileNodeViewFolderReadmeEditor = memo(function FileNodeViewFolderReadmeEditor(
	props: FileNodeViewFolderReadmeEditor_Props,
) {
	const {
		readmeNodeId,
		writeBlockedReason,
		pendingUpdateId,
		rootKind,
		monacoLanguageId,
		nonCollaborative,
		committedAssetId,
		pendingUpdatesLoaded,
		serverSequence,
		yjsLastSequenceId,
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
				writeBlockedReason={writeBlockedReason}
				pendingUpdateId={pendingUpdateId}
				rootKind={rootKind}
				monacoLanguageId={monacoLanguageId}
				nonCollaborative={nonCollaborative}
				committedAssetId={committedAssetId}
				pendingUpdatesLoaded={pendingUpdatesLoaded}
				serverSequence={serverSequence}
				yjsLastSequenceId={yjsLastSequenceId}
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
	selectedFileView: string;
	selectedNodeId: string | null | undefined;
	node: FileNodeViewResolvedNode | null | undefined;
	fileNodesList: files_VisibleTreeNode[] | undefined;
	protectedDescendantIds: FileNodeViewHeader_Props["protectedDescendantIds"];
	pendingUpdateId?: app_convex_Id<"files_pending_updates">;
	committedAssetId: FileEditor_Props["committedAssetId"];
	pendingUpdatesLoaded: FileEditor_Props["pendingUpdatesLoaded"];
	serverSequence?: number;
	yjsLastSequenceId?: app_convex_Id<"files_yjs_docs_last_sequences">;
	topSafeArea: number;
	editorMode: FileEditor_Mode;
	filesSidebarOpen: boolean;
	presenceStore: FileEditor_Props["presenceStore"];
	onlineUsers: FileEditor_OnlineUser[];
	commentsPortalHost: HTMLElement | null;
	toolbarPortalHost: HTMLElement;
	viewSelectPortalHost: HTMLElement;
	onEditorModeChange: (mode: FileEditor_Mode, options?: { replace?: boolean }) => void;
	onAutomaticEditorModeChange: FileEditor_Props["onEditorModeChange"];
	onFileViewChange: (view: string) => void;
	onNavigateNode: FileNodeViewHeader_Props["onNavigateNode"];
};

const FileNodeViewContent = memo(function FileNodeViewContent(props: FileNodeViewContent_Props) {
	const {
		selectedFileView,
		selectedNodeId,
		node,
		fileNodesList,
		protectedDescendantIds,
		pendingUpdateId,
		committedAssetId,
		pendingUpdatesLoaded,
		serverSequence,
		yjsLastSequenceId,
		topSafeArea,
		editorMode,
		filesSidebarOpen,
		presenceStore,
		onlineUsers,
		commentsPortalHost,
		toolbarPortalHost,
		viewSelectPortalHost,
		onEditorModeChange,
		onAutomaticEditorModeChange,
		onFileViewChange,
		onNavigateNode,
	} = props;

	if (selectedNodeId === files_ROOT_ID) {
		return (
			<>
				<FileNodeViewHeaderPortal
					selectedNodeId={files_ROOT_ID}
					fileNodesList={fileNodesList}
					protectedDescendantIds={protectedDescendantIds}
					filesSidebarOpen={filesSidebarOpen}
					showFileControls={true}
					onlineUsers={onlineUsers}
					onNavigateNode={onNavigateNode}
				/>
				<FileNodeViewFolder
					folderItemId={files_ROOT_ID}
					fileNodesList={fileNodesList}
					protectedDescendantIds={protectedDescendantIds}
					pendingUpdateId={pendingUpdateId}
					committedAssetId={committedAssetId}
					pendingUpdatesLoaded={pendingUpdatesLoaded}
					serverSequence={serverSequence}
					yjsLastSequenceId={yjsLastSequenceId}
					topSafeArea={topSafeArea}
					editorMode={editorMode}
					presenceStore={presenceStore}
					commentsPortalHost={commentsPortalHost}
					toolbarPortalHost={toolbarPortalHost}
					viewSelectPortalHost={viewSelectPortalHost}
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
					protectedDescendantIds={protectedDescendantIds}
					filesSidebarOpen={filesSidebarOpen}
					showFileControls={true}
					onlineUsers={onlineUsers}
					onNavigateNode={onNavigateNode}
				/>
				<FileNodeViewFolder
					folderItemId={node._id}
					fileNodesList={fileNodesList}
					protectedDescendantIds={protectedDescendantIds}
					pendingUpdateId={pendingUpdateId}
					committedAssetId={committedAssetId}
					pendingUpdatesLoaded={pendingUpdatesLoaded}
					serverSequence={serverSequence}
					yjsLastSequenceId={yjsLastSequenceId}
					topSafeArea={topSafeArea}
					editorMode={editorMode}
					presenceStore={presenceStore}
					commentsPortalHost={commentsPortalHost}
					toolbarPortalHost={toolbarPortalHost}
					viewSelectPortalHost={viewSelectPortalHost}
					onEditorModeChange={onEditorModeChange}
				/>
			</>
		);
	}

	return (
		<FileNodeViewFile
			key={node._id}
			node={node}
			selectedFileView={selectedFileView}
			fileNodesList={fileNodesList}
			protectedDescendantIds={protectedDescendantIds}
			pendingUpdateId={pendingUpdateId}
			committedAssetId={committedAssetId}
			pendingUpdatesLoaded={pendingUpdatesLoaded}
			serverSequence={serverSequence}
			yjsLastSequenceId={yjsLastSequenceId}
			topSafeArea={topSafeArea}
			editorMode={editorMode}
			filesSidebarOpen={filesSidebarOpen}
			presenceStore={presenceStore}
			onlineUsers={onlineUsers}
			commentsPortalHost={commentsPortalHost}
			toolbarPortalHost={toolbarPortalHost}
			viewSelectPortalHost={viewSelectPortalHost}
			onEditorModeChange={onEditorModeChange}
			onAutomaticEditorModeChange={onAutomaticEditorModeChange}
			onFileViewChange={onFileViewChange}
			onNavigateNode={onNavigateNode}
		/>
	);
});
// #endregion content

// #region top sticky floating container
type FileNodeViewTopStickyFloatingContainer_ClassNames =
	| "FileNodeViewTopStickyFloatingContainer"
	| "FileNodeViewTopStickyFloatingContainer-mode-inner-scrollbar";

type FileNodeViewTopStickyFloatingContainer_Props = {
	/**
	 * The view under the row keeps a scrollbar at the content panel's right edge (a Monaco
	 * editor or a scrolling file panel): shift the controls left so they stay clear of it.
	 */
	innerScrollbar: boolean;
	children: React.ReactNode;
};

const FileNodeViewTopStickyFloatingContainer = memo(function FileNodeViewTopStickyFloatingContainer(
	props: FileNodeViewTopStickyFloatingContainer_Props,
) {
	const { innerScrollbar, children } = props;

	return (
		<div
			className={cn(
				"FileNodeViewTopStickyFloatingContainer" satisfies FileNodeViewTopStickyFloatingContainer_ClassNames,
				innerScrollbar &&
					("FileNodeViewTopStickyFloatingContainer-mode-inner-scrollbar" satisfies FileNodeViewTopStickyFloatingContainer_ClassNames),
			)}
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
	pendingNodeId?: string;
	view?: files_EditorView;
	q?: string;
};

export type FileNodeView_Props = {
	searchParams: FileNodeView_SearchParams;
	/** `
	 * replace` keeps the debounced search-query updates out of the history stack.
	 **/
	onNavigateSearch: (search: FileNodeView_SearchParams, options?: { replace?: boolean }) => void;
};

export const FileNodeView = memo(function FileNodeView(props: FileNodeView_Props) {
	const { searchParams, onNavigateSearch } = props;

	const { membershipId } = AppTenantProvider.useContext();
	const authenticated = AppAuthProvider.useAuthenticated();

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
	const [viewSelectPortalHost, setViewSelectPortalHost] = useState<HTMLElement | null>(null);

	const [lastOpenTarget, setLastOpenTarget] = useAppLocalStorageStateValue(
		`app_state::files_last_open_target::scope::${membershipId}`,
	);

	const searchPrivateNodeId = searchParams.pendingNodeId;
	const searchNodeId = searchPrivateNodeId ? undefined : searchParams.nodeId;
	const selectionKey = searchPrivateNodeId ? `private:${searchPrivateNodeId}` : `saved:${searchNodeId}`;
	const browserSession = useQuery(app_convex_api.files_browser.current_browser_session, { membershipId });
	const endingBrowserSessionRef = useRef<string | null>(null);

	// One shared end call for both effects below. The ref guard stops double
	// ends; it clears when the session goes away so a later retry can run.
	const handleEndBrowserSession = useFn((sessionId: app_convex_Id<"files_browser_sessions">) => {
		if (endingBrowserSessionRef.current === sessionId) {
			return;
		}
		endingBrowserSessionRef.current = sessionId;
		app_convex
			.action(app_convex_api.files_browser.end_browser, { membershipId, sessionId })
			.then((result) => {
				if (result._nay) {
					console.error("[FileNodeView] Failed to end browser session", { error: result._nay });
				}
			})
			.catch((error: unknown) => {
				console.error("[FileNodeView] Unexpected browser end error", { error });
			});
	});

	useEffect(() => {
		if (!browserSession) {
			endingBrowserSessionRef.current = null;
		}
	}, [browserSession]);

	// This owner stays mounted when the next selection has no browser panel, including folders.
	// Wait for last-open restoration before treating an empty URL as a new selection.
	useEffect(() => {
		if (
			(!searchNodeId && !searchPrivateNodeId) ||
			!browserSession ||
			`${browserSession.targetKind}:${browserSession.nodeId}` === selectionKey
		) {
			return;
		}
		handleEndBrowserSession(browserSession.sessionId);
	}, [handleEndBrowserSession, membershipId, browserSession, searchNodeId, searchPrivateNodeId, selectionKey]);

	const isRootNodeSelected = searchNodeId === files_ROOT_ID;
	const [fileViewSelection, setFileViewSelection] = useState({ membershipId, selectionKey, view: "default" });
	const selectedFileView =
		fileViewSelection.membershipId === membershipId && fileViewSelection.selectionKey === selectionKey
			? fileViewSelection.view
			: "default";
	// Flat HTML views keep the editor visible. "default" is the editor for other files.
	const isEditorActive =
		selectedFileView === "default" ||
		selectedFileView === "code" ||
		selectedFileView === "review" ||
		selectedFileView === "code_browser" ||
		selectedFileView === "review_browser";
	const handleFileViewChange = useFn((view: string) => {
		setFileViewSelection({ membershipId, selectionKey, view });
	});

	// Leaving a browser view ends its session: the browser is only a view, never background.
	useEffect(() => {
		if (
			!browserSession ||
			`${browserSession.targetKind}:${browserSession.nodeId}` !== selectionKey ||
			selectedFileView === "browser" ||
			selectedFileView === "code_browser" ||
			selectedFileView === "review_browser"
		) {
			return;
		}
		handleEndBrowserSession(browserSession.sessionId);
	}, [handleEndBrowserSession, browserSession, membershipId, selectedFileView, selectionKey]);

	useGlobalCustomEvent("files::open_browser", (event) => {
		if (event.detail.membershipId !== membershipId) return;
		const requestedSelectionKey = `${event.detail.targetKind}:${event.detail.nodeId}`;
		// The browser is only a view: remember Browser for that file, then navigate to it.
		setFileViewSelection({ membershipId, selectionKey: requestedSelectionKey, view: "browser" });
		if (requestedSelectionKey !== selectionKey) {
			onNavigateSearch({
				...(event.detail.targetKind === "private"
					? { pendingNodeId: event.detail.nodeId }
					: { nodeId: event.detail.nodeId }),
				q: searchParams.q,
			});
		}
	});

	const fileNodesList = FilesTreeProvider.useContext();
	const protectedDescendantIds = useMemo(() => files_collect_protected_descendant_ids(fileNodesList ?? []), [fileNodesList]);

	const queriedNode = useQuery(
		app_convex_api.files_nodes.get_file_node_for_membership,
		searchNodeId && !isRootNodeSelected
			? {
					membershipId,
					fileNodeId: searchNodeId,
				}
			: "skip",
	);
	const privateTargetView = useQuery(
		app_convex_api.files_pending_updates.get_file_pending_target,
		searchPrivateNodeId ? { membershipId, target: { kind: "private", id: searchPrivateNodeId } } : "skip",
	);
	const privateEntry = privateTargetView?.entry.kind === "private" ? privateTargetView.entry : null;
	const privateSourceKey = privateEntry
		? `${membershipId}:private:${privateEntry.node._id}:${privateEntry.node.userId}:${privateEntry.node.creationGeneration}`
		: null;
	const privateTextIntent =
		privateEntry?.pendingUpdate.createIntent?.kind === "text" ? privateEntry.pendingUpdate.createIntent : null;
	// Show the loaded tree node while the query starts. A null answer must still clear the view.
	const resolvedNode =
		queriedNode === undefined ? fileNodesList?.find((item) => item._id === searchNodeId) : queriedNode;
	const resolvedNodeId = isRootNodeSelected ? files_ROOT_ID : (resolvedNode?._id ?? null);
	// Keep create actions scoped to the visible folder/root selection; file views use this toolbar only for editor actions.
	const targetFolderId = isRootNodeSelected ? files_ROOT_ID : resolvedNode?.kind === "folder" ? resolvedNode._id : null;
	const resolvedNodeHasEditableTextContent = files_node_has_editable_text_content(resolvedNode);

	// Treat a folder README as the active editor node so pending-update and sync subscriptions
	// have the same owner for selected files and folder README editors.
	const activeEditorNodeId = isRootNodeSelected
		? get_folder_readme_node_id(fileNodesList, files_ROOT_ID)
		: resolvedNode && resolvedNode.kind === "file"
			? resolvedNodeHasEditableTextContent
				? resolvedNode._id
				: null
			: resolvedNode?.kind === "folder"
				? get_folder_readme_node_id(fileNodesList, resolvedNode._id)
				: null;
	const activeEditorTreeNode = fileNodesList?.find((item) => item._id === activeEditorNodeId);
	const activeEditorNode =
		resolvedNode?.kind === "file" && resolvedNodeHasEditableTextContent ? resolvedNode : activeEditorTreeNode;
	const activeEditorTarget: files_PendingTarget | null =
		privateEntry && privateTextIntent
			? { kind: "private", id: privateEntry.node._id }
			: activeEditorNodeId
				? { kind: "saved", id: activeEditorNodeId }
				: null;

	// Clamp against the actual editor node. For a selected folder that node is its README, not the
	// folder itself, so the header and layout must follow the README's document shape too.
	const requestedView: files_EditorView = searchParams.view ?? "rich_text_editor";
	const effectiveView = privateTextIntent
		? files_resolve_effective_editor_view({ requestedView, rootKind: privateTextIntent.textKind })
		: activeEditorNode && files_node_has_editable_text_content(activeEditorNode)
			? files_resolve_effective_editor_view({
					requestedView,
					rootKind: activeEditorNode.textKind,
				})
			: requestedView;
	// The editor node can be a folder's README instead of the selected node, so read its mode from
	// the tree. A file with collaboration turned off has no Yjs sequence to watch.
	const activeEditorNodeIsCollaborative = activeEditorNode?.collaborationEnabled === true;

	const {
		results: allPendingUpdatesResult,
		status: pendingListStatus,
		loadMore: loadMorePendingUpdates,
	} = usePaginatedQuery(
		app_convex_api.files_pending_updates.list_files_pending_updates,
		{ membershipId },
		{ initialNumItems: 20 },
	);
	const savedEditorPendingUpdate = useQuery(
		app_convex_api.files_pending_updates.get_file_pending_update,
		activeEditorTarget?.kind === "saved" ? { membershipId, target: activeEditorTarget } : "skip",
	);
	// The open editor does not depend on which review pages have loaded.
	const editorPendingUpdate =
		activeEditorTarget?.kind === "private" ? privateTargetView?.entry.pendingUpdate : savedEditorPendingUpdate;
	const activeEditorServerSequenceData = useQuery(
		app_convex_api.files_nodes.get_file_last_yjs_sequence,
		activeEditorNodeId && activeEditorNodeIsCollaborative
			? {
					membershipId,
					nodeId: activeEditorNodeId,
				}
			: "skip",
	);

	/**
	 * Carry `q` through navigation.
	 * The sidebar keeps its filter when a result is opened, so the URL
	 * has to keep matching the search box instead of silently dropping the query.
	 * The current view is NOT carried: each node opens on its own default editor.
	 */
	const navigateToNode = useFn((nodeId?: string, nextEditorMode: files_EditorView = "rich_text_editor") => {
		const view = nextEditorMode === "rich_text_editor" ? undefined : nextEditorMode;
		setFileViewSelection({ membershipId, selectionKey: `saved:${nodeId}`, view: "default" });
		onNavigateSearch({ nodeId, view, q: searchParams.q });
	});
	const navigateToTarget = useFn((target: files_PendingTarget, nextEditorMode?: files_EditorView) => {
		const view = nextEditorMode === "rich_text_editor" ? undefined : nextEditorMode;
		setFileViewSelection({ membershipId, selectionKey: `${target.kind}:${target.id}`, view: "default" });
		onNavigateSearch({
			...(target.kind === "private" ? { pendingNodeId: target.id } : { nodeId: target.id }),
			view,
			q: searchParams.q,
		});
	});
	const handleEditorTargetChange = useFn(
		(sourceKey: string, target: files_PendingTarget, options?: { keepReview: boolean }) => {
			// A completed Save must not replace a different file opened while it was running.
			if (sourceKey !== `${membershipId}:${selectionKey}`) return;
			setFileViewSelection({ membershipId, selectionKey: `${target.kind}:${target.id}`, view: "default" });
			onNavigateSearch(
				{
					...(target.kind === "private" ? { pendingNodeId: target.id } : { nodeId: target.id }),
					view: searchParams.view === "diff_editor" && options?.keepReview === false ? undefined : searchParams.view,
					q: searchParams.q,
				},
				{ replace: true },
			);
		},
	);

	const handleAutomaticEditorModeChange = useFn<FileNodeViewContent_Props["onEditorModeChange"]>(
		(nextView, options) => {
			const view = nextView === "rich_text_editor" ? undefined : nextView;
			onNavigateSearch(
				{
					...(searchPrivateNodeId ? { pendingNodeId: searchPrivateNodeId } : { nodeId: searchNodeId ?? files_ROOT_ID }),
					view,
					q: searchParams.q,
				},
				options,
			);
		},
	);
	const navigateToView = useFn<FileNodeViewContent_Props["onEditorModeChange"]>((nextView, options) => {
		handleFileViewChange("default");
		handleAutomaticEditorModeChange(nextView, options);
	});

	/**
	 * Mirror the sidebar search box into the URL so a filtered view can be reloaded or shared.
	 *
	 * `FilesSidebarSearch` already debounces this callback, so no extra timer is needed here.
	 * `replace` keeps a whole typing session on one history entry, and an empty query drops the
	 * param instead of leaving `?q=` behind.
	 */
	const handleSearchQueryChange = useFn<React.ComponentProps<typeof FilesSidebar>["onSearchQueryChange"]>(
		(searchQuery) => {
			const q = searchQuery.trim().length > 0 ? searchQuery : undefined;
			if (q === searchParams.q) {
				return;
			}

			onNavigateSearch(
				{
					...(searchPrivateNodeId ? { pendingNodeId: searchPrivateNodeId } : { nodeId: searchNodeId }),
					view: searchParams.view,
					q,
				},
				{ replace: true },
			);
		},
	);

	const handleToolbarPortalHostChange = useFn((element: HTMLDivElement | null) => {
		setToolbarPortalHost(element);
	});

	const handleViewSelectPortalHostChange = useFn((element: HTMLDivElement | null) => {
		setViewSelectPortalHost(element);
	});

	// The pager/floating bar reviews diffs, so count only content-bearing rows; pure moves are
	// reviewed in the Pending panel only.
	const pendingUpdates = allPendingUpdatesResult.flatMap((view) =>
		view.kind === "entry" && view.readiness === "ready" && files_pending_update_has_content(view.entry.pendingUpdate)
			? [view.entry.pendingUpdate]
			: [],
	);
	const currentPendingUpdate =
		editorPendingUpdate && !editorPendingUpdate.preparation && files_pending_update_has_content(editorPendingUpdate)
			? editorPendingUpdate
			: null;
	if (currentPendingUpdate && !pendingUpdates.some((update) => update._id === currentPendingUpdate._id)) {
		pendingUpdates.push(currentPendingUpdate);
	}
	const hasMorePendingUpdates = pendingListStatus === "CanLoadMore" || pendingListStatus === "LoadingMore";
	const hasPendingUpdates = pendingUpdates.length > 0 || hasMorePendingUpdates;
	// 44px = 40px for the floating content area plus 4px of spacing.
	// Keep this reserve visible even without pending updates so folder and file content
	// start below the route toolbar with the same top breathing room.
	const topSafeArea = FILE_NODE_VIEW_TOP_SAFE_AREA;
	const currentPendingUpdateIndex = activeEditorTarget
		? pendingUpdates.findIndex(
				(pendingUpdate) =>
					pendingUpdate.target.kind === activeEditorTarget.kind && pendingUpdate.target.id === activeEditorTarget.id,
			)
		: -1;
	const hasCurrentPendingUpdates = currentPendingUpdate !== null;
	const activePendingUpdateIndex = hasCurrentPendingUpdates ? currentPendingUpdateIndex : 0;
	const canNavigatePendingUpdates =
		pendingUpdates.length > 1 || (pendingUpdates.length === 1 && !hasCurrentPendingUpdates);
	const reviewPagerLabel = hasCurrentPendingUpdates
		? `${activePendingUpdateIndex + 1} of ${pendingUpdates.length}${hasMorePendingUpdates ? "+" : ""}`
		: "Review";

	const readOnlyMessage = privateEntry
		? privateTargetView?.canEdit === false
			? "You don't have permission to save this draft here."
			: null
		: resolvedNode
			? !resolvedNode.canWrite
				? resolvedNode.writeBlockedReason === "read_only"
					? resolvedNode.kind === "folder"
						? "Folder is read-only. Items keep their own protection."
						: "This file is read-only."
					: `You don't have permission to edit this ${resolvedNode.kind}.`
				: null
			: null;

	// Flat HTML views ignore the URL editor mode, so the root uses this for
	// review routing, scrollbar placement, and panel styles below.
	const isHtmlFile =
		(privateTextIntent?.textKind === "plain_text" &&
			files_editable_text_content_type_of(privateTextIntent.contentType) === "text/html;charset=utf-8") ||
		(resolvedNode != null &&
			files_node_has_editable_text_content(resolvedNode) &&
			files_editable_text_content_type_of(resolvedNode.contentType) === "text/html;charset=utf-8");

	const handleReviewPendingUpdates = useFn(() => {
		// Flat HTML views keep review in local file state; other files use the URL editor mode.
		// From a browser view, keep the split: review beside the browser.
		if (isHtmlFile) {
			handleFileViewChange(
				selectedFileView === "browser" ||
					selectedFileView === "code_browser" ||
					selectedFileView === "review_browser"
					? "review_browser"
					: "review",
			);
			return;
		}
		navigateToView("diff_editor");
	});

	const handleNavigatePendingUpdates = useFn((args: { target: files_PendingTarget; forceDiffEditor: boolean }) => {
		// Carry only the diff view: paging inside a diff review stays in diff review. Any
		// other current view is dropped so each node opens on its own default editor —
		// carrying a plain node's view would force the next `.md` into Monaco.
		const nextView = args.forceDiffEditor || effectiveView === "diff_editor" ? "diff_editor" : undefined;
		navigateToTarget(args.target, nextView);
	});

	const handleNavigatePendingUpdatesDirection = useFn((direction: "prev" | "next") => {
		if (pendingUpdates.length <= 1) {
			if (!pendingUpdates[0] || hasCurrentPendingUpdates) {
				return;
			}

			handleNavigatePendingUpdates({
				target: pendingUpdates[0].target,
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
			target: nextPendingUpdate.target,
			forceDiffEditor: !hasCurrentPendingUpdates,
		});
	});

	const handleNavigatePendingUpdatesPrevious = useFn(() => {
		handleNavigatePendingUpdatesDirection("prev");
	});

	const handleNavigatePendingUpdatesNext = useFn(() => {
		handleNavigatePendingUpdatesDirection("next");
	});

	// Monaco editors and the non-editor file panels keep a scrollbar at the content panel's
	// right edge; rich text and folder views scroll on the shared editor-area scroller, whose
	// bar sits outside the row. Flat HTML views never use rich text mode.
	const editorUsesRichText = !isHtmlFile && effectiveView === "rich_text_editor";
	const topFloatingInnerScrollbar = privateEntry
		? !privateTextIntent || !isEditorActive || !editorUsesRichText
		: resolvedNode?.kind === "file"
			? !resolvedNodeHasEditableTextContent || !isEditorActive || !editorUsesRichText
			: activeEditorNodeId != null && !editorUsesRichText;

	// One shared floating surface; the component hides itself when there is nothing to show.
	const topStickyFloatingSlot = (
		<FileNodeViewTopFloating
			nodeId={resolvedNode?.kind === "file" ? resolvedNode._id : null}
			contentTooLargeByteSize={resolvedNode?.contentTooLargeByteSize ?? null}
			frontmatterTooLarge={
				resolvedNode?.contentFrontmatterTooLargeFieldCount != null &&
				resolvedNode.contentFrontmatterTooLargeIndexDocumentCount !== null
					? {
							fieldCount: resolvedNode.contentFrontmatterTooLargeFieldCount,
							indexDocumentCount: resolvedNode.contentFrontmatterTooLargeIndexDocumentCount,
						}
					: null
			}
			readOnlyMessage={readOnlyMessage}
			pendingSlot={
				hasPendingUpdates ? (
					<FileEditorPendingUpdatesFloating
						updatedAt={currentPendingUpdate?.updatedAt}
						showReviewButton={
							hasCurrentPendingUpdates &&
							(isHtmlFile
								? selectedFileView !== "review" && selectedFileView !== "review_browser"
								: !isEditorActive || effectiveView !== "diff_editor")
						}
						reviewPagerLabel={reviewPagerLabel}
						canNavigate={canNavigatePendingUpdates}
						showLoadMore={hasMorePendingUpdates}
						isLoadingMore={pendingListStatus === "LoadingMore"}
						onReviewChanges={handleReviewPendingUpdates}
						onNavigatePrevious={handleNavigatePendingUpdatesPrevious}
						onNavigateNext={handleNavigatePendingUpdatesNext}
						onLoadMore={() => loadMorePendingUpdates(20)}
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

	// Jump straight to the files search so a copied path, id, or link can be pasted and opened
	// without reaching for the sidebar. `ignoreInputs: false` keeps it working while the editor
	// or another input has focus, which is where users are when they paste a reference.
	AppHotkeysProvider.useHotkey(
		"Mod+K",
		useFn(() => {
			setFilesSidebarOpen(true);

			// The sidebar panel unmounts while closed, so wait for the commit that mounts the input.
			requestAnimationFrame(() => {
				const searchInput = document
					.getElementById("app_files_sidebar_search" satisfies AppElementId)
					?.querySelector("input");

				searchInput?.focus();
				searchInput?.select();
			});
		}),
		{ ignoreInputs: false },
	);

	// Restore the exact saved/private target only when the URL has no selection.
	useEffect(() => {
		if (searchNodeId || searchPrivateNodeId) {
			return;
		}

		if (lastOpenTarget?.kind === "private") {
			onNavigateSearch({ pendingNodeId: lastOpenTarget.id, q: searchParams.q }, { replace: true });
			return;
		}

		navigateToNode(lastOpenTarget?.kind === "saved" ? lastOpenTarget.id : files_ROOT_ID);
	}, [lastOpenTarget, navigateToNode, onNavigateSearch, searchNodeId, searchPrivateNodeId, searchParams.q]);

	// Keep private IDs tagged. A missing private draft must never fall through to saved-file lookup.
	useEffect(() => {
		if (searchPrivateNodeId) {
			if (privateTargetView === undefined) return;
			setLastOpenTarget(privateEntry ? { kind: "private", id: privateEntry.node._id } : null);
		} else if (searchNodeId) {
			setLastOpenTarget(searchNodeId === files_ROOT_ID ? { kind: "root" } : { kind: "saved", id: searchNodeId });
		}
	}, [searchNodeId, searchPrivateNodeId, privateTargetView, privateEntry, setLastOpenTarget]);

	// If a requested node id cannot be resolved, clear stale last-open and fall back to the root folder.
	useEffect(() => {
		if (!searchNodeId || resolvedNode === undefined || resolvedNode !== null) {
			return;
		}

		setLastOpenTarget(null);
		navigateToNode(files_ROOT_ID);
	}, [navigateToNode, resolvedNode, searchNodeId, setLastOpenTarget]);

	const contentPanelStyle =
		isEditorActive && editorUsesRichText
			? {
					minHeight: "100%",
					height: "max-content",
					overflow: "visible",
				}
			: undefined;

	const renderContent = (
		presenceProps: Parameters<FileEditorPresenceSupplier_Props["children"]>[0],
		toolbarPortalHost: HTMLElement,
		viewSelectPortalHost: HTMLElement,
	) => {
		if (searchPrivateNodeId) {
			return privateEntry && privateTargetView ? (
				<FileNodeViewPrivateContent
					key={privateSourceKey}
					view={{ ...privateTargetView, entry: privateEntry }}
					selectedFileView={selectedFileView}
					editorMode={effectiveView}
					filesSidebarOpen={filesSidebarOpen}
					fileNodesList={fileNodesList}
					protectedDescendantIds={protectedDescendantIds}
					topSafeArea={topSafeArea}
					toolbarPortalHost={toolbarPortalHost}
					viewSelectPortalHost={viewSelectPortalHost}
					presenceStore={presenceProps.presenceStore}
					onEditorModeChange={navigateToView}
					onAutomaticEditorModeChange={handleAutomaticEditorModeChange}
					onFileViewChange={handleFileViewChange}
					onTargetChange={(target, options) =>
						handleEditorTargetChange(`${membershipId}:${selectionKey}`, target, options)
					}
					onNavigateTarget={navigateToTarget}
					onNavigateNode={navigateToNode}
				/>
			) : (
				<div className={"FileNodeView-loading-text" satisfies FileNodeView_ClassNames} role="status">
					{privateTargetView === undefined
						? "Loading draft…"
						: "This draft is no longer available. You can discard it in Pending changes."}
				</div>
			);
		}

		return resolvedNodeId ? (
			<FileNodeViewContent
				key={membershipId}
				selectedFileView={selectedFileView}
				selectedNodeId={searchNodeId}
				node={resolvedNode}
				fileNodesList={fileNodesList}
				protectedDescendantIds={protectedDescendantIds}
				pendingUpdateId={currentPendingUpdate?._id}
				committedAssetId={activeEditorNode?.collaborationEnabled === false ? (activeEditorNode.assetId ?? null) : null}
				pendingUpdatesLoaded={!activeEditorTarget || editorPendingUpdate !== undefined}
				serverSequence={activeEditorServerSequenceData?.lastSequence}
				yjsLastSequenceId={activeEditorServerSequenceData?.yjsLastSequenceId}
				topSafeArea={topSafeArea}
				editorMode={effectiveView}
				filesSidebarOpen={filesSidebarOpen}
				presenceStore={presenceProps.presenceStore}
				onlineUsers={presenceProps.onlineUsers}
				commentsPortalHost={commentsPortalHost}
				toolbarPortalHost={toolbarPortalHost}
				viewSelectPortalHost={viewSelectPortalHost}
				onEditorModeChange={navigateToView}
				onAutomaticEditorModeChange={handleAutomaticEditorModeChange}
				onFileViewChange={handleFileViewChange}
				onNavigateNode={navigateToNode}
			/>
		) : searchNodeId ? (
			<div className={"FileNodeView-loading-text" satisfies FileNodeView_ClassNames}>Loading...</div>
		) : null;
	};

	return (
		// The whole workspace area is this route's main landmark: the files sidebar, the resize
		// handle between the panels, and the editor. With main only on the editor area, the resize
		// handle sat outside every landmark, which axe flags (region). The editor keeps its own
		// named region landmark, and the files sidebar stays an aside inside main, which ARIA allows.
		<MyPanelGroup
			tagName="main"
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
					initialSearchQuery={searchParams.q ?? ""}
					onClose={handleCloseSidebar}
					onArchive={handleArchive}
					onPrimaryAction={handlePrimaryAction}
					onSearchQueryChange={handleSearchQueryChange}
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
				<div
					className={cn(
						"FileNodeView-editor-area" satisfies FileNodeView_ClassNames,
						"app-scrollable" satisfies AppClassName,
					)}
				>
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
										viewSelectRef={handleViewSelectPortalHostChange}
										showEditorActions={
											isEditorActive &&
											(!searchPrivateNodeId || (!!privateTextIntent && privateTargetView?.readiness === "ready"))
										}
										folderActionsSlot={folderActionsSlot}
										fileActionsSlot={
											privateEntry && privateTargetView ? (
												<FileNodeViewPrivateActions
													key={privateSourceKey}
													view={{ ...privateTargetView, entry: privateEntry }}
													onTargetChange={(target, options) =>
														handleEditorTargetChange(`${membershipId}:${selectionKey}`, target, options)
													}
												/>
											) : (
												<FileNodeViewToolbarFileDownloadAction node={resolvedNode} />
											)
										}
									/>
								)}
							</FileNodeViewToolbarCreateNodeActions>
							{topStickyFloatingSlot ? (
								<FileNodeViewTopStickyFloatingContainer innerScrollbar={topFloatingInnerScrollbar}>
									{topStickyFloatingSlot}
								</FileNodeViewTopStickyFloatingContainer>
							) : null}
							{/* Mount both toolbar hosts before the content that fills them. */}
							{toolbarPortalHost && viewSelectPortalHost && activeEditorTarget ? (
								<FileEditorPresenceSupplier
									key={`${membershipId}:${activeEditorTarget.kind}:${activeEditorTarget.id}`}
									userId={authenticated.userId}
									target={activeEditorTarget}
								>
									{(presenceProps) => renderContent(presenceProps, toolbarPortalHost, viewSelectPortalHost)}
								</FileEditorPresenceSupplier>
							) : toolbarPortalHost && viewSelectPortalHost ? (
								renderContent({ presenceStore: null, onlineUsers: [] }, toolbarPortalHost, viewSelectPortalHost)
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
							<FileEditorSidebar
								node={resolvedNode ?? null}
								isPrivate={!!searchPrivateNodeId}
								commentsContainerRef={setCommentsPortalHost}
								browserNodeId={searchPrivateNodeId ?? resolvedNode?._id ?? null}
								browserNodeKind={searchPrivateNodeId ? "private" : resolvedNode ? "saved" : null}
							/>
						</MyPanel>
					</MyPanelGroup>
				</div>
			</MyPanel>
		</MyPanelGroup>
	);
});
// #endregion root
