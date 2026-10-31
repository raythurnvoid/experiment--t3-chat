import "./files-sidebar-archive.css";

import { memo, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, type UsePaginatedQueryResult } from "convex/react";
import { compareValues } from "convex/values";
import { ArchiveRestore, ArrowLeft, EllipsisVertical, FileText, Folder, Lock, Route, Trash2 } from "lucide-react";

import { FilesPurgeModal, type FilesPurgeModal_Request } from "./files-purge-modal.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import {
	MyContextMenu,
	MyContextMenuButtonTrigger,
	MyContextMenuPopover,
	MyContextMenuTrigger,
} from "@/components/my-context-menu.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import {
	MyMenuItem,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	MyMenuItemContentSecondary,
	MyMenuItemsGroup,
	MyMenuPopoverContent,
} from "@/components/my-menu.tsx";
import {
	MySelect,
	MySelectItem,
	MySelectItemContent,
	MySelectItemContentPrimary,
	MySelectItemContentSecondary,
	MySelectItemIndicator,
	MySelectOpenIndicator,
	MySelectPopover,
	MySelectPopoverContent,
	MySelectPopoverScrollableArea,
	MySelectTrigger,
} from "@/components/my-select.tsx";
import { useFilesPaginatedQuery } from "@/hooks/files-paginated-query-hooks.ts";
import { useFilesSavedView } from "@/hooks/files-saved-view-hooks.ts";
import { files_merge_sorted_streams } from "@/hooks/files-search-hooks.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_FunctionReturnType, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { format_time } from "@/lib/date.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import {
	files_archive_operation_id_time,
	files_derive_tree_path_for_file_node,
	type files_SavedStream,
} from "@/lib/files.ts";
import { path_name_of } from "@/lib/paths.ts";
import { cn, copy_to_clipboard } from "@/lib/utils.ts";

const FilesSidebarArchive_PAGE_SIZE = 50;

/**
 * Archive operation ids hold their time since this day. An older id is a plain UUID with no time.
 */
const FilesSidebarArchive_TIME_IDS_SINCE = "Oct 31, 2026";

type FilesSidebarArchive_AreaRow = app_convex_FunctionReturnType<
	typeof app_convex_api.files_tree.list_archive_areas
>["page"][number];

type FilesSidebarArchive_TopRow = app_convex_FunctionReturnType<
	typeof app_convex_api.files_tree.list_archived_tops
>["page"][number];

/**
 * The open part of the workspace (null), or one restricted folder the person can open.
 */
type FilesSidebarArchive_Area = { id: app_convex_Id<"files_nodes">; path: string } | null;

/**
 * Merge the pages of one list's streams in the server order, like the "Shared with you" group. A row
 * that two streams hold shows once. Show more loads the stream that holds the merge back.
 */
function merge_streams<Row extends { _id: string }>(args: {
	streams: Array<UsePaginatedQueryResult<Row>>;
	isViewLoading: boolean;
	compare: (a: Row, b: Row) => number;
}) {
	const { streams, isViewLoading, compare } = args;
	const merge = files_merge_sorted_streams({
		streams: streams.map((stream) => ({ rows: stream.results, isDone: stream.status === "Exhausted" })),
		compare,
		key: (row) => row._id,
	});
	return {
		rows: merge.rows,
		status:
			isViewLoading || streams.some((stream) => stream.status === "LoadingFirstPage")
				? ("loading" as const)
				: streams.some((stream) => stream.status === "LoadingMore")
					? ("loading_more" as const)
					: merge.blockingRank === null
						? ("done" as const)
						: ("more" as const),
		loadMore: () => {
			if (merge.blockingRank !== null) {
				streams[merge.blockingRank]!.loadMore(FilesSidebarArchive_PAGE_SIZE);
			}
		},
	};
}

// #region row
type FilesSidebarArchiveRow_ClassNames =
	| "FilesSidebarArchiveRow"
	| "FilesSidebarArchiveRow-locked"
	| "FilesSidebarArchiveRow-primary"
	| "FilesSidebarArchiveRow-text"
	| "FilesSidebarArchiveRow-name"
	| "FilesSidebarArchiveRow-details"
	| "FilesSidebarArchiveRow-actions";

type FilesSidebarArchiveRow_CustomAttributes = {
	"data-archive-row-id": string;
};

