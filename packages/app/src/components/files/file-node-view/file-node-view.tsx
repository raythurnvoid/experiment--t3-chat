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
import { FileDraftRecovery } from "./file-draft-recovery.tsx";
import { FilePendingNotice } from "./file-pending-notice.tsx";
import { FileImagePreview } from "../file-image-preview.tsx";
import { FilesBrowser } from "./files-browser.tsx";
import {
	FileNodeViewFolderCreateNodeModal,
	type FileNodeViewFolderCreateNodeModal_Ref,
} from "./file-node-view-folder-create-node-modal.tsx";
import { FilesSidebarToggle } from "../files-sidebar-toggle.tsx";
import { FilesArchiveModal, type FilesArchiveModal_Node } from "../files-archive-modal.tsx";
import { FilesShareModal } from "../files-share-modal.tsx";
import { FilesPropertiesModal } from "../files-properties-modal.tsx";
import { FilesClipboardMenuItems, FilesClipboardProvider } from "../files-clipboard.tsx";
import { MainAppHeaderBillingIndicator } from "@/components/main-app-header-billing-indicator.tsx";
import { MainAppSidebarToggle } from "@/components/main-app-sidebar-toggle.tsx";
import { CopyIconButton } from "@/components/copy-icon-button.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyFloatingSurface } from "@/components/my-floating-surface.tsx";
import {
	MyGridTable,
	MyGridTableBody,
	MyGridTableCell,
	MyGridTableColumnHeader,
	MyGridTableHeader,
	MyGridTableRow,
} from "@/components/my-grid-table.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyLink, MyLinkIcon } from "@/components/my-link.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import {
	MyMenu,
	MyMenuItem,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	MyMenuItemsGroup,
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
import { useFilesSortedChildren, useFilesVisibleEntries } from "@/hooks/files-search-hooks.ts";
import { useFileNodeActivities } from "@/lib/activities.ts";
import { app_convex, app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import { FilesTreeProvider } from "@/lib/files-tree-context.tsx";
import { format_relative_time } from "@/lib/date.ts";
import type { AppClassName, AppElementId } from "@/lib/dom-utils.ts";
import { file_editor_get_content_too_large_message } from "@/lib/file-editor.ts";
import { files_truncate_path_segments } from "@/lib/file-paths.ts";
import {
	files_ROOT_ID,
	files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE,
	files_build_private_review_selection,
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
import { global_custom_event_dispatch, useGlobalCustomEvent } from "@/lib/global-event.tsx";
import { APP_FONT_FAMILY } from "@/lib/ui.tsx";
import { url_path_file_by_node_id } from "@/lib/urls.ts";
import { cn, copy_to_clipboard, sx } from "@/lib/utils.ts";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable, dropTargetForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import { Link } from "@tanstack/react-router";
import { useConvex, useQueries, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { usePaginatedQuery } from "convex-helpers/react";
import {
	Archive,
	ArrowDown,
	ArrowUp,
	BookOpen,
	ChevronDown,
	CircleAlert,
	Download,
	EllipsisVertical,
	ExternalLink,
	FileDigit,
	FilePlus,
	FileText,
	Folder,
	FolderPlus,
	Hash,
	Home,
	Link2,
	Lock,
	LockKeyhole,
	PanelLeftOpen,
	Users,
} from "lucide-react";
import React, { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { FilesSidebar } from "../files-sidebar.tsx";
import {
	files_metadata_FRONTMATTER_FIELD_PREFIX,
	files_metadata_MAX_FRONTMATTER_FIELDS,
	files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS,
	files_metadata_METADATA_FIELD_PREFIX,
} from "../../../../shared/files-metadata.ts";
import {
	files_sort_BUILT_IN_FIELDS,
	files_sort_DEFAULT,
	files_sort_field_is_built_in,
	files_sort_field_is_valid,
	type files_sort_Sort,
} from "../../../../shared/files-sort.ts";
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
type FileNodeViewHeaderBreadcrumbPath_ClassNames =
	| "FileNodeViewHeaderBreadcrumbPath"
	| "FileNodeViewHeaderBreadcrumbPath-list"
	| "FileNodeViewHeaderBreadcrumbPath-segment"
	| "FileNodeViewHeaderBreadcrumbPath-current"
	| "FileNodeViewHeaderBreadcrumbPath-current-arrow"
	| "FileNodeViewHeaderBreadcrumbPath-current-tip-name"
	| "FileNodeViewHeaderBreadcrumbPath-current-tip-hint";

type FileNodeViewHeaderBreadcrumbPath_Crumb = {
	id: string;
	name: string;
	/**
	 * Which route param the crumb's link sets: `nodeId` for a saved node, `pendingNodeId` for a
	 * pending one.
	 */
	target: "saved" | "private";
};

type FileNodeViewHeaderBreadcrumbPath_Props = {
	/** Lands on the open file's crumb button, so the Archive dialog can give focus back to it. */
	currentRef: RefObject<HTMLButtonElement | null>;
	/** The path of the open file, root-first. The last crumb is the open file itself. */
	crumbs: FileNodeViewHeaderBreadcrumbPath_Crumb[];
	filesSidebarOpen: boolean;
	/** The `MyMenuPopover` of the open file's crumb. The header owns its actions. */
	currentMenu: ReactNode;
};

// Pretext measures with these values so resize work never calls `getComputedStyle`. Every crumb is
// a `MyButton` surface (the links through `MyLinkSurface`, the open file's crumb as the menu
// trigger), so one font covers them all: `.MyButton` in my-button.css sets weight 500 and size
// 0.875rem (14px). Keep these in sync with that rule.
const BREADCRUMB_FONT = `500 14px ${APP_FONT_FAMILY}`;
const BREADCRUMB_LETTER_SPACING = 0;
// Every crumb lands on 8px each side: `components` beats `common_components`, so the breadcrumb's
// `6px 8px` wins over the variant's `8px 12px`. Do not "correct" this to 24.
const BREADCRUMB_SEGMENT_PADDING_X = 16;
// The menu arrow after the open file's name: the 12px icon from
// `.FileNodeViewHeaderBreadcrumbPath-current-arrow` plus the crumb's 4px `gap`. Keep in sync with that CSS.
const BREADCRUMB_CURRENT_ARROW_WIDTH = 16;
// The `gap` of `.FileNodeViewHeader-start` and the `gap` of the two breadcrumb lists.
const BREADCRUMB_START_GAP = 8;
const BREADCRUMB_LIST_GAP = 4;

/**
 * The crumbs of the open file: the ancestors as links in one scrolling group, then the open file's
 * crumb as a menu trigger. One ladder call shortens every label so the row fits the header.
 */
const FileNodeViewHeaderBreadcrumbPath = memo(function FileNodeViewHeaderBreadcrumbPath(
	props: FileNodeViewHeaderBreadcrumbPath_Props,
) {
	const { currentRef, crumbs, filesSidebarOpen, currentMenu } = props;

	const { organizationName, workspaceName } = AppTenantProvider.useContext();

	const ancestors = crumbs.slice(0, -1);
	const current = crumbs[crumbs.length - 1];
	// One string, so the effect below depends on a primitive. File names never contain `/`.
	const path = crumbs.map((crumb) => crumb.name).join("/");

	const groupRef = useRef<HTMLLIElement>(null);
	const listRef = useRef<HTMLOListElement>(null);
	const currentItemRef = useRef<HTMLLIElement>(null);
	// The shortened label of each crumb, in `crumbs` order. Empty until the first measurement, so
	// every read falls back to the crumb's name. Right after a navigation it still holds the previous
	// path's labels for one render; the layout effect replaces them before paint.
	const [labels, setLabels] = useState<string[]>([]);
	const currentLabel = labels[ancestors.length] ?? current.name;

	// Tab focus scrolls a crumb into the group only when the crumb is fully hidden. A crumb cut at
	// the edge keeps its focus ring cut, so bring every focused crumb fully into the scroll port.
	const handleListFocus = (event: React.FocusEvent<HTMLOListElement>) => {
		event.target.scrollIntoView({ block: "nearest", inline: "nearest" });
	};

	useLayoutEffect(() => {
		const groupElement = groupRef.current;
		const listElement = listRef.current;
		const breadcrumbElement = groupElement?.parentElement;
		const startElement = breadcrumbElement?.closest<HTMLElement>(
			`.${"FileNodeViewHeader-start" satisfies FileNodeViewHeader_ClassNames}`,
		);
		if (!groupElement || !listElement || !breadcrumbElement || !startElement) {
			return;
		}

		let cancelled = false;

		const updateLabels = () => {
			const segments = path.split("/");
			let next = segments;

			// Skip the measurement while the header is not laid out (hidden, or the happy-dom tests).
			if (startElement.clientWidth > 0) {
				// Read a box with the DOM only when its width is set by the layout: the sidebar toggles,
				// the home link, the icon buttons and the `/` separators. A crumb box follows its label,
				// so reading it would feed the shortening back into its own input, and the row could
				// never grow back. Pretext measures the crumbs instead.
				let fixedWidth = BREADCRUMB_START_GAP * (startElement.children.length - 1);
				for (const child of startElement.children) {
					if (child !== breadcrumbElement) {
						fixedWidth += child.getBoundingClientRect().width;
					}
				}
				fixedWidth += BREADCRUMB_LIST_GAP * (breadcrumbElement.children.length - 1);
				for (const item of breadcrumbElement.children) {
					if (item !== groupElement && item !== currentItemRef.current) {
						fixedWidth += item.getBoundingClientRect().width;
					}
				}
				fixedWidth += BREADCRUMB_LIST_GAP * Math.max(0, listElement.children.length - 1);
				for (const item of listElement.children) {
					// The `/` separators between the ancestor crumbs.
					if (item.getAttribute("aria-hidden") === "true") {
						fixedWidth += item.getBoundingClientRect().width;
					}
				}
				// `clientWidth` is an integer while rects and Pretext widths are fractional. Erring
				// small only shortens one character early.
				const available = startElement.clientWidth - fixedWidth - 1;

				// Pretext caches canvas `measureText` per segment, but `prepareWithSegments` re-segments
				// on every call. `files_truncate_path_segments` measures unchanged labels many times in
				// one pass, so keep one map per pass. The map is dropped after the pass, so it needs no
				// eviction.
				const widths = new Map<string, number>();
				const measureLabelWidth = (label: string) => {
					const cached = widths.get(label);
					if (cached !== undefined) return cached;

					const width = measureNaturalWidth(
						prepareWithSegments(label, BREADCRUMB_FONT, {
							letterSpacing: BREADCRUMB_LETTER_SPACING,
							whiteSpace: "normal",
						}),
					);
					widths.set(label, width);
					return width;
				};

				// Measure only the crumb boxes. `fixedWidth` above already counts every gap and separator.
				next = files_truncate_path_segments({
					segments,
					collapse: "keep",
					fits: (candidateLabels) => {
						// Only the open file's crumb has the arrow, and it is always there.
						let used = BREADCRUMB_CURRENT_ARROW_WIDTH;
						for (const label of candidateLabels) {
							used += measureLabelWidth(label) + BREADCRUMB_SEGMENT_PADDING_X;
						}
						return used <= available;
					},
				});
			}

			if (cancelled) return;

			// Bail out when nothing changed, so a window drag does not re-render on every pixel.
			setLabels((previous) =>
				previous.length === next.length && previous.every((label, index) => label === next[index]) ? previous : next,
			);
		};

		updateLabels();

		// The width of `-start` changes when the header or the switch group changes (the billing
		// indicator appearing, presence avatars), never when the labels change, so the observer
		// cannot re-fire on its own output. Never observe the ancestors group or a crumb box.
		const resizeObserver =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(() => {
						updateLabels();
					});
		resizeObserver?.observe(startElement);
		void document.fonts?.ready.then(() => updateLabels());

		return () => {
			cancelled = true;
			resizeObserver?.disconnect();
		};
		// The sidebar toggle buttons sit inside `-start` and appear or disappear without `-start`
		// changing width, so the effect must also run on `filesSidebarOpen`.
	}, [path, filesSidebarOpen]);

	return (
		<>
			{/* Keep the ancestors in a nested list so they scroll as one group while the open file name
			    and the buttons stay put. Render the wrapper even with no ancestors, so the measurement
			    always has its element. */}
			<li
				ref={groupRef}
				className={cn("FileNodeViewHeaderBreadcrumbPath" satisfies FileNodeViewHeaderBreadcrumbPath_ClassNames)}
			>
				<ol
					ref={listRef}
					className={cn("FileNodeViewHeaderBreadcrumbPath-list" satisfies FileNodeViewHeaderBreadcrumbPath_ClassNames)}
					onFocus={handleListFocus}
				>
					{ancestors.map((crumb, index) => {
						const label = labels[index] ?? crumb.name;

						return (
							<React.Fragment key={crumb.id}>
								<li>
									{/* Keep this wrapper mounted even when the name fits. Adding it only after the
									    label shortens would remount the link and drop focus during a resize.
									    The tip repeats the name, so it only renders once the visible label is shorter.
									    Show it immediately. The pointer is already on the short label.
									    Force the tip closed while the name fits. The code that hides the tip lives in the
									    content, so once the content unmounts nothing else closes it. A tip opened by focus
									    would then show again by itself the next time the label shortens. */}
									<MyTooltip timeout={0} placement="bottom" open={label === crumb.name ? false : undefined}>
										<MyTooltipTrigger>
											<MyLink
												className={cn(
													"FileNodeViewHeaderBreadcrumbPath-segment" satisfies FileNodeViewHeaderBreadcrumbPath_ClassNames,
												)}
												to="/w/$organizationName/$workspaceName/files"
												params={{ organizationName, workspaceName }}
												// Keep `q` (functional form) so the URL stays in step with the sidebar search box.
												search={(prev) => ({
													...prev,
													nodeId: crumb.target === "saved" ? crumb.id : undefined,
													pendingNodeId: crumb.target === "private" ? crumb.id : undefined,
													view: undefined,
												})}
												variant="button-ghost-highlightable"
												// `aria-label` keeps the full name readable next to the shortened text.
												aria-label={crumb.name}
											>
												{label}
											</MyLink>
										</MyTooltipTrigger>
										{label !== crumb.name ? <MyTooltipContent unmountOnHide>{crumb.name}</MyTooltipContent> : null}
									</MyTooltip>
								</li>
								{index < ancestors.length - 1 && <li aria-hidden="true">/</li>}
							</React.Fragment>
						);
					})}
				</ol>
			</li>
			{/* Keep the separator before the open file outside the scroller so it never scrolls away. */}
			{ancestors.length > 0 && <li aria-hidden="true">/</li>}
			{/* Mark which crumb is the open file. Playwriter finds it by this attribute. */}
			<li ref={currentItemRef} aria-current="page">
				<MyMenu placement="bottom-start">
					{/* Unlike the ancestor crumbs, this tip always renders, because it also says what a click
					    does. A shortened label adds the full name above that hint and shows the tip at once,
					    since the pointer is already on the short label. A label that fits keeps the normal
					    tooltip delay.
					    The tip closes when the menu takes focus. Hover could still show it again if the
					    pointer leaves and comes back while the menu is open, so skip hover while the menu
					    button is expanded. */}
					<MyTooltip timeout={currentLabel === current.name ? undefined : 0} placement="bottom">
						<MyTooltipTrigger showOnHover={(event) => event.currentTarget.getAttribute("aria-expanded") !== "true"}>
							<MyMenuTrigger>
								<MyButton
									ref={currentRef}
									className={cn(
										"FileNodeViewHeaderBreadcrumbPath-current" satisfies FileNodeViewHeaderBreadcrumbPath_ClassNames,
									)}
									variant="ghost-highlightable"
									aria-label={current.name}
								>
									{currentLabel}
									<MyButtonIcon
										className={
											"FileNodeViewHeaderBreadcrumbPath-current-arrow" satisfies FileNodeViewHeaderBreadcrumbPath_ClassNames
										}
										aria-hidden
									>
										<ChevronDown />
									</MyButtonIcon>
								</MyButton>
							</MyMenuTrigger>
						</MyTooltipTrigger>
						<MyTooltipContent unmountOnHide>
							{currentLabel !== current.name ? (
								<span
									className={
										"FileNodeViewHeaderBreadcrumbPath-current-tip-name" satisfies FileNodeViewHeaderBreadcrumbPath_ClassNames
									}
								>
									{current.name}
								</span>
							) : null}
							<span
								className={
									"FileNodeViewHeaderBreadcrumbPath-current-tip-hint" satisfies FileNodeViewHeaderBreadcrumbPath_ClassNames
								}
							>
								Click for file actions
							</span>
						</MyTooltipContent>
					</MyTooltip>
					{currentMenu}
				</MyMenu>
			</li>
		</>
	);
});

type FileNodeViewHeader_ClassNames =
	| "FileNodeViewHeader"
	| "FileNodeViewHeader-start"
	| "FileNodeViewHeader-sidebars-actions"
	| "FileNodeViewHeader-breadcrumb"
	| "FileNodeViewHeader-breadcrumb-home"
	| "FileNodeViewHeader-breadcrumb-segment-current"
	| "FileNodeViewHeader-switch-group";

type FileNodeViewHeader_Props = {
	selectedNodeId: string | null | undefined;
	privateView?: FileNodeViewPrivateView;
	fileNodesList: files_VisibleTreeNode[] | undefined;
	protectedDescendantIds: ReadonlySet<app_convex_Id<"files_nodes">>;
	filesSidebarOpen: boolean;
	showFileControls: boolean;
	onlineUsers: FileEditor_OnlineUser[];
	onNavigateNode: (nodeId: typeof files_ROOT_ID | app_convex_Id<"files_nodes">) => void;
};

const FileNodeViewHeader = memo(function FileNodeViewHeader(props: FileNodeViewHeader_Props) {
	const {
		selectedNodeId,
		privateView,
		fileNodesList,
		protectedDescendantIds,
		filesSidebarOpen,
		showFileControls,
		onlineUsers,
		onNavigateNode,
	} = props;

	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();

	const breadcrumbPath = get_breadcrumb_path(fileNodesList, selectedNodeId);
	const crumbs: FileNodeViewHeaderBreadcrumbPath_Crumb[] = privateView
		? [
				// Saved folders above the pending chain, root-first. `get_breadcrumb_path` stops at the first
				// folder the user cannot read, exactly as it does for a saved node.
				...get_breadcrumb_path(fileNodesList, privateView.savedParentId).map((node) => ({
					id: node._id,
					name: node.name,
					target: "saved" as const,
				})),
				// The entry's own pending folders, root-first. Their name is the last path segment; `path`
				// starts with a slash.
				...privateView.requiredParents.map((parent) => ({
					id: parent.target.id,
					name: parent.path.slice(parent.path.lastIndexOf("/") + 1),
					target: "private" as const,
				})),
				{ id: privateView.entry.node._id, name: privateView.entry.node.name, target: "private" },
			]
		: breadcrumbPath.map((node) => ({ id: node._id, name: node.name, target: "saved" }));

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

	// Same gate as the sidebar row menu. `parentCanWrite` does not take part in `canArchiveOrRestore`,
	// so pass the node's own answer and the call reads like the row's.
	const canArchive =
		!!currentNode &&
		currentNode.archiveOperationId === null &&
		files_get_read_only_capabilities({
			canWrite: currentNode.canWrite,
			parentCanWrite: currentNode.canWrite,
			hasVisibleProtectedDescendant: protectedDescendantIds.has(currentNode._id),
		}).canArchiveOrRestore;

	const [shareNodeId, setShareNodeId] = useState<app_convex_Id<"files_nodes"> | null>(null);
	const [propertiesNodeId, setPropertiesNodeId] = useState<app_convex_Id<"files_nodes"> | null>(null);
	/** The node the Archive dialog is about, or `null` while it is closed. */
	const [archiveNode, setArchiveNode] = useState<FilesArchiveModal_Node | null>(null);
	const propertiesTriggerRef = useRef<HTMLButtonElement>(null);
	const currentCrumbRef = useRef<HTMLButtonElement>(null);

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

	const handleRevealInSidebar = useFn(() => {
		if (!currentNode) return;
		global_custom_event_dispatch("files::reveal_node", { membershipId, nodeId: currentNode._id });
	});

	const handleDuplicateTab = useFn(() => {
		window.open(window.location.href, "_blank", "noopener");
	});

	const handleCopyNodeId = useFn(() => {
		const nodeId = privateView ? privateView.entry.node._id : currentNode?._id;
		if (!nodeId) return;
		copy_to_clipboard({ text: nodeId }).catch((error) => {
			console.error("[FileNodeViewHeader.handleCopyNodeId] Failed to copy node id", { error, nodeId });
		});
	});

	const handleArchive = useFn(() => {
		if (!currentNode || !canArchive) return;
		setArchiveNode({ _id: currentNode._id, name: currentNode.name, kind: currentNode.kind });
	});

	const handleArchiveModalClose = useFn(() => {
		setArchiveNode(null);
	});

	const handleArchived = useFn(() => {
		setArchiveNode(null);
		// The open node is gone. Leave the user on the root, as the sidebar's archive does.
		onNavigateNode(files_ROOT_ID);
	});

	// The menu of the open file's crumb. The crumb component renders the trigger; the actions live
	// here because the header already holds the node and its handlers.
	const currentMenu = (
		<MyMenuPopover>
			<MyMenuPopoverContent>
				<MyMenuItemsGroup>
					{/* A pending entry has no tree row, and an archived node's row is hidden from the tree, so
					    there is nothing to reveal. */}
					{!privateView && currentNode?.archiveOperationId === null && (
						<MyMenuItem hideOnClick onClick={handleRevealInSidebar}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<PanelLeftOpen />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>Reveal in sidebar</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
					)}
					{/* The browser's Duplicate tab: the page as it is now, in a new tab. Read the URL at
					    click time, so a `view` or `q` change that did not re-render the header still comes
					    along. Browsers allow `window.open` inside a click handler, so a popup blocker does
					    not stop it. */}
					<MyMenuItem hideOnClick onClick={handleDuplicateTab}>
						<MyMenuItemContent>
							<MyMenuItemContentIcon>
								<ExternalLink />
							</MyMenuItemContentIcon>
							<MyMenuItemContentPrimary>Duplicate tab</MyMenuItemContentPrimary>
						</MyMenuItemContent>
					</MyMenuItem>
				</MyMenuItemsGroup>
				<MyMenuItemsGroup separator>
					<MyMenuItem hideOnClick onClick={handleCopyNodeId}>
						<MyMenuItemContent>
							<MyMenuItemContentIcon>
								<Hash />
							</MyMenuItemContentIcon>
							<MyMenuItemContentPrimary>Copy node id</MyMenuItemContentPrimary>
						</MyMenuItemContent>
					</MyMenuItem>
				</MyMenuItemsGroup>
				{canArchive && (
					<MyMenuItemsGroup separator>
						<MyMenuItem variant="destructive" hideOnClick onClick={handleArchive}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<Archive />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>Archive</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
					</MyMenuItemsGroup>
				)}
			</MyMenuPopoverContent>
		</MyMenuPopover>
	);

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
					{privateView ? (
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
							<FileNodeViewHeaderBreadcrumbPath
								currentRef={currentCrumbRef}
								crumbs={crumbs}
								filesSidebarOpen={filesSidebarOpen}
								currentMenu={currentMenu}
							/>
							<li>
								<CopyIconButton variant="ghost-highlightable" tooltipCopy="Copy path" text={privateView.entry.path} />
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
							<FileNodeViewHeaderBreadcrumbPath
								currentRef={currentCrumbRef}
								crumbs={crumbs}
								filesSidebarOpen={filesSidebarOpen}
								currentMenu={currentMenu}
							/>
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
			<FilesArchiveModal
				nodes={archiveNode ? [archiveNode] : null}
				returnFocusRef={currentCrumbRef}
				onClose={handleArchiveModalClose}
				onArchived={handleArchived}
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
		hasHtmlPreview && selectedViewExists && selectedFileView === "default"
			? "code"
			: selectedViewExists
				? selectedFileView
				: "default";
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
			selectedFileView === "browser" || selectedFileView === "code_browser" || selectedFileView === "review_browser";
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
		hasHtmlPreview && (activeFileView === "preview" || activeFileView === "details" || activePluginView != null);

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
									<MyPanelResizeHandle isOpen closeBehavior="unmount" aria-label="Resize editor and browser" />
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
	| "FileNodeViewPrivate-parents"
	| "FileNodeViewPrivate-body"
	| "FileNodeViewPrivate-media"
	| "FileNodeViewPrivate-table"
	| "FileNodeViewPrivate-name";

type FileNodeViewPrivateView = NonNullable<
	FunctionReturnType<typeof app_convex_api.files_pending_updates.get_file_pending_target>
> & { entry: Extract<files_VisibleEntry, { kind: "private" }> };

const FileNodeViewPrivateActions = memo(function FileNodeViewPrivateActions(props: { view: FileNodeViewPrivateView }) {
	const { view } = props;
	const { startReview, isStartingReview } = AppActivitiesProvider.useContext();
	const [busy, setBusy] = useState<"save" | "discard" | null>(null);
	const actionsRef = useRef<HTMLDivElement>(null);
	const pendingUpdate = view.entry.pendingUpdate;

	// Save and Discard remove this whole row, so keyboard focus would fall to <body> and the user
	// would lose their place. Move it to the file content area instead. The cleanup must be a layout
	// effect: a passive effect runs after the paint, when the button is no longer the active element.
	useLayoutEffect(() => {
		const actions = actionsRef.current;
		return () => {
			if (!actions?.contains(document.activeElement)) return;
			const fileArea = actions.closest<HTMLElement>(".FileNodeView-editor-area");
			// Wait for button removal to finish. Keep any focus moved by the review dialog.
			queueMicrotask(() => {
				if (document.activeElement === document.body) fileArea?.focus();
			});
		};
	}, []);

	const handleSave = useFn(() => {
		if (busy || isStartingReview || !view.canAcceptWithParents || view.readiness !== "ready") return;
		setBusy("save");

		// The Activity dialog owns progress and errors, with or without pending parents.
		void startReview(
			files_build_private_review_selection({
				kind: "accept",
				pendingUpdate,
				requiredParents: view.requiredParents,
			}),
		)
			.catch((error: unknown) => {
				toast.error(error instanceof Error ? error.message : "The draft could not be saved. Try again.");
			})
			.finally(() => {
				setBusy(null);
			});
	});

	const handleDiscard = useFn(() => {
		if (busy || isStartingReview) return;
		setBusy("discard");
		void startReview(
			files_build_private_review_selection({
				kind: "discard",
				pendingUpdate,
				requiredParents: view.requiredParents,
			}),
		)
			.catch((error: unknown) => {
				toast.error(error instanceof Error ? error.message : "The draft could not be discarded. Try again.");
			})
			.finally(() => {
				setBusy(null);
			});
	});

	return (
		<div ref={actionsRef} className={"FileNodeViewPrivate-actions" satisfies FileNodeViewPrivate_ClassNames}>
			<span className={"FileNodeViewPrivate-status" satisfies FileNodeViewPrivate_ClassNames} role="status">
				{busy === "save"
					? "Saving…"
					: busy === "discard"
						? "Discarding…"
						: view.readiness === "preparing"
							? "Preparing…"
							: view.entry.node.kind === "folder"
								? "Added folder"
								: "Added file"}
			</span>
			{/* While a save or discard runs, both buttons use `aria-disabled` instead of `disabled`. A
			    real `disabled` button drops out of the tab order and loses focus, which throws a
			    keyboard user out of this row. The click handlers above already refuse while busy.
			    Save keeps a real `disabled` for the case where the draft cannot be accepted at all. */}
			{pendingUpdate.createIntent?.kind !== "text" && (
				<MyButton
					variant="outline"
					disabled={!view.canAcceptWithParents || view.readiness !== "ready"}
					aria-disabled={!!busy || isStartingReview}
					aria-busy={busy === "save"}
					onClick={handleSave}
				>
					Save
				</MyButton>
			)}
			<MyButton
				variant="outline"
				aria-disabled={!!busy || isStartingReview}
				aria-busy={busy === "discard"}
				onClick={handleDiscard}
			>
				Discard
			</MyButton>
			{view.requiredParents.length > 0 && (
				<span className={"FileNodeViewPrivate-parents" satisfies FileNodeViewPrivate_ClassNames}>
					Save also creates: {view.requiredParents.map((parent) => parent.path).join(", ")}
				</span>
			)}
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
	const isImage = serving.responseContentType.startsWith("image/");

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
				{/* An image already loads below on its own, so Preview would add nothing for it. Only
				    images and video are served inline, so this button is left for video. */}
				{canPreview && !isImage && (
					<MyButton variant="outline" disabled={busy} onClick={() => handleRead(false)}>
						Preview
					</MyButton>
				)}
				<MyButton variant="outline" disabled={busy} onClick={() => handleRead(true)}>
					Download
				</MyButton>
			</div>
			{isImage && (
				<FileImagePreview
					target={{
						kind: "private",
						id: entry.node._id,
						pendingUpdateId: entry.pendingUpdate._id,
						reviewedRevision: entry.pendingUpdate.revision,
						creationGeneration: entry.node.creationGeneration,
					}}
					alt={entry.node.name}
				/>
			)}
			{previewUrl &&
				(serving.responseContentType.startsWith("video/") ? (
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
		(activePrivateView === "browser" || activePrivateView === "code_browser" || activePrivateView === "review_browser");
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
			selectedFileView === "browser" || selectedFileView === "code_browser" || selectedFileView === "review_browser";
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
				privateView={view}
				fileNodesList={fileNodesList}
				protectedDescendantIds={protectedDescendantIds}
				filesSidebarOpen={filesSidebarOpen}
				showFileControls={false}
				onlineUsers={[]}
				onNavigateNode={onNavigateNode}
			/>
			<FilePendingNotice recovery={view.recovery} copyDestination={view.copyDestination} />
			{view.recovery && textIntent ? (
				<FileDraftRecovery entry={entry} />
			) : view.readiness === "ready" && textIntent ? (
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
											<MyPanelResizeHandle isOpen closeBehavior="unmount" aria-label="Resize editor and browser" />
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
						view.recovery ? (
							<p>Open child drafts from Pending changes.</p>
						) : (
							<FileNodeViewPrivateFolder folderPath={entry.path} onNavigateTarget={onNavigateTarget} />
						)
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
	const serving = files_get_signed_download_serving({ contentType: node.contentType, fileName: node.name });

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
			{/* Wait for `r2Key`: an asset that is still uploading has no bytes to sign a URL for. The
			    preview takes `assetId` so that replacing the file asks for a new URL. */}
			{asset?.r2Key && node.assetId && serving.responseContentType.startsWith("image/") && (
				<FileImagePreview target={{ kind: "saved", id: node._id, assetId: node.assetId }} alt={node.name} />
			)}

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

type FileNodeViewFolderRow = NonNullable<ReturnType<typeof useFilesSortedChildren>["rows"]>[number];

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

	// The table waits for the folder's saved sort, so it never loads by name first and then sorts again.
	const folderSort = useQuery(app_convex_api.files_folder_sorts.get_folder_sort, {
		membershipId,
		folderId: folderItemId,
	});
	// A reader's own sort, or a writer's new sort while it saves. It belongs to one folder, so opening
	// another folder shows that folder's saved sort.
	const [localSort, setLocalSort] = useState<{
		folderId: app_convex_Doc<"files_nodes">["parentId"];
		sort: files_sort_Sort;
	} | null>(null);
	const sort = (localSort?.folderId === folderItemId ? localSort.sort : null) ?? folderSort?.sort ?? null;
	const sortedChildren = useFilesSortedChildren({ membershipId, folderId: folderItemId, sort });
	const isFolderFailed = folderSort === null || sortedChildren.isFailed;
	// A table row can be on a page the tree store has not loaded, so the move checks read both lists.
	const savedNodesList = [
		...(fileNodesList ?? []),
		...(sortedChildren.rows ?? []).flatMap((row) =>
			row.treeRow && !fileNodesList?.some((node) => node._id === row.treeRow?._id) ? [row.treeRow] : [],
		),
	];
	const folderReadme = useQuery(app_convex_api.files_nodes.get_folder_readme, { membershipId, folderId: folderItemId });

	const canWriteFolder = useQuery(app_convex_api.files_nodes.get_current_user_file_write_permission, {
		membershipId,
		nodeId: folderItemId,
	});
	// The archive answer is not part of the write permission. The create doors refuse an archived parent.
	const folderNode = savedNodesList.find((node) => node._id === folderItemId);
	const folderCanReceiveChildren =
		canWriteFolder === true && (folderItemId === files_ROOT_ID || folderNode?.archiveOperationId === null);

	// Moving a child out of a restricted folder needs Can manage on its source scope.
	// Keep manual `useMemo` in this group. Convex `useQueries` re-subscribes with a
	// render-phase setState whenever the queries object identity changes, and the React
	// Compiler leaves these hook arguments unmemoized (checked in the served compiled
	// output), so an inline object loops the render until React throws.
	// `restrictedScopeNodeIds` is memoized too because the query objects depend on its identity. The
	// table rows are new objects on every render, so memoize on the ids as text.
	const restrictedScopeNodeIdsText = JSON.stringify([
		...new Set(savedNodesList.flatMap((node) => (node.restrictedScopeNodeId ? [node.restrictedScopeNodeId] : []))),
	]);
	const restrictedScopeNodeIds = useMemo(
		() => JSON.parse(restrictedScopeNodeIdsText) as app_convex_Id<"files_nodes">[],
		[restrictedScopeNodeIdsText],
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

	// The hook already sorts folders first, in the folder's sort. Pages that load later add rows at the end.
	const childItems = sortedChildren.rows ?? [];
	const visibleChildItems = showAllItems
		? childItems
		: childItems.slice(0, FILE_NODE_VIEW_FOLDER_INITIAL_VISIBLE_ITEMS_COUNT);
	const hiddenChildItemsCount = childItems.length - visibleChildItems.length;
	const readmeNodeId = folderReadme?._id ?? null;
	const editorOptions =
		folderReadme && files_node_has_editable_text_content(folderReadme)
			? get_editor_view_options(folderReadme.textKind)
			: [];

	const handleViewChange = useFn((value: string) => {
		const editorOption = editorOptions.find((option) => option.value === value);
		if (editorOption) {
			onEditorModeChange(editorOption.value);
		}
	});

	const handleShowMoreClick = useFn(() => {
		setShowAllItems(true);
		// Every loaded row is already on screen, so ask the server for the next page.
		if (hiddenChildItemsCount === 0) {
			sortedChildren.loadMore();
		}
	});

	// A writer saves the sort for everyone and sees it at once. A reader sorts only their own view.
	const handleSortChange = useFn((nextSort: files_sort_Sort) => {
		setLocalSort({ folderId: folderItemId, sort: nextSort });
		if (!folderSort?.canSave) {
			return;
		}

		convex
			.mutation(app_convex_api.files_folder_sorts.set_folder_sort, {
				membershipId,
				folderId: folderItemId,
				sort: nextSort,
			})
			.then((result) => {
				if (result._nay) {
					console.error("[FileNodeViewFolder.handleSortChange] Failed to save the folder sort", {
						result,
						folderItemId,
					});
					toast.error("The sort could not be saved. Try again.");
				}
			})
			.catch((error) => {
				console.error("[FileNodeViewFolder.handleSortChange] Error saving the folder sort", {
					error,
					folderItemId,
				});
				toast.error("The sort could not be saved. Try again.");
			})
			// Follow the saved sort again once this save is done, unless a newer sort was chosen meanwhile.
			// Convex updates the saved sort query before the mutation promise resolves.
			.finally(() => setLocalSort((current) => (current?.sort === nextSort ? null : current)));
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

	/** The node the Archive dialog is about, or `null` while it is closed. */
	const [archiveNode, setArchiveNode] = useState<FilesArchiveModal_Node | null>(null);
	const archiveReturnFocusRef = useRef<HTMLElement | null>(null);

	const handleArchiveNode = useFn<FileNodeViewFolderExplorer_Props["onArchiveNode"]>((node, returnFocusElement) => {
		archiveReturnFocusRef.current = returnFocusElement;
		setArchiveNode({ _id: node._id, name: node.name, kind: node.kind });
	});

	const handleArchiveModalClose = useFn(() => {
		setArchiveNode(null);
	});

	// The archived row leaves through the live tree query, so there is nothing else to do here.
	const handleArchived = useFn(() => {
		setArchiveNode(null);
	});

	const handleCanMoveFileNodeToParent = useFn(
		(args: { fileNodeId: app_convex_Id<"files_nodes">; targetParentId: app_convex_Doc<"files_nodes">["parentId"] }) => {
			const sourceNode = savedNodesList.find((node) => node._id === args.fileNodeId);
			const targetNode = savedNodesList.find((node) => node._id === args.targetParentId);

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
				fileNodesList: savedNodesList,
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
			) : sortedChildren.rows === undefined ? (
				<p role="status">Loading folder…</p>
			) : null}
			<FileNodeViewFolderExplorer
				visibleChildItems={visibleChildItems}
				hasMoreChildItems={hiddenChildItemsCount > 0 || (sortedChildren.rows !== undefined && !sortedChildren.isDone)}
				sort={sort ?? files_sort_DEFAULT}
				rowsSort={sortedChildren.rowsSort ?? sort ?? files_sort_DEFAULT}
				canSaveSort={folderSort?.canSave === true}
				isSortBusy={sortedChildren.isBusy}
				tooManyShared={sortedChildren.tooManyShared}
				tooManyPending={sortedChildren.tooManyPending}
				onSortChange={handleSortChange}
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
				isReadmeLoading={folderReadme === undefined}
				canWrite={folderCanReceiveChildren}
				isCreatingReadme={isCreatingReadme}
				onCreateReadmeClick={handleCreateReadmeClick}
			/>
		</FileNodeViewFolderBody>
	);

	const readmeEditor = readmeNodeId ? (
		<FileNodeViewFolderReadmeEditor
			readmeNodeId={readmeNodeId}
			writeBlockedReason={folderReadme?.writeBlockedReason ?? null}
			pendingUpdateId={pendingUpdateId}
			// The README node owns its shape: a README.md created by copying a plain text file is
			// plain text, and the embed must open it the same way the file view does.
			rootKind={folderReadme?.textKind ?? "rich_text"}
			monacoLanguageId={files_monaco_language_id_of_content_type(folderReadme?.contentType)}
			nonCollaborative={folderReadme?.collaborationEnabled === false}
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
			<FilesArchiveModal
				nodes={archiveNode ? [archiveNode] : null}
				returnFocusRef={archiveReturnFocusRef}
				onClose={handleArchiveModalClose}
				onArchived={handleArchived}
			/>
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
	folderItemId: app_convex_Doc<"files_nodes">["parentId"];
	onCreateNode: (kind: app_convex_Doc<"files_nodes">["kind"]) => void;
};

const FileNodeViewToolbarFolderActions = memo(function FileNodeViewToolbarFolderActions(
	props: FileNodeViewToolbarFolderActions_Props,
) {
	const { disabled, folderItemId, onCreateNode } = props;
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
			folderItemId={folderItemId}
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
	| "FileNodeViewFolderExplorer-cell-sort-value"
	| "FileNodeViewFolderExplorer-cell-actions"
	| "FileNodeViewFolderExplorer-link"
	| "FileNodeViewFolderExplorer-icon"
	| "FileNodeViewFolderExplorer-read-only"
	| "FileNodeViewFolderExplorer-updated-by"
	| "FileNodeViewFolderExplorer-more-action";

type FileNodeViewFolderExplorerRow_Props = {
	child: files_VisibleTreeNode;
	visibleName: string;
	/**
	 * The text of the sorted field's column, or null when the table has no such column.
	 */
	sortValueLabel: string | null;
	hasVisibleProtectedDescendant: boolean;
	canPasteIntoFolder: boolean;
	organizationName: string;
	workspaceName: string;
	isPendingAction: boolean;
	canMoveFileNodeToParent: (args: {
		fileNodeId: app_convex_Id<"files_nodes">;
		targetParentId: app_convex_Doc<"files_nodes">["parentId"];
	}) => boolean;
	/** The row hands over its node and its menu button, so the dialog can give focus back to it. */
	onArchiveNode: (node: files_VisibleTreeNode, returnFocusElement: HTMLElement | null) => void;
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
		sortValueLabel,
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

	const moreActionsRef = useRef<HTMLButtonElement>(null);

	const handleArchiveClick = useFn(() => {
		if (capabilities.canArchiveOrRestore) {
			onArchiveNode(child, moreActionsRef.current);
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
			{sortValueLabel !== null && (
				<MyGridTableCell
					className={cn(
						"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
						"FileNodeViewFolderExplorer-cell-sort-value" satisfies FileNodeViewFolderExplorerRow_ClassNames,
					)}
				>
					{sortValueLabel}
				</MyGridTableCell>
			)}
			<MyGridTableCell
				className={cn(
					"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
					"FileNodeViewFolderExplorer-cell-actions" satisfies FileNodeViewFolderExplorerRow_ClassNames,
				)}
			>
				<MyMenu placement="bottom-end">
					<MyMenuTrigger>
						<MyIconButton
							ref={moreActionsRef}
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

// #region folder explorer sort select
type FileNodeViewFolderExplorerSortSelect_ClassNames =
	| "FileNodeViewFolderExplorerSortSelect"
	| "FileNodeViewFolderExplorerSortSelect-trigger"
	| "FileNodeViewFolderExplorerSortSelect-popover"
	| "FileNodeViewFolderExplorerSortSelect-note"
	| "FileNodeViewFolderExplorerSortSelect-search"
	| "FileNodeViewFolderExplorerSortSelect-item"
	| "FileNodeViewFolderExplorerSortSelect-empty";

const FILE_NODE_VIEW_FOLDER_SORT_BUILT_IN_LABELS = {
	name: "Name",
	updated: "Updated",
	created: "Date created",
	type: "Type",
	size: "Size",
} satisfies Record<(typeof files_sort_BUILT_IN_FIELDS)[number], string>;

/**
 * The column name of a sort field: the built-in name, or a key without its `metadata.` or
 * `frontmatter.` prefix.
 */
function get_folder_sort_field_label(field: string) {
	if (files_sort_field_is_built_in(field)) {
		return FILE_NODE_VIEW_FOLDER_SORT_BUILT_IN_LABELS[field];
	}

	return field.startsWith(files_metadata_METADATA_FIELD_PREFIX)
		? field.slice(files_metadata_METADATA_FIELD_PREFIX.length)
		: field.slice(files_metadata_FRONTMATTER_FIELD_PREFIX.length);
}

function get_folder_sort_direction_label(sort: files_sort_Sort) {
	const [ascending, descending] =
		sort.field === "updated" || sort.field === "created"
			? ["Oldest first", "Newest first"]
			: sort.field === "size"
				? ["Smallest first", "Largest first"]
				: ["A to Z", "Z to A"];
	return sort.direction === "asc" ? ascending : descending;
}

/**
 * The direction a newly chosen field starts with: newest first for dates, largest first for size, and
 * A to Z for the rest.
 */
function get_folder_sort_first_direction(field: string): files_sort_Sort["direction"] {
	return field === "updated" || field === "created" || field === "size" ? "desc" : "asc";
}

type FileNodeViewFolderExplorerSortSelect_Props = {
	sort: files_sort_Sort;
	canSaveSort: boolean;
	onSortChange: (sort: files_sort_Sort) => void;
};

const FileNodeViewFolderExplorerSortSelect = memo(function FileNodeViewFolderExplorerSortSelect(
	props: FileNodeViewFolderExplorerSortSelect_Props,
) {
	const { sort, canSaveSort, onSortChange } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const convex = useConvex();

	const [searchText, setSearchText] = useState("");
	const [searchFields, setSearchFields] = useState<FunctionReturnType<
		typeof app_convex_api.files_metadata.list_search_fields
	> | null>(null);

	// Built-in fields first, then the metadata and frontmatter keys of the workspace.
	const options = [
		...files_sort_BUILT_IN_FIELDS.map((field) => ({
			value: field as string,
			label: FILE_NODE_VIEW_FOLDER_SORT_BUILT_IN_LABELS[field] as string,
		})),
		...(searchFields ?? []).flatMap((searchField) =>
			files_sort_field_is_valid(searchField.fieldPath) && !files_sort_field_is_built_in(searchField.fieldPath)
				? [
						{
							value: searchField.fieldPath,
							label: `${get_folder_sort_field_label(searchField.fieldPath)} (${
								searchField.fieldPath.startsWith(files_metadata_METADATA_FIELD_PREFIX) ? "metadata" : "frontmatter"
							})`,
						},
					]
				: [],
		),
	];
	const normalizedSearchText = searchText.trim().toLowerCase();
	const shownOptions = options.filter((option) => option.label.toLowerCase().includes(normalizedSearchText));
	const sortLabel = `${get_folder_sort_field_label(sort.field)}, ${get_folder_sort_direction_label(sort)}`;
	const otherDirectionLabel = get_folder_sort_direction_label({
		field: sort.field,
		direction: sort.direction === "asc" ? "desc" : "asc",
	});

	// Read the key list once per open instead of subscribing to it, like the search box does. A
	// subscription would walk every key again after each metadata write in the workspace.
	const handleOpenChange = useFn((open: boolean) => {
		if (!open) {
			setSearchText("");
			return;
		}

		convex
			.query(app_convex_api.files_metadata.list_search_fields, { membershipId })
			.then(setSearchFields)
			.catch((error: unknown) => {
				console.error("[FileNodeViewFolderExplorerSortSelect.handleOpenChange] Failed to load the sort keys", {
					error,
					membershipId,
				});
			});
	});

	const handleValueChange = useFn((field: string) => {
		if (field !== sort.field) {
			onSortChange({ field, direction: get_folder_sort_first_direction(field) });
		}
	});

	const handleDirectionClick = useFn(() => {
		onSortChange({ field: sort.field, direction: sort.direction === "asc" ? "desc" : "asc" });
	});

	return (
		<div className={"FileNodeViewFolderExplorerSortSelect" satisfies FileNodeViewFolderExplorerSortSelect_ClassNames}>
			<MySearchSelect value={sort.field} setValue={handleValueChange} setOpen={handleOpenChange} setValueOnMove={false}>
				<MySearchSelectTrigger aria-label={`Sort: ${sortLabel}`} moveOnKeyDown={false} typeahead={false}>
					<MyButton
						type="button"
						variant="outline"
						className={cn(
							"FileNodeViewFolderExplorerSortSelect-trigger" satisfies FileNodeViewFolderExplorerSortSelect_ClassNames,
							"FileNodeViewViewSelect-trigger" satisfies FileNodeViewViewSelect_ClassNames,
						)}
					>
						<span>Sort: {sortLabel}</span>
					</MyButton>
				</MySearchSelectTrigger>
				<MySearchSelectPopover
					aria-label="Sort fields"
					className={cn(
						"FileNodeViewFolderExplorerSortSelect-popover" satisfies FileNodeViewFolderExplorerSortSelect_ClassNames,
						"FileNodeViewViewSelect-popover" satisfies FileNodeViewViewSelect_ClassNames,
					)}
				>
					<MySearchSelectPopoverScrollableArea>
						<MySearchSelectPopoverContent>
							{!canSaveSort && (
								<p
									className={
										"FileNodeViewFolderExplorerSortSelect-note" satisfies FileNodeViewFolderExplorerSortSelect_ClassNames
									}
								>
									Only people who can edit this folder can save its sort.
								</p>
							)}
							<MySearchSelectSearch
								className={cn(
									"FileNodeViewFolderExplorerSortSelect-search" satisfies FileNodeViewFolderExplorerSortSelect_ClassNames,
									"FileNodeViewViewSelect-search" satisfies FileNodeViewViewSelect_ClassNames,
								)}
								aria-label="Search sort fields"
								placeholder="Search fields"
								value={searchText}
								onChange={(event) => setSearchText(event.currentTarget.value)}
							/>
							<MySearchSelectList aria-label="Sort fields">
								{shownOptions.map((option) => (
									<MySearchSelectItem
										key={option.value}
										value={option.value}
										className={cn(
											"FileNodeViewFolderExplorerSortSelect-item" satisfies FileNodeViewFolderExplorerSortSelect_ClassNames,
											"FileNodeViewViewSelect-item" satisfies FileNodeViewViewSelect_ClassNames,
										)}
									>
										{option.label}
									</MySearchSelectItem>
								))}
							</MySearchSelectList>
							{shownOptions.length === 0 && (
								<div
									role="status"
									className={cn(
										"FileNodeViewFolderExplorerSortSelect-empty" satisfies FileNodeViewFolderExplorerSortSelect_ClassNames,
										"FileNodeViewViewSelect-empty" satisfies FileNodeViewViewSelect_ClassNames,
									)}
								>
									No fields found
								</div>
							)}
						</MySearchSelectPopoverContent>
					</MySearchSelectPopoverScrollableArea>
				</MySearchSelectPopover>
			</MySearchSelect>
			<MyIconButton
				variant="outline"
				tooltip={`Sort ${otherDirectionLabel.toLowerCase()}`}
				onClick={handleDirectionClick}
			>
				<MyIconButtonIcon>{sort.direction === "asc" ? <ArrowUp /> : <ArrowDown />}</MyIconButtonIcon>
			</MyIconButton>
		</div>
	);
});
// #endregion folder explorer sort select

// #region folder explorer
type FileNodeViewFolderExplorer_ClassNames =
	| "FileNodeViewFolderExplorer"
	| "FileNodeViewFolderExplorer-toolbar"
	| "FileNodeViewFolderExplorer-notice"
	| "FileNodeViewFolderExplorer-table"
	| "FileNodeViewFolderExplorer-table-has-sort-value"
	| "FileNodeViewFolderExplorer-header-row"
	| "FileNodeViewFolderExplorer-column-header"
	| "FileNodeViewFolderExplorer-column-header-name"
	| "FileNodeViewFolderExplorer-column-header-updated-by"
	| "FileNodeViewFolderExplorer-column-header-updated"
	| "FileNodeViewFolderExplorer-column-header-sort-value"
	| "FileNodeViewFolderExplorer-column-header-actions"
	| "FileNodeViewFolderExplorer-sort-button"
	| "FileNodeViewFolderExplorer-sort-icon"
	| "FileNodeViewFolderExplorer-show-more"
	| "FileNodeViewFolderExplorer-show-less"
	| "FileNodeViewFolderExplorer-show-less-cover";

type FileNodeViewFolderExplorer_CustomAttributes = {
	"data-sort-field": string;
	"data-sort-direction": files_sort_Sort["direction"];
};

/**
 * The text of the sorted field's column for one row. A row's sort key starts with the field's value,
 * so read the value from there. A row without a value shows a dash.
 */
function get_folder_explorer_sort_value_label(row: FileNodeViewFolderRow, field: string) {
	const value = row.sortKey[0];
	if (row.segment === "missing") {
		return "—";
	}
	// Folders have no size, so their key starts with the name and they show a dash here.
	if (field === "created" || field === "size") {
		return typeof value !== "number"
			? "—"
			: field === "created"
				? format_relative_time(value)
				: files_format_size(value);
	}
	if (field === "type") {
		return String(value);
	}

	return row.sortFieldValue === null ? "—" : String(row.sortFieldValue);
}

type FileNodeViewFolderExplorer_Props = {
	visibleChildItems: FileNodeViewFolderRow[];
	/** Rows are hidden behind "Show more", or the server has more pages. */
	hasMoreChildItems: boolean;
	sort: files_sort_Sort;
	/**
	 * The sort the shown rows were loaded with. While a new sort loads, the table still shows the rows
	 * of the old one, and their sort values belong to the old field.
	 */
	rowsSort: files_sort_Sort;
	canSaveSort: boolean;
	/** A new sort or a page is loading, and the rows are the last loaded ones. */
	isSortBusy: boolean;
	tooManyShared: boolean;
	tooManyPending: boolean;
	organizationName: string;
	workspaceName: string;
	pendingActionNodeIds: ReadonlySet<string>;
	protectedDescendantIds: ReadonlySet<app_convex_Id<"files_nodes">>;
	canPasteIntoFolder: boolean;
	canMoveFileNodeToParent: (args: {
		fileNodeId: app_convex_Id<"files_nodes">;
		targetParentId: app_convex_Doc<"files_nodes">["parentId"];
	}) => boolean;
	/** The row hands over its node and its menu button, so the dialog can give focus back to it. */
	onArchiveNode: (node: files_VisibleTreeNode, returnFocusElement: HTMLElement | null) => void;
	onMoveFileNodesToParent: (args: {
		fileNodeIds: app_convex_Id<"files_nodes">[];
		targetParentId: app_convex_Doc<"files_nodes">["parentId"];
	}) => void;
	onSortChange: (sort: files_sort_Sort) => void;
	onShowMoreClick: () => void;
	canShowLess: boolean;
	onShowLessClick: () => void;
};

const FileNodeViewFolderExplorer = memo(function FileNodeViewFolderExplorer(props: FileNodeViewFolderExplorer_Props) {
	const {
		visibleChildItems,
		hasMoreChildItems,
		sort,
		rowsSort,
		canSaveSort,
		isSortBusy,
		tooManyShared,
		tooManyPending,
		organizationName,
		workspaceName,
		pendingActionNodeIds,
		protectedDescendantIds,
		canPasteIntoFolder,
		canMoveFileNodeToParent,
		onArchiveNode,
		onMoveFileNodesToParent,
		onSortChange,
		onShowMoreClick,
		canShowLess,
		onShowLessClick,
	} = props;

	// Name and Updated have their own columns. Any other field gets one more column.
	const hasSortValueColumn = rowsSort.field !== "name" && rowsSort.field !== "updated";
	const getAriaSort = (field: string) =>
		sort.field !== field ? "none" : sort.direction === "asc" ? "ascending" : "descending";
	const sortIcon = (
		<MyIcon className={"FileNodeViewFolderExplorer-sort-icon" satisfies FileNodeViewFolderExplorer_ClassNames}>
			{sort.direction === "asc" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
		</MyIcon>
	);

	// A second click on the sorted column flips it. A first click starts with the field's first direction.
	const handleColumnSortClick = (field: string) => {
		onSortChange({
			field,
			direction:
				sort.field !== field ? get_folder_sort_first_direction(field) : sort.direction === "asc" ? "desc" : "asc",
		});
	};

	if (visibleChildItems.length === 0 && !hasMoreChildItems && !tooManyShared && !tooManyPending) {
		return null;
	}

	return (
		<div className={"FileNodeViewFolderExplorer" satisfies FileNodeViewFolderExplorer_ClassNames}>
			<div className={"FileNodeViewFolderExplorer-toolbar" satisfies FileNodeViewFolderExplorer_ClassNames}>
				<FileNodeViewFolderExplorerSortSelect sort={sort} canSaveSort={canSaveSort} onSortChange={onSortChange} />
			</div>
			{tooManyShared && (
				<p
					role="status"
					className={"FileNodeViewFolderExplorer-notice" satisfies FileNodeViewFolderExplorer_ClassNames}
				>
					Too many shared items here to sort. Some are not shown.
				</p>
			)}
			{tooManyPending && (
				<p
					role="status"
					className={"FileNodeViewFolderExplorer-notice" satisfies FileNodeViewFolderExplorer_ClassNames}
				>
					Too many pending changes here. Review them in the Pending panel.
				</p>
			)}
			{visibleChildItems.length > 0 && (
				<MyGridTable
					aria-label="Folder contents"
					aria-busy={isSortBusy}
					className={cn(
						"FileNodeViewFolderExplorer-table" satisfies FileNodeViewFolderExplorer_ClassNames,
						hasSortValueColumn &&
							("FileNodeViewFolderExplorer-table-has-sort-value" satisfies FileNodeViewFolderExplorer_ClassNames),
					)}
					{...({
						"data-sort-field": sort.field,
						"data-sort-direction": sort.direction,
					} satisfies FileNodeViewFolderExplorer_CustomAttributes)}
				>
					<MyGridTableHeader>
						<MyGridTableRow
							className={"FileNodeViewFolderExplorer-header-row" satisfies FileNodeViewFolderExplorer_ClassNames}
						>
							<MyGridTableColumnHeader
								className={cn(
									"FileNodeViewFolderExplorer-column-header" satisfies FileNodeViewFolderExplorer_ClassNames,
									"FileNodeViewFolderExplorer-column-header-name" satisfies FileNodeViewFolderExplorer_ClassNames,
								)}
								aria-sort={getAriaSort("name")}
							>
								<button
									type="button"
									className={"FileNodeViewFolderExplorer-sort-button" satisfies FileNodeViewFolderExplorer_ClassNames}
									onClick={() => handleColumnSortClick("name")}
								>
									Name
									{sort.field === "name" && sortIcon}
								</button>
							</MyGridTableColumnHeader>
							<MyGridTableColumnHeader
								className={cn(
									"FileNodeViewFolderExplorer-column-header" satisfies FileNodeViewFolderExplorer_ClassNames,
									"FileNodeViewFolderExplorer-column-header-updated-by" satisfies FileNodeViewFolderExplorer_ClassNames,
								)}
							>
								Updated by
							</MyGridTableColumnHeader>
							<MyGridTableColumnHeader
								className={cn(
									"FileNodeViewFolderExplorer-column-header" satisfies FileNodeViewFolderExplorer_ClassNames,
									"FileNodeViewFolderExplorer-column-header-updated" satisfies FileNodeViewFolderExplorer_ClassNames,
								)}
								aria-sort={getAriaSort("updated")}
							>
								<button
									type="button"
									className={"FileNodeViewFolderExplorer-sort-button" satisfies FileNodeViewFolderExplorer_ClassNames}
									onClick={() => handleColumnSortClick("updated")}
								>
									Updated
									{sort.field === "updated" && sortIcon}
								</button>
							</MyGridTableColumnHeader>
							{hasSortValueColumn && (
								<MyGridTableColumnHeader
									className={cn(
										"FileNodeViewFolderExplorer-column-header" satisfies FileNodeViewFolderExplorer_ClassNames,
										"FileNodeViewFolderExplorer-column-header-sort-value" satisfies FileNodeViewFolderExplorer_ClassNames,
									)}
									aria-sort={getAriaSort(rowsSort.field)}
								>
									{get_folder_sort_field_label(rowsSort.field)}
									{rowsSort.field === sort.field && sortIcon}
								</MyGridTableColumnHeader>
							)}
							<MyGridTableColumnHeader
								className={cn(
									"FileNodeViewFolderExplorer-column-header" satisfies FileNodeViewFolderExplorer_ClassNames,
									"FileNodeViewFolderExplorer-column-header-actions" satisfies FileNodeViewFolderExplorer_ClassNames,
								)}
								aria-label="Actions"
							/>
						</MyGridTableRow>
					</MyGridTableHeader>
					<MyGridTableBody>
						{visibleChildItems.map((row) => {
							const sortValueLabel = hasSortValueColumn
								? get_folder_explorer_sort_value_label(row, rowsSort.field)
								: null;
							const child = row.treeRow;
							// Only a private draft has no saved node, so it shows a reduced row without actions.
							if (!child) {
								return (
									<MyGridTableRow
										key={`${row.target.kind}:${row.target.id}`}
										className={"FileNodeViewFolderExplorer-row" satisfies FileNodeViewFolderExplorerRow_ClassNames}
									>
										<MyGridTableCell
											className={cn(
												"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
												"FileNodeViewFolderExplorer-cell-name" satisfies FileNodeViewFolderExplorerRow_ClassNames,
											)}
										>
											<Link
												aria-label={`Open ${row.name}`}
												className={
													"FileNodeViewFolderExplorer-row-action" satisfies FileNodeViewFolderExplorerRow_ClassNames
												}
												to="/w/$organizationName/$workspaceName/files"
												params={{ organizationName, workspaceName }}
												search={(prev) => ({
													...prev,
													nodeId: row.target.kind === "saved" ? row.target.id : undefined,
													pendingNodeId: row.target.kind === "private" ? row.target.id : undefined,
													view: undefined,
												})}
											/>
											<MyIcon
												className={"FileNodeViewFolderExplorer-icon" satisfies FileNodeViewFolderExplorerRow_ClassNames}
											>
												{row.kind === "folder" ? <Folder /> : <FileText />}
											</MyIcon>
											<span
												className={"FileNodeViewFolderExplorer-link" satisfies FileNodeViewFolderExplorerRow_ClassNames}
											>
												{row.name}
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
												{row.updatedBy || "Unknown"}
											</span>
										</MyGridTableCell>
										<MyGridTableCell
											className={cn(
												"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
												"FileNodeViewFolderExplorer-cell-updated" satisfies FileNodeViewFolderExplorerRow_ClassNames,
											)}
										>
											{format_relative_time(row.updatedAt)}
										</MyGridTableCell>
										{sortValueLabel !== null && (
											<MyGridTableCell
												className={cn(
													"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
													"FileNodeViewFolderExplorer-cell-sort-value" satisfies FileNodeViewFolderExplorerRow_ClassNames,
												)}
											>
												{sortValueLabel}
											</MyGridTableCell>
										)}
										<MyGridTableCell
											className={cn(
												"FileNodeViewFolderExplorer-cell" satisfies FileNodeViewFolderExplorerRow_ClassNames,
												"FileNodeViewFolderExplorer-cell-actions" satisfies FileNodeViewFolderExplorerRow_ClassNames,
											)}
										>
											{row.preparing ? "Preparing…" : "Added"}
										</MyGridTableCell>
									</MyGridTableRow>
								);
							}
							const isPendingAction = pendingActionNodeIds.has(child._id);

							return (
								<FileNodeViewFolderExplorerRow
									key={child._id}
									child={child}
									visibleName={row.name}
									sortValueLabel={sortValueLabel}
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

			{hasMoreChildItems && (
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
	isReadmeLoading: boolean;
	canWrite: boolean;
	isCreatingReadme: boolean;
	onCreateReadmeClick: () => void;
};

const FileNodeViewFolderReadme = memo(function FileNodeViewFolderReadme(props: FileNodeViewFolderReadme_Props) {
	const { readmeNodeId, isReadmeLoading, canWrite, isCreatingReadme, onCreateReadmeClick } = props;

	return (
		<section className={"FileNodeViewFolderReadme" satisfies FileNodeViewFolderReadme_ClassNames}>
			{readmeNodeId ? (
				<div className={"FileNodeViewFolderReadme-header" satisfies FileNodeViewFolderReadme_ClassNames}>
					<MyIcon className={"FileNodeViewFolderReadme-icon" satisfies FileNodeViewFolderReadme_ClassNames}>
						<BookOpen />
					</MyIcon>
					<h2 className={"FileNodeViewFolderReadme-title" satisfies FileNodeViewFolderReadme_ClassNames}>README.md</h2>
				</div>
			) : isReadmeLoading ? (
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
	// A web browser does not belong to any file, so selection changes never end it.
	useEffect(() => {
		if (
			(!searchNodeId && !searchPrivateNodeId) ||
			!browserSession ||
			browserSession.mode !== "file" ||
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

	// Leaving a browser view ends its file session: the file browser is only a view, never
	// background. A web browser lives on its own page, so this never ends it.
	useEffect(() => {
		if (
			!browserSession ||
			browserSession.mode !== "file" ||
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

	const queriedNode = useQuery(
		app_convex_api.files_nodes.get_file_node_for_membership,
		searchNodeId && !isRootNodeSelected
			? {
					membershipId,
					fileNodeId: searchNodeId,
				}
			: "skip",
	);
	const selectedTargetView = useQuery(
		app_convex_api.files_pending_updates.get_file_pending_target,
		searchPrivateNodeId
			? { membershipId, target: { kind: "private", id: searchPrivateNodeId } }
			: searchNodeId && !isRootNodeSelected
				? { membershipId, target: { kind: "saved", id: searchNodeId } }
				: "skip",
	);
	const privateTargetView = searchPrivateNodeId ? selectedTargetView : undefined;
	const privateEntry = privateTargetView?.entry.kind === "private" ? privateTargetView.entry : null;
	const privateSourceKey = privateEntry
		? `${membershipId}:private:${privateEntry.node._id}:${privateEntry.node.userId}:${privateEntry.node.creationGeneration}`
		: null;
	const privateTextIntent =
		privateEntry?.pendingUpdate.createIntent?.kind === "text" ? privateEntry.pendingUpdate.createIntent : null;
	// Keep the last shown folder loaded while the next node's query starts. A row of the folder table is
	// then still in the loaded rows, and the view below can open it before its query answers.
	const [loadedFolderId, setLoadedFolderId] = useState<app_convex_Id<"files_nodes"> | null>(null);
	const nextLoadedFolderId =
		queriedNode === undefined ? loadedFolderId : queriedNode?.kind === "folder" ? queriedNode._id : null;
	if (nextLoadedFolderId !== loadedFolderId) {
		setLoadedFolderId(nextLoadedFolderId);
	}

	// Load the shown folder's rows, and the selected node with the folders above it for the breadcrumb.
	// The whole workspace can hold many thousands of nodes, so never load all of them here.
	const fileNodesList = FilesTreeProvider.useFolders({
		folderIds: loadedFolderId && !isRootNodeSelected ? [loadedFolderId] : [],
		archived: false,
		pinnedNodeIds: searchNodeId && !isRootNodeSelected ? [searchNodeId] : [],
	}).rows;

	// Show the loaded tree node while the query starts. A null answer must still clear the view.
	const resolvedNode =
		queriedNode === undefined ? fileNodesList?.find((item) => item._id === searchNodeId) : queriedNode;
	const resolvedNodeId = isRootNodeSelected ? files_ROOT_ID : (resolvedNode?._id ?? null);
	// Keep create actions scoped to the visible folder/root selection; file views use this toolbar only for editor actions.
	const targetFolderId = isRootNodeSelected ? files_ROOT_ID : resolvedNode?.kind === "folder" ? resolvedNode._id : null;
	const resolvedNodeHasEditableTextContent = files_node_has_editable_text_content(resolvedNode);

	// Only the rows on screen can show the protected mark. The archive door still refuses the rest.
	const protectedDescendantIds = useMemo(
		() => files_collect_protected_descendant_ids(fileNodesList ?? []),
		[fileNodesList],
	);
	const folderReadme = useQuery(
		app_convex_api.files_nodes.get_folder_readme,
		targetFolderId ? { membershipId, folderId: targetFolderId } : "skip",
	);

	// Treat a folder README as the active editor node so pending-update and sync subscriptions
	// have the same owner for selected files and folder README editors.
	const activeEditorNodeId =
		resolvedNode && resolvedNode.kind === "file"
			? resolvedNodeHasEditableTextContent
				? resolvedNode._id
				: null
			: targetFolderId
				? (folderReadme?._id ?? null)
				: null;
	const activeEditorNode =
		resolvedNode?.kind === "file" && resolvedNodeHasEditableTextContent ? resolvedNode : (folderReadme ?? undefined);
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

	// The list query pages a convex-helpers stream. Only the convex-helpers hook pins where each
	// loaded page ends, so a proposal added or removed later cannot skip or repeat a row.
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

	useEffect(() => {
		// A chat link may still name the private node after Save. Switch the editor to its saved target.
		// The query answers with the saved file the draft became: a publish receipt links the two ids.
		if (searchPrivateNodeId && privateTargetView?.entry.kind === "saved") {
			handleEditorTargetChange(
				`${membershipId}:private:${searchPrivateNodeId}`,
				{ kind: "saved", id: privateTargetView.entry.node._id },
				{ keepReview: false },
			);
		}
	}, [membershipId, searchPrivateNodeId, privateTargetView, handleEditorTargetChange]);

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

	// Set when a reveal arrives while the sidebar panel is closed. The panel unmounts while closed
	// (`closeBehavior="unmount"`), so the sidebar's listener was not there to hear that event.
	const pendingRevealNodeIdRef = useRef<app_convex_Id<"files_nodes"> | null>(null);

	useGlobalCustomEvent("files::reveal_node", (event) => {
		if (event.detail.membershipId !== membershipId) return;
		// A search hides rows. Clear it through the route, the same path the search box uses, so the
		// URL, the box and the tree agree. `handleSearchQueryChange` is a no-op when `q` is already gone.
		handleSearchQueryChange("");
		if (!filesSidebarOpen) {
			pendingRevealNodeIdRef.current = event.detail.nodeId;
			setFilesSidebarOpen(true);
		}
	});

	useEffect(() => {
		if (!filesSidebarOpen || !pendingRevealNodeIdRef.current) return;
		// React runs a child's effects before its parent's in the same commit, and the panel mounts
		// its children in the commit that opens it. So the sidebar's listener is registered by the
		// time this runs, and sending the event again reaches it.
		global_custom_event_dispatch("files::reveal_node", { membershipId, nodeId: pendingRevealNodeIdRef.current });
		pendingRevealNodeIdRef.current = null;
	}, [filesSidebarOpen, membershipId]);

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

	// A draft under an archived folder is read-only because of the archive, not because of permissions.
	const readOnlyMessage = privateEntry
		? privateTargetView?.recovery
			? "Restore the archived folder before saving this draft."
			: privateTargetView?.canEdit === false
				? "You don't have permission to save this draft here."
				: null
		: resolvedNode
			? resolvedNode.kind === "folder" && resolvedNode.archiveOperationId !== null
				? "This folder is archived. Restore it before adding items."
				: !resolvedNode.canWrite
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
				selectedFileView === "browser" || selectedFileView === "code_browser" || selectedFileView === "review_browser"
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
				// A saved entry here means the draft was already saved. The effect above is navigating to
				// the saved file, so say that instead of telling the user the draft is gone.
				<div className={"FileNodeView-loading-text" satisfies FileNodeView_ClassNames} role="status">
					{privateTargetView === undefined
						? "Loading draft…"
						: privateTargetView?.entry.kind === "saved"
							? "Opening saved file…"
							: "This draft is no longer available."}
				</div>
			);
		}

		return resolvedNodeId ? (
			<>
				<FilePendingNotice copyDestination={selectedTargetView?.copyDestination} />
				<FileNodeViewContent
					key={membershipId}
					selectedFileView={selectedFileView}
					selectedNodeId={searchNodeId}
					node={resolvedNode}
					fileNodesList={fileNodesList}
					protectedDescendantIds={protectedDescendantIds}
					pendingUpdateId={currentPendingUpdate?._id}
					committedAssetId={
						activeEditorNode?.collaborationEnabled === false ? (activeEditorNode.assetId ?? null) : null
					}
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
			</>
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
				{/* `FileNodeViewPrivateActions` looks this area up by class name and moves focus here when
				    Save or Discard removes its buttons. `tabIndex={-1}` lets script focus it without
				    adding it to the tab order, and the label tells a screen reader where focus landed. */}
				<div
					tabIndex={-1}
					aria-label="File content"
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