type FilesSidebarArchiveRow_Props = {
	row: FilesSidebarArchive_TopRow;
	isCurrent: boolean;
	/**
	 * Whether the person has Can manage on the shown area.
	 */
	canManageArea: boolean;
	onOpen: (nodeId: string, kind: string) => void;
	onRestore: (nodeId: string) => void;
	onDelete: (row: FilesSidebarArchive_TopRow, returnFocusElement: HTMLElement | null) => void;
};

/**
 * One archived top item. A locked row is an item in this area that the person cannot open: it shows
 * only its name and dates, and its menu only copies its path.
 */
const FilesSidebarArchiveRow = memo(function FilesSidebarArchiveRow(props: FilesSidebarArchiveRow_Props) {
	const { row, isCurrent, canManageArea, onOpen, onRestore, onDelete } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const menuButtonRef = useRef<HTMLButtonElement | null>(null);

	// Convex shares one subscription between the rows that ask for the same person or folder.
	const updatedBy = useQuery(app_convex_api.users.get_anagraphic, row.locked ? "skip" : { userId: row.updatedBy });
	const updatedByName = updatedBy?.displayName.trim() || null;
	// A restricted folder listed here is its own area, so deleting it needs Can manage on itself.
	const isRestrictedRoot = !row.locked && row.restrictedScopeNodeId === row._id;
	const ownShareState = useQuery(
		app_convex_api.files_sharing.get_node_share_state,
		isRestrictedRoot ? { membershipId, nodeId: row._id } : "skip",
	);
	const canDelete = !row.locked && (isRestrictedRoot ? ownShareState?.canManage === true : canManageArea);
	const canRestore = !row.locked && row.canWrite;

	const parentPath = row.path.slice(0, row.path.lastIndexOf("/")) || "/";
	const archivedAt = files_archive_operation_id_time(row.archiveOperationId ?? "");
	const details = [
		parentPath,
		archivedAt === null
			? `Archived before ${FilesSidebarArchive_TIME_IDS_SINCE}`
			: `Archived ${format_time(archivedAt)}`,
		...(updatedByName ? [`Changed by ${updatedByName}`] : []),
	].join(" · ");

	const handleOpenClick = useFn(() => {
		onOpen(row._id, row.kind);
	});

	const handleRestoreClick = useFn(() => {
		onRestore(row._id);
	});

	const handleDeleteClick = useFn(() => {
		onDelete(row, menuButtonRef.current);
	});

	const handleCopyPathClick = useFn(() => {
		copy_to_clipboard({ text: row.path }).catch((error) => {
			console.error("[FilesSidebarArchiveRow.handleCopyPathClick] Failed to copy path", { error, nodeId: row._id });
		});
	});

	const icon = row.locked ? <Lock /> : row.kind === "folder" ? <Folder /> : <FileText />;
	const text = (
		<span className={"FilesSidebarArchiveRow-text" satisfies FilesSidebarArchiveRow_ClassNames}>
			<span className={"FilesSidebarArchiveRow-name" satisfies FilesSidebarArchiveRow_ClassNames}>{row.name}</span>
			<span className={"FilesSidebarArchiveRow-details" satisfies FilesSidebarArchiveRow_ClassNames}>{details}</span>
		</span>
	);

	return (
		<li
			className={cn(
				"FilesSidebarArchiveRow" satisfies FilesSidebarArchiveRow_ClassNames,
				row.locked && ("FilesSidebarArchiveRow-locked" satisfies FilesSidebarArchiveRow_ClassNames),
			)}
		>
			<MyContextMenu placement="bottom-end">
				{/* A locked row still opens, like a locked search match: the file view says "Permission denied". */}
				<MyContextMenuTrigger>
					<MyButton
						type="button"
						variant="ghost-highlightable"
						className={"FilesSidebarArchiveRow-primary" satisfies FilesSidebarArchiveRow_ClassNames}
						aria-label={`${row.name} in ${parentPath}${row.locked ? ", you don't have access" : ""}`}
						title={row.locked ? "You don't have access" : undefined}
						aria-current={isCurrent ? "page" : undefined}
						{...({ "data-archive-row-id": row._id } satisfies FilesSidebarArchiveRow_CustomAttributes)}
						onClick={handleOpenClick}
					>
						<MyButtonIcon aria-hidden>{icon}</MyButtonIcon>
						{text}
					</MyButton>
				</MyContextMenuTrigger>
				<MyContextMenuButtonTrigger>
					<MyIconButton
						ref={menuButtonRef}
						className={"FilesSidebarArchiveRow-actions" satisfies FilesSidebarArchiveRow_ClassNames}
						variant="ghost-highlightable"
						tooltip="More actions"
						aria-label={`More actions for ${row.name}`}
					>
						<MyIconButtonIcon>
							<EllipsisVertical />
						</MyIconButtonIcon>
					</MyIconButton>
				</MyContextMenuButtonTrigger>
				<MyContextMenuPopover unmountOnHide>
					<MyMenuPopoverContent>
						{row.locked ? null : (
							<MyMenuItemsGroup>
								<MyMenuItem disabled={!canRestore} hideOnClick onClick={handleRestoreClick}>
									<MyMenuItemContent>
										<MyMenuItemContentIcon>
											<ArchiveRestore />
										</MyMenuItemContentIcon>
										<MyMenuItemContentPrimary>Restore</MyMenuItemContentPrimary>
										{/* Restore brings back the item's whole archive operation. */}
										<MyMenuItemContentSecondary>With everything archived together with it</MyMenuItemContentSecondary>
									</MyMenuItemContent>
								</MyMenuItem>
								<MyMenuItem variant="destructive" disabled={!canDelete} hideOnClick onClick={handleDeleteClick}>
									<MyMenuItemContent>
										<MyMenuItemContentIcon>
											<Trash2 />
										</MyMenuItemContentIcon>
										<MyMenuItemContentPrimary>Delete permanently…</MyMenuItemContentPrimary>
									</MyMenuItemContent>
								</MyMenuItem>
							</MyMenuItemsGroup>
						)}
						<MyMenuItemsGroup separator={!row.locked}>
							<MyMenuItem hideOnClick onClick={handleCopyPathClick}>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>
										<Route />
									</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>Copy path</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
						</MyMenuItemsGroup>
					</MyMenuPopoverContent>
				</MyContextMenuPopover>
			</MyContextMenu>
		</li>
	);
});
// #endregion row

// #region root
type FilesSidebarArchive_ClassNames =
	| "FilesSidebarArchive"
	| "FilesSidebarArchive-header"
	| "FilesSidebarArchive-title-row"
	| "FilesSidebarArchive-title"
	| "FilesSidebarArchive-toolbar"
	| "FilesSidebarArchive-area-trigger"
	| "FilesSidebarArchive-area-trigger-label"
	| "FilesSidebarArchive-content"
	| "FilesSidebarArchive-state"
	| "FilesSidebarArchive-list"
	| "FilesSidebarArchive-more";

type FilesSidebarArchive_Props = {
	selectedNodeId: string | null;
	onOpen: (nodeId: string, kind: string) => void;
	onRestore: (nodeId: string) => void;
	/**
	 * The server took a Delete permanently of these items. It may still run as a background job.
	 */
	onDeleted: (nodeIds: string[]) => void;
	onExit: () => void;
};

/**
 * The Archive view: the archived top items of one area, newest first, in place of the tree. An area
 * is the open part of the workspace or one restricted folder the person can open, like one Trash per
 * shared drive in Google Drive. Escape, when no menu or dialog is open, goes back to the files.
 */
export const FilesSidebarArchive = memo(function FilesSidebarArchive(props: FilesSidebarArchive_Props) {
	const { selectedNodeId, onOpen, onRestore, onDeleted, onExit } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const view = useFilesSavedView(membershipId);
	const rootRef = useRef<HTMLElement | null>(null);
	const backButtonRef = useRef<HTMLButtonElement | null>(null);
	const emptyButtonRef = useRef<HTMLButtonElement | null>(null);
	const purgeReturnFocusRef = useRef<HTMLElement | null>(null);
	/**
	 * Set when a delete was sent. The effect that runs after the dialog closes focuses it and clears it.
	 */
	const focusAfterPurgeRef = useRef<HTMLElement | null>(null);

	const titleId = useId();

	const [chosenArea, setChosenArea] = useState<FilesSidebarArchive_Area>(null);
	const [purgeRequest, setPurgeRequest] = useState<FilesPurgeModal_Request | null>(null);
	// The row ids when Show more was clicked, until its page has loaded.
	const [loadMoreFromIds, setLoadMoreFromIds] = useState<Set<string> | null>(null);

	// The areas: one stream per principal (the member, two roles, everyone), each in the normal and the
	// Move saved stream, like the "Shared with you" group.
	const areaArgs = (principalIndex: 0 | 1 | 2 | 3, savedStream: files_SavedStream | null) =>
		savedStream ? { membershipId, savedStream, principalIndex } : ("skip" as const);
	const areaOptions = { initialNumItems: FilesSidebarArchive_PAGE_SIZE };
	const areaNormal = [
		useFilesPaginatedQuery(app_convex_api.files_tree.list_archive_areas, areaArgs(0, view.normal), areaOptions),
		useFilesPaginatedQuery(app_convex_api.files_tree.list_archive_areas, areaArgs(1, view.normal), areaOptions),
		useFilesPaginatedQuery(app_convex_api.files_tree.list_archive_areas, areaArgs(2, view.normal), areaOptions),
		useFilesPaginatedQuery(app_convex_api.files_tree.list_archive_areas, areaArgs(3, view.normal), areaOptions),
	];
	const areaCohort = [
		useFilesPaginatedQuery(app_convex_api.files_tree.list_archive_areas, areaArgs(0, view.cohort), areaOptions),
		useFilesPaginatedQuery(app_convex_api.files_tree.list_archive_areas, areaArgs(1, view.cohort), areaOptions),
		useFilesPaginatedQuery(app_convex_api.files_tree.list_archive_areas, areaArgs(2, view.cohort), areaOptions),
		useFilesPaginatedQuery(app_convex_api.files_tree.list_archive_areas, areaArgs(3, view.cohort), areaOptions),
	];
	const areas = merge_streams<FilesSidebarArchive_AreaRow>({
		streams: view.normal ? [...areaNormal, ...(view.cohort ? areaCohort : [])] : [],
		isViewLoading: view.loading,
		compare: (a, b) => compareValues(a.treePath, b.treePath),
	});

	// When the chosen folder is no longer one the person can open, show the workspace again.
	const area =
		chosenArea !== null && areas.status === "done" && !areas.rows.some((row) => row._id === chosenArea.id)
			? null
			: chosenArea;
	const areaLabel = area === null ? "Workspace" : path_name_of(area.path);

	const topArgs = (savedStream: files_SavedStream | null) =>
		savedStream ? { membershipId, savedStream, area: area?.id ?? null } : ("skip" as const);
	// The query has its own cursor, so pin each page's end. Otherwise a new archive could hide a row.
	const topOptions = { initialNumItems: FilesSidebarArchive_PAGE_SIZE, pinPageEnds: true };
	const topNormal = useFilesPaginatedQuery(
		app_convex_api.files_tree.list_archived_tops,
		topArgs(view.normal),
		topOptions,
	);
	const topCohort = useFilesPaginatedQuery(
		app_convex_api.files_tree.list_archived_tops,
		topArgs(view.cohort),
		topOptions,
	);
	// Destructure, so the React Compiler does not treat the rows as changed by a later `loadMore` call.
	const {
		rows: topRows,
		status: topStatus,
		loadMore: loadMoreTops,
	} = merge_streams<FilesSidebarArchive_TopRow>({
		streams: view.normal ? [topNormal, ...(view.cohort ? [topCohort] : [])] : [],
		isViewLoading: view.loading,
		// The server order: newest archive operation first, then by `treePath`. A locked row has no
		// `treePath`, so build it from the path the same way.
		compare: (a, b) =>
			compareValues(b.archiveOperationId ?? "", a.archiveOperationId ?? "") ||
			compareValues(
				a.locked ? files_derive_tree_path_for_file_node(a.path, a.kind) : a.treePath,
				b.locked ? files_derive_tree_path_for_file_node(b.path, b.kind) : b.treePath,
			),
	});

	// Delete permanently needs Can manage, like the server: on the workspace for the open part, on the
	// area for a restricted folder, and on the folder itself for a restricted folder listed here.
	const canManageWorkspace = useQuery(app_convex_api.access_control.get_current_user_workspace_permission, {
		membershipId,
		permission: "content.permissions.manage",
	});
	const areaShareState = useQuery(
		app_convex_api.files_sharing.get_node_share_state,
		area === null ? "skip" : { membershipId, nodeId: area.id },
	);
	const canManageArea = area === null ? canManageWorkspace === true : areaShareState?.canManage === true;

	const handleAreaChange = useFn((value: string) => {
		setChosenArea(
			value === ""
				? null
				: { id: value as app_convex_Id<"files_nodes">, path: areas.rows.find((row) => row._id === value)?.path ?? "/" },
		);
	});

	const handleDelete = useFn<FilesSidebarArchiveRow_Props["onDelete"]>((row, returnFocusElement) => {
		purgeReturnFocusRef.current = returnFocusElement;
		setPurgeRequest({ kind: "items", nodes: [{ _id: row._id, name: row.name, path: row.path, kind: row.kind }] });
	});

	const handleEmptyArchiveClick = useFn(() => {
		purgeReturnFocusRef.current = emptyButtonRef.current;
		setPurgeRequest({
			kind: "empty_archive",
			area: area?.id ?? null,
			areaLabel: area === null ? "the workspace" : `“${areaLabel}”`,
		});
	});

	const handlePurgeClose = useFn(() => {
		setPurgeRequest(null);
	});

	const handlePurged = useFn(() => {
		// The deleted row can stay a moment while the job runs, so move focus off it now: to the next row,
		// the row before it, or Back to files.
		const rows = Array.from(
			rootRef.current?.querySelectorAll<HTMLElement>(
				`[${"data-archive-row-id" satisfies keyof FilesSidebarArchiveRow_CustomAttributes}]`,
			) ?? [],
		);
		const deletedNodeIds: string[] = purgeRequest?.kind === "items" ? purgeRequest.nodes.map((node) => node._id) : [];
		const deletedIds = new Set<string>(deletedNodeIds);
		const index = rows.findIndex((row) => deletedIds.has(row.getAttribute("data-archive-row-id")!));
		focusAfterPurgeRef.current =
			index === -1 ? backButtonRef.current : (rows[index + 1] ?? rows[index - 1] ?? backButtonRef.current);
		setPurgeRequest(null);
		onDeleted(deletedNodeIds);
	});

	const handleLoadMoreClick = useFn(() => {
		if (topStatus === "loading_more") return;
		setLoadMoreFromIds(new Set(topRows.map((row) => row._id)));
		loadMoreTops();
	});

	const handleKeyDown = useFn((event: KeyboardEvent<HTMLElement>) => {
		// Menus and the area picker handle their own Escape first and mark it handled. They call
		// preventDefault on the native event, and React does not copy that to `event.defaultPrevented`
		// after it created the event, so read the native one. The dialog renders outside this element.
		if (
			event.key === "Escape" &&
			!event.nativeEvent.defaultPrevented &&
			event.currentTarget.contains(event.target as Node)
		) {
			event.preventDefault();
			onExit();
		}
	});

	// The same focus rules as Show more in the search list: once the page has loaded, focus its first
	// new row, unless the person has moved focus somewhere else meanwhile.
	useEffect(() => {
		if (
			loadMoreFromIds === null ||
			topStatus === "loading_more" ||
			(topStatus === "more" && topRows.length <= loadMoreFromIds.size)
		) {
			return;
		}
		setLoadMoreFromIds(null);
		const activeElement = document.activeElement;
		if (topStatus === "more" || (activeElement !== document.body && !rootRef.current?.contains(activeElement))) {
			return;
		}
		const firstNewRow = topRows.find((row) => !loadMoreFromIds.has(row._id)) ?? topRows.at(-1);
		if (firstNewRow) {
			rootRef.current
				?.querySelector<HTMLElement>(
					`[${"data-archive-row-id" satisfies keyof FilesSidebarArchiveRow_CustomAttributes}="${firstNewRow._id}"]`,
				)
				?.focus();
		}
	}, [topRows, topStatus, loadMoreFromIds]);

	// The sidebar is inert while the dialog is open, so focus the element `handlePurged` picked only
	// after the dialog has closed.
	useEffect(() => {
		if (purgeRequest !== null) return;
		focusAfterPurgeRef.current?.focus();
		focusAfterPurgeRef.current = null;
	}, [purgeRequest]);

	const statusText =
		topStatus === "loading"
			? "Loading archived items…"
			: topRows.length === 0 && topStatus === "done"
				? "Nothing archived here."
				: null;

	return (
		<section
			ref={rootRef}
			aria-labelledby={titleId}
			className={"FilesSidebarArchive" satisfies FilesSidebarArchive_ClassNames}
			onKeyDown={handleKeyDown}
		>
			<div className={"FilesSidebarArchive-header" satisfies FilesSidebarArchive_ClassNames}>
				<div className={"FilesSidebarArchive-title-row" satisfies FilesSidebarArchive_ClassNames}>
					<MyButton ref={backButtonRef} type="button" variant="ghost" onClick={onExit}>
						<MyButtonIcon aria-hidden>
							<ArrowLeft />
						</MyButtonIcon>
						Back to files
					</MyButton>
					<h2 id={titleId} className={"FilesSidebarArchive-title" satisfies FilesSidebarArchive_ClassNames}>
						Archive
					</h2>
				</div>
				<div className={"FilesSidebarArchive-toolbar" satisfies FilesSidebarArchive_ClassNames}>
					<MySelect value={area?.id ?? ""} setValue={handleAreaChange}>
						<MySelectTrigger aria-label={`Archive of ${areaLabel}`}>
							<MyButton
								variant="outline"
								className={"FilesSidebarArchive-area-trigger" satisfies FilesSidebarArchive_ClassNames}
							>
								<span className={"FilesSidebarArchive-area-trigger-label" satisfies FilesSidebarArchive_ClassNames}>
									{areaLabel}
								</span>
								<MySelectOpenIndicator />
							</MyButton>
						</MySelectTrigger>
						<MySelectPopover>
							<MySelectPopoverScrollableArea>
								<MySelectPopoverContent>
									<MySelectItem value="">
										<MySelectItemContent>
											<MySelectItemContentPrimary>Workspace</MySelectItemContentPrimary>
											<MySelectItemContentSecondary>Items outside restricted folders</MySelectItemContentSecondary>
										</MySelectItemContent>
										{area === null && <MySelectItemIndicator />}
									</MySelectItem>
									{areas.rows.map((row) => (
										<MySelectItem key={row._id} value={row._id}>
											<MySelectItemContent>
												<MySelectItemContentPrimary>{row.name}</MySelectItemContentPrimary>
												<MySelectItemContentSecondary>{row.path}</MySelectItemContentSecondary>
											</MySelectItemContent>
											{area?.id === row._id && <MySelectItemIndicator />}
										</MySelectItem>
									))}
									{/* The folders come 50 at a time, by path. This option loads the next ones and keeps
									    the list open. */}
									{areas.status === "more" || areas.status === "loading_more" ? (
										<MySelectItem
											value="load_more_areas"
											setValueOnClick={false}
											hideOnClick={false}
											disabled={areas.status === "loading_more"}
											onClick={areas.loadMore}
										>
											<MySelectItemContent>
												<MySelectItemContentPrimary>
													{areas.status === "loading_more" ? "Loading more…" : "Show more folders"}
												</MySelectItemContentPrimary>
											</MySelectItemContent>
										</MySelectItem>
									) : null}
								</MySelectPopoverContent>
							</MySelectPopoverScrollableArea>
						</MySelectPopover>
					</MySelect>
					<MyButton
						ref={emptyButtonRef}
						type="button"
						variant="outline_destructive"
						disabled={!canManageArea || (topStatus === "done" && topRows.length === 0)}
						onClick={handleEmptyArchiveClick}
					>
						Empty archive…
					</MyButton>
				</div>
			</div>

			<div
				className={cn(
					"FilesSidebarArchive-content" satisfies FilesSidebarArchive_ClassNames,
					"app-scrollable" satisfies AppClassName,
				)}
			>
				{statusText !== null ? (
					<p role="status" className={"FilesSidebarArchive-state" satisfies FilesSidebarArchive_ClassNames}>
						{statusText}
					</p>
				) : (
					<ul className={"FilesSidebarArchive-list" satisfies FilesSidebarArchive_ClassNames}>
						{topRows.map((row) => (
							<FilesSidebarArchiveRow
								key={row._id}
								row={row}
								isCurrent={row._id === selectedNodeId}
								canManageArea={canManageArea}
								onOpen={onOpen}
								onRestore={onRestore}
								onDelete={handleDelete}
							/>
						))}
					</ul>
				)}
				{topStatus === "more" || topStatus === "loading_more" ? (
					<MyButton
						type="button"
						variant="ghost"
						className={"FilesSidebarArchive-more" satisfies FilesSidebarArchive_ClassNames}
						// `aria-disabled`, not `disabled`, so focus stays on Show more while its page loads.
						aria-busy={topStatus === "loading_more"}
						aria-disabled={topStatus === "loading_more"}
						onClick={handleLoadMoreClick}
					>
						Show more
					</MyButton>
				) : null}
			</div>

			<FilesPurgeModal
				request={purgeRequest}
				returnFocusRef={purgeReturnFocusRef}
				onClose={handlePurgeClose}
				onDeleted={handlePurged}
			/>
		</section>
	);
});
// #endregion root
