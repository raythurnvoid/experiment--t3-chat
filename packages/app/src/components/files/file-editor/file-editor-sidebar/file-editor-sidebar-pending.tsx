import "./file-editor-sidebar-pending.css";
import { CheckCheck, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPatch } from "diff";
import { measureLineStats, prepareWithSegments } from "@chenglou/pretext";
import { usePaginatedQuery, useQueries, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import { app_convex, app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { FilesTreeProvider } from "@/lib/files-tree-context.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyLink } from "@/components/my-link.tsx";
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
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { DiffMonospaceBlock } from "@/components/monospace-block/monospace-block-diff.tsx";
import { FileImagePreview } from "@/components/files/file-image-preview.tsx";
import { FilePendingNotice } from "@/components/files/file-node-view/file-pending-notice.tsx";
import { format_datetime } from "@/lib/date.ts";
import type { AppClassName } from "@/lib/dom-utils.ts";
import { files_truncate_path_for_width } from "@/lib/file-paths.ts";
import {
	files_ROOT_ID,
	files_collect_protected_descendant_ids,
	files_download_blob,
	files_fetch_file_pending_update_yjs_state,
	files_fetch_file_yjs_state_and_text,
	files_format_size,
	files_get_read_only_capabilities,
	files_get_signed_download_serving,
	files_node_has_editable_text_content,
	files_node_has_editable_yjs_state,
	files_pending_update_content_is_stale,
	files_pending_update_has_content,
	files_PENDING_UPDATE_STALE_BASE_MESSAGE,
	type files_YjsRootKind,
	type files_VisibleTreeNode,
	type files_VisibleEntry,
} from "@/lib/files.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../../../../../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../../../../../shared/files-tiptap.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { APP_FONT_FAMILY } from "@/lib/ui.tsx";
import { cn } from "@/lib/utils.ts";
import { useGlobalCustomEvent } from "@/lib/global-event.tsx";

// Keep these Pretext metrics in sync with `.FileEditorSidebarPending-item-path-text`;
// duplicating them here avoids `getComputedStyle` during path resize work.
const PENDING_PATH_FONT = `500 16px ${APP_FONT_FAMILY}`;
const PENDING_PATH_LETTER_SPACING = 0;

const PENDING_ACCEPT_ALL_SKIPS_REVIEW_MESSAGE = "Changes waiting for review are skipped. Open Review to update them.";

type FileEditorSidebarPendingView = FunctionReturnType<
	typeof app_convex_api.files_pending_updates.list_files_pending_updates
>["page"][number];

type FileEditorSidebarPendingRow = {
	pendingUpdate: app_convex_Doc<"files_pending_updates">;
	path: string;
	kind: "content" | "move" | "copy" | "replacement" | "content_and_move" | "delete" | "added";
	readiness: "preparing" | "ready";
	recovery?: Extract<FileEditorSidebarPendingView, { kind: "entry" }>["recovery"];
	copyDestination?: Extract<FileEditorSidebarPendingView, { kind: "entry" }>["copyDestination"];
	/**
	 * True when Accept can also create the pending parent folders this file still needs.
	 */
	canAcceptWithParents: boolean;
	/**
	 * The pending parent folders to save together with this file, outermost folder first. Empty
	 * when the parent folder already exists in the saved tree.
	 */
	requiredParents: Extract<FileEditorSidebarPendingView, { kind: "entry" }>["requiredParents"];
	/**
	 * The private draft behind this row. Null for rows that change a saved file.
	 */
	privateEntry: Extract<files_VisibleEntry, { kind: "private" }> | null;
	moveDestinationPath: string | undefined;
	/**
	 * Id of the active node that accepting this move will replace (soft-archive, like `mv -f`):
	 * the node that occupies the destination path right now, ignoring the declared replace target.
	 * File moves replace a file occupant; folder moves replace an EMPTY folder occupant (rename()
	 * semantics). Unset when nothing occupies the destination (accept is then a plain move), when
	 * the occupant has this user's own pending move (it vacates first), and for other kind mixes.
	 */
	replacedNodeId: app_convex_Id<"files_nodes"> | undefined;
	/**
	 * Destination node id for a size-only replacement involving a file without editable Yjs state.
	 */
	sizeOnlyReplacedNodeId: app_convex_Id<"files_nodes"> | undefined;
	/**
	 * True when a deleted file has editable Yjs state that can render as removed lines.
	 */
	canPreviewDeleteDiff: boolean;
	/** True when this pending row belongs to a folder node. */
	isFolder: boolean;
	/**
	 * True for a folder draft that holds another draft. The list does not draw it and the counts
	 * skip it, because saving the draft inside creates the folder too.
	 */
	hasActiveChildDraft: boolean;
	/** Private files and folders are shown as Added until publication. */
	isAddedFile: boolean;
	/**
	 * True when the file node is archived. Accept still applies the content — the file stays
	 * archived — so the row must say so instead of looking like a normal change.
	 */
	isArchived: boolean;
	/**
	 * Saved nodes own their text shape. Private drafts use their captured creation intent.
	 */
	rootKind: files_YjsRootKind | null;
	/**
	 * The content needs review after a collaboration change, or was made before another OFF save.
	 */
	isStale: boolean;
};

/**
 * Use the owner query's paths and draft state. The saved tree supplies live replacement captions.
 */
function build_pending_rows(
	views: readonly Extract<FileEditorSidebarPendingView, { kind: "entry" }>[],
	nodesById: Map<app_convex_Id<"files_nodes">, Omit<app_convex_Doc<"files_nodes">, "writePolicy">>,
): FileEditorSidebarPendingRow[] {
	const pendingUpdates = views.flatMap((view) => (view.entry.pendingUpdate ? [view.entry.pendingUpdate] : []));
	// Active nodes keyed by path, to spot the occupant a pending move's accept would replace.
	const activeNodesByPath = new Map(
		Array.from(nodesById.values())
			.filter((node) => node.archiveOperationId === null)
			.map((node) => [node.path, node] as const),
	);
	// The server requires these moves in the same reviewed unit, so they are not replacements.
	const movingNodeIds = new Set(
		pendingUpdates.filter((update) => update.pendingMove != null).map((update) => update.target.id),
	);
	// Folders that count as non-empty: a folder occupant is only replaced when it is empty
	// (rename() semantics), so a non-empty one gets no "Replaced" caption. Accept-time
	// validation also counts this user's pending moves INTO the folder as occupancy, so a
	// pending destination parent is non-empty too.
	const parentIdsWithActiveChildren = new Set(
		Array.from(nodesById.values())
			.filter((node) => node.archiveOperationId === null)
			.map((node) => node.parentId),
	);
	for (const update of pendingUpdates) {
		if (update.pendingMove?.destParent.kind === "saved") {
			parentIdsWithActiveChildren.add(update.pendingMove.destParent.id);
		}
	}
	for (const { entry } of views) {
		if (entry.kind === "private" && entry.node.parent.kind === "saved")
			parentIdsWithActiveChildren.add(entry.node.parent.id);
	}

	return views
		.flatMap((view): FileEditorSidebarPendingRow[] => {
			const { entry, readiness, canAcceptWithParents, requiredParents, hasActiveChildDraft } = view;
			const pendingUpdate = entry.pendingUpdate;
			if (!pendingUpdate) return [];
			const node = entry.kind === "saved" ? entry.node : null;
			const { pendingMove, copiedFrom, pendingArchive, pendingReplacement } = pendingUpdate;

			// A pending delete supersedes every other aspect of the doc (the upsert already
			// clears pendingMove; content branches survive but accept ignores them). A whole-file
			// copy (`cp` onto an app file) is reviewed as a whole: it has no text branches, and a
			// move on the same doc is saved in the same transaction.
			const kind =
				entry.kind === "private" && (!files_pending_update_has_content(pendingUpdate) || readiness === "preparing")
					? ("added" as const)
					: pendingArchive
						? ("delete" as const)
						: pendingReplacement
							? ("replacement" as const)
							: pendingMove
								? files_pending_update_has_content(pendingUpdate)
									? ("content_and_move" as const)
									: ("move" as const)
								: copiedFrom || view.copyDestination
									? ("copy" as const)
									: ("content" as const);

			let moveDestinationPath: string | undefined;
			let replacedNodeId: app_convex_Id<"files_nodes"> | undefined;
			let sizeOnlyReplacedNodeId: app_convex_Id<"files_nodes"> | undefined;
			if (pendingMove) {
				moveDestinationPath = entry.path;

				// Accepting replaces (soft-archives) whichever node occupies the destination path at
				// that moment, so the caption only trusts live path occupancy — a declared `mv -f`
				// target that was renamed or moved away is no longer the one replaced. No occupant,
				// or the node itself, means accept degrades to a plain move: no indicator.
				// Auto-replace is file-onto-file, or folder-onto-EMPTY-folder (rename() semantics);
				// other kind mixes keep the plain caption (accept surfaces the conflict).
				// An occupant with its own pending move vacates before this one applies: no replace.
				const replacedNode = activeNodesByPath.get(moveDestinationPath);
				const replaceKindsMatch =
					node?.kind === "file"
						? replacedNode?.kind === "file"
						: node?.kind === "folder" &&
							replacedNode?.kind === "folder" &&
							!parentIdsWithActiveChildren.has(replacedNode._id);
				if (
					replacedNode &&
					replaceKindsMatch &&
					replacedNode._id !== pendingUpdate.target.id &&
					!movingNodeIds.has(replacedNode._id)
				) {
					replacedNodeId = replacedNode._id;
					if (
						node?.kind === "file" &&
						replacedNode.kind === "file" &&
						(!files_node_has_editable_yjs_state(node) || !files_node_has_editable_yjs_state(replacedNode))
					) {
						sizeOnlyReplacedNodeId = replacedNode._id;
					}
				}
			}

			return [
				{
					pendingUpdate,
					path: node?.path ?? entry.path,
					kind,
					readiness,
					recovery: view.recovery,
					copyDestination: view.copyDestination,
					canAcceptWithParents,
					requiredParents,
					privateEntry: entry.kind === "private" ? entry : null,
					moveDestinationPath,
					replacedNodeId,
					sizeOnlyReplacedNodeId,
					canPreviewDeleteDiff: kind === "delete" && files_node_has_editable_yjs_state(node),
					isFolder: entry.node.kind === "folder",
					hasActiveChildDraft,
					isAddedFile: entry.kind === "private",
					isArchived: node != null && node.archiveOperationId !== null,
					// A file with collaboration off keeps its shape too; its branches decode the same way.
					rootKind:
						entry.kind === "private"
							? pendingUpdate.createIntent?.kind === "text"
								? pendingUpdate.createIntent.textKind
								: null
							: files_node_has_editable_text_content(node)
								? node.textKind
								: null,
					// Accepting a delete ignores the content branches, so stale content does not block it.
					isStale:
						kind !== "delete" &&
						(pendingUpdate.contentNeedsRebase === true ||
							(node != null && files_pending_update_content_is_stale(pendingUpdate, node))),
				},
			];
		})
		.sort((left, right) => left.path.localeCompare(right.path));
}

const PendingPathText = memo(function PendingPathText(props: { path: string; className?: string }) {
	const { path, className } = props;
	const pathRef = useRef<HTMLSpanElement>(null);
	const [displayPath, setDisplayPath] = useState(path);

	useLayoutEffect(() => {
		const pathElement = pathRef.current;
		const linkElement = pathElement?.closest("a");
		if (!pathElement || !linkElement) {
			setDisplayPath(path);
			return;
		}

		let cancelled = false;

		const updateDisplayPath = (width?: number) => {
			const availableWidth = width ?? linkElement.clientWidth;
			if (availableWidth <= 0) {
				if (!cancelled) {
					setDisplayPath(path);
				}
				return;
			}

			const nextDisplayPath = files_truncate_path_for_width({
				path,
				width: availableWidth,
				font: PENDING_PATH_FONT,
				letterSpacing: PENDING_PATH_LETTER_SPACING,
			});

			if (!cancelled) {
				setDisplayPath(nextDisplayPath);
			}
		};

		updateDisplayPath();

		const resizeObserver =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver((entries) => {
						updateDisplayPath(entries[0]?.contentRect.width);
					});
		resizeObserver?.observe(linkElement);
		void document.fonts?.ready.then(() => updateDisplayPath());

		return () => {
			cancelled = true;
			resizeObserver?.disconnect();
		};
	}, [path]);

	return (
		<span
			ref={pathRef}
			className={cn("FileEditorSidebarPending-item-path-text" satisfies FileEditorSidebarPending_ClassNames, className)}
		>
			{displayPath}
		</span>
	);
});

/** Old path in red strikethrough → new path in green. Shared by move-only and content-plus-move rows. */
const PendingMoveLabel = memo(function PendingMoveLabel(props: { path: string; moveDestinationPath: string }) {
	const { path, moveDestinationPath } = props;
	return (
		<span className={cn("FileEditorSidebarPending-item-move-label" satisfies FileEditorSidebarPending_ClassNames)}>
			<span
				className={cn("FileEditorSidebarPending-item-move-label-from" satisfies FileEditorSidebarPending_ClassNames)}
			>
				{path}
			</span>
			{" → "}
			<span className={cn("FileEditorSidebarPending-item-move-label-to" satisfies FileEditorSidebarPending_ClassNames)}>
				{moveDestinationPath}
			</span>
		</span>
	);
});

/**
 * Load the staged/unstaged branch states of one pending update and read each one's text. The
 * branch states live in paged `files_pending_update_yjs_states` families, so this fetches each
 * role page by page. Retained branches keep their source shape until preparation rebuilds them.
 * Every refusal bubbles so Accept can refuse visibly instead of publishing a decoded empty string.
 */
async function decode_staged_unstaged(args: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	pendingUpdate: app_convex_Doc<"files_pending_updates">;
	rootKind: files_YjsRootKind | null;
}) {
	const { membershipId, pendingUpdate } = args;
	const rootKind = pendingUpdate.contentRebaseRootKind ?? args.rootKind;
	if (pendingUpdate.preparation) {
		return Result({ _nay: { message: "This file is still being prepared" } });
	}
	if (!files_pending_update_has_content(pendingUpdate)) {
		return Result({ _nay: { message: "Pending update has no content to decode" } });
	}
	if (rootKind === null) {
		return Result({ _nay: { message: "Pending update file is not available" } });
	}

	const [stagedBytes, unstagedBytes] = await Promise.all([
		files_fetch_file_pending_update_yjs_state({
			membershipId,
			target: pendingUpdate.target,
			stateId: pendingUpdate.content.stagedStateId,
		}),
		files_fetch_file_pending_update_yjs_state({
			membershipId,
			target: pendingUpdate.target,
			stateId: pendingUpdate.content.unstagedStateId,
		}),
	]);
	if (stagedBytes._nay) return stagedBytes;
	if (unstagedBytes._nay) return unstagedBytes;

	const stagedYjsDoc = files_yjs_doc_create_from_array_buffer_update(stagedBytes._yay);
	const unstagedYjsDoc = files_yjs_doc_create_from_array_buffer_update(unstagedBytes._yay);
	try {
		const stagedText = files_yjs_doc_get_text({ yjsDoc: stagedYjsDoc, rootKind });
		if (stagedText._nay) return stagedText;
		const unstagedText = files_yjs_doc_get_text({ yjsDoc: unstagedYjsDoc, rootKind });
		if (unstagedText._nay) return unstagedText;
		return Result({ _yay: { stagedText: stagedText._yay, unstagedText: unstagedText._yay } });
	} finally {
		stagedYjsDoc.destroy();
		unstagedYjsDoc.destroy();
	}
}

// #region source select
const PENDING_SOURCE_ALL = "all";
const PENDING_SOURCE_USER = "user";

type FileEditorSidebarPendingSource =
	| typeof PENDING_SOURCE_ALL
	| typeof PENDING_SOURCE_USER
	| app_convex_Id<"ai_chat_threads">;

type FileEditorSidebarPendingSourceOption = {
	value: FileEditorSidebarPendingSource;
	label: string;
	description: string;
	count: number;
};

type FileEditorSidebarPendingSourceSelect_ClassNames =
	| "FileEditorSidebarPendingSourceSelect"
	| "FileEditorSidebarPendingSourceSelect-trigger"
	| "FileEditorSidebarPendingSourceSelect-trigger-label"
	| "FileEditorSidebarPendingSourceSelect-count"
	| "FileEditorSidebarPendingSourceSelect-popover"
	| "FileEditorSidebarPendingSourceSelect-option-label";

// Keep these Pretext metrics in sync with the `.MySelectItem` typography (14px, default weight);
// duplicating them here avoids `getComputedStyle` during overflow checks.
const PENDING_SOURCE_LABEL_FONT = `400 14px ${APP_FONT_FAMILY}`;
const PENDING_SOURCE_LABEL_LETTER_SPACING = 0;

/** Single-line option label that shows a tooltip with the full text only when it overflows. */
const PendingSourceOptionLabel = memo(function PendingSourceOptionLabel(props: { text: string }) {
	const { text } = props;
	const labelRef = useRef<HTMLSpanElement>(null);
	const [isOverflowing, setIsOverflowing] = useState(false);

	useLayoutEffect(() => {
		const labelElement = labelRef.current;
		if (!labelElement) {
			return;
		}

		let cancelled = false;

		const updateOverflow = (width?: number) => {
			const availableWidth = width ?? labelElement.clientWidth;
			if (availableWidth <= 0) {
				if (!cancelled) {
					setIsOverflowing(false);
				}
				return;
			}

			const stats = measureLineStats(
				prepareWithSegments(text, PENDING_SOURCE_LABEL_FONT, {
					letterSpacing: PENDING_SOURCE_LABEL_LETTER_SPACING,
					whiteSpace: "normal",
				}),
				availableWidth,
			);

			if (!cancelled) {
				setIsOverflowing(stats.lineCount > 1 || stats.maxLineWidth > availableWidth);
			}
		};

		updateOverflow();

		const resizeObserver =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver((entries) => {
						updateOverflow(entries[0]?.contentRect.width);
					});
		resizeObserver?.observe(labelElement);
		void document.fonts?.ready.then(() => updateOverflow());

		return () => {
			cancelled = true;
			resizeObserver?.disconnect();
		};
	}, [text]);

	const label = (
		<span
			ref={labelRef}
			className={cn(
				"FileEditorSidebarPendingSourceSelect-option-label" satisfies FileEditorSidebarPendingSourceSelect_ClassNames,
			)}
		>
			{text}
		</span>
	);

	// Keep the trigger mounted in both states so the measured span is never remounted (the
	// ResizeObserver above would keep watching a detached node). Only the content is conditional.
	return (
		<MyTooltip>
			<MyTooltipTrigger focusable={false}>{label}</MyTooltipTrigger>
			{isOverflowing ? <MyTooltipContent unmountOnHide>{text}</MyTooltipContent> : null}
		</MyTooltip>
	);
});

function pending_row_matches_source(
	row: { threadIds?: app_convex_Id<"ai_chat_threads">[] },
	source: FileEditorSidebarPendingSource,
) {
	if (source === PENDING_SOURCE_ALL) {
		return true;
	}
	if (source === PENDING_SOURCE_USER) {
		return !row.threadIds?.length;
	}
	return row.threadIds?.includes(source) ?? false;
}

const FileEditorSidebarPendingSourceSelect = memo(function FileEditorSidebarPendingSourceSelect(props: {
	value: FileEditorSidebarPendingSource;
	options: FileEditorSidebarPendingSourceOption[];
	onValueChange: (value: FileEditorSidebarPendingSource) => void;
}) {
	const selectedOption = props.options.find((option) => option.value === props.value) ?? props.options[0];
	if (!selectedOption) {
		return null;
	}

	return (
		<div
			className={cn("FileEditorSidebarPendingSourceSelect" satisfies FileEditorSidebarPendingSourceSelect_ClassNames)}
		>
			<MySelect
				value={props.value}
				setValue={(value) => {
					props.onValueChange(value as FileEditorSidebarPendingSource);
				}}
			>
				<MySelectTrigger
					aria-label={`Pending changes source: ${selectedOption.label}, ${selectedOption.count} ${selectedOption.count === 1 ? "change" : "changes"}`}
				>
					<MyButton
						variant="outline"
						className={cn(
							"FileEditorSidebarPendingSourceSelect-trigger" satisfies FileEditorSidebarPendingSourceSelect_ClassNames,
						)}
					>
						<span
							className={cn(
								"FileEditorSidebarPendingSourceSelect-trigger-label" satisfies FileEditorSidebarPendingSourceSelect_ClassNames,
							)}
						>
							{selectedOption.label}
						</span>
						<span
							className={cn(
								"FileEditorSidebarPendingSourceSelect-count" satisfies FileEditorSidebarPendingSourceSelect_ClassNames,
							)}
						>
							{selectedOption.count}
						</span>
						<MySelectOpenIndicator />
					</MyButton>
				</MySelectTrigger>
				<MySelectPopover
					className={cn(
						"FileEditorSidebarPendingSourceSelect-popover" satisfies FileEditorSidebarPendingSourceSelect_ClassNames,
					)}
				>
					<MySelectPopoverScrollableArea>
						<MySelectPopoverContent>
							{props.options.map((option) => (
								<MySelectItem key={option.value} value={option.value}>
									<MySelectItemContent>
										<MySelectItemContentPrimary>
											<PendingSourceOptionLabel text={option.label} />
										</MySelectItemContentPrimary>
										<MySelectItemContentSecondary>{option.description}</MySelectItemContentSecondary>
									</MySelectItemContent>
									<span
										className={cn(
											"FileEditorSidebarPendingSourceSelect-count" satisfies FileEditorSidebarPendingSourceSelect_ClassNames,
										)}
									>
										{option.count}
									</span>
									{props.value === option.value && <MySelectItemIndicator />}
								</MySelectItem>
							))}
						</MySelectPopoverContent>
					</MySelectPopoverScrollableArea>
				</MySelectPopover>
			</MySelect>
		</div>
	);
});
// #endregion source select

// #region size diff
function format_size_diff_value(size: number) {
	const formattedSize = files_format_size(size);
	return formattedSize === `${size} bytes` ? formattedSize : `${formattedSize} (${size} bytes)`;
}

// Keep both asset queries mounted while the details are closed.
// This lets the first expand render immediately.
const FileEditorSidebarPendingSizeDiff = memo(function FileEditorSidebarPendingSizeDiff(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	sourceNodeId: app_convex_Id<"files_nodes">;
	replacedNodeId: app_convex_Id<"files_nodes">;
	path: string;
}) {
	const sourceAsset = useQuery(app_convex_api.r2.get_asset_by_file_node_id, {
		membershipId: props.membershipId,
		fileNodeId: props.sourceNodeId,
	});
	const replacedAsset = useQuery(app_convex_api.r2.get_asset_by_file_node_id, {
		membershipId: props.membershipId,
		fileNodeId: props.replacedNodeId,
	});

	if (sourceAsset === undefined || replacedAsset === undefined) {
		return (
			<div
				role="status"
				className={cn("FileEditorSidebarPending-item-diff" satisfies FileEditorSidebarPending_ClassNames)}
			>
				Loading size difference…
			</div>
		);
	}
	if (!sourceAsset || !replacedAsset) {
		return null;
	}

	const diffText =
		sourceAsset.size === replacedAsset.size
			? `Size unchanged: ${format_size_diff_value(sourceAsset.size)}`
			: createPatch(
					props.path,
					`Size: ${format_size_diff_value(replacedAsset.size)}\n`,
					`Size: ${format_size_diff_value(sourceAsset.size)}\n`,
				);

	return (
		<DiffMonospaceBlock
			aria-label={`Size difference for ${props.path}`}
			className={cn("FileEditorSidebarPending-item-diff" satisfies FileEditorSidebarPending_ClassNames)}
			diffText={diffText}
			maxHeight="16lh"
		/>
	);
});
// #endregion size diff

// #region stored file details
type FileEditorSidebarPendingStoredFileDetails_ClassNames =
	| "FileEditorSidebarPendingStoredFileDetails"
	| "FileEditorSidebarPendingStoredFileDetails-actions";

/**
 * Open body of a ready draft the agent created with finished bytes (`createIntent.kind === "stored"`),
 * such as a browser screenshot, a generated image, or a file written by a code run. These files
 * have no text diff, so the body shows an image preview, the file facts, and Download. The row
 * above it owns Accept and Discard, like every other pending row.
 */
const FileEditorSidebarPendingStoredFileDetails = memo(function FileEditorSidebarPendingStoredFileDetails(props: {
	entry: Extract<files_VisibleEntry, { kind: "private" }>;
	intent: Extract<NonNullable<app_convex_Doc<"files_pending_updates">["createIntent"]>, { kind: "stored" }>;
	disabled: boolean;
}) {
	const { entry, intent, disabled } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const [isDownloading, setIsDownloading] = useState(false);
	const serving = files_get_signed_download_serving({ contentType: intent.contentType, fileName: entry.node.name });
	// The serving policy filters unsafe types such as SVG before deciding whether to show an image.
	const isImage = serving.responseContentType.startsWith("image/");

	// The row mounts this body only while it is open. So a long list of closed rows keeps no live
	// queries for the creator name and the chat titles.
	const creator = useQuery(app_convex_api.users.get_anagraphic, { userId: entry.node.userId });
	const threads = useQueries(
		useMemo(
			() =>
				Object.fromEntries(
					(entry.pendingUpdate.threadIds ?? []).map((threadId) => [
						threadId,
						{
							query: app_convex_api.files_pending_updates.get_pending_source_summary,
							args: { membershipId, threadId },
						},
					]),
				),
			[entry.pendingUpdate.threadIds, membershipId],
		),
	);

	const handleDownload = useFn(() => {
		if (isDownloading || disabled) return;
		setIsDownloading(true);
		// Pin the signed download to the draft revision shown in this review.
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

				const response = await fetch(result._yay.url);
				if (!response.ok) {
					toast.error("The file could not be downloaded. Try again.");
					return;
				}

				files_download_blob({ blob: await response.blob(), filename: entry.node.name });
			})
			.catch(() => toast.error("The file could not be downloaded. Try again."))
			.finally(() => setIsDownloading(false));
	});

	return (
		<div
			className={
				"FileEditorSidebarPendingStoredFileDetails" satisfies FileEditorSidebarPendingStoredFileDetails_ClassNames
			}
		>
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

			<p>
				{intent.contentType} · {files_format_size(intent.size)}
			</p>
			<p>Created by {creator === undefined ? "Loading…" : (creator?.displayName ?? "Unknown")}</p>

			{/* Link every chat that proposed this file. One file can come from more than one chat. */}
			{(entry.pendingUpdate.threadIds ?? []).map((threadId) => {
				const thread = threads[threadId];
				return (
					<p key={threadId}>
						{thread && !(thread instanceof Error) ? (
							<MyLink
								to="/w/$organizationName/$workspaceName/chat"
								params={{ organizationName: thread.organizationName, workspaceName: thread.workspaceName }}
								search={{ threadId }}
							>
								{thread.title || "New Chat"}
							</MyLink>
						) : thread === undefined ? (
							"Loading chat…"
						) : (
							"Unavailable chat"
						)}
					</p>
				);
			})}

			<div
				className={
					"FileEditorSidebarPendingStoredFileDetails-actions" satisfies FileEditorSidebarPendingStoredFileDetails_ClassNames
				}
			>
				<MyButton
					variant="outline"
					disabled={isDownloading || disabled}
					aria-busy={isDownloading}
					aria-label={`Download ${entry.node.name}`}
					onClick={handleDownload}
				>
					Download
				</MyButton>
			</div>
		</div>
	);
});
// #endregion stored file details

// #region item
type FileEditorSidebarPendingItem_Props = {
	pendingUpdate: app_convex_Doc<"files_pending_updates">;
	path: string;
	kind: FileEditorSidebarPendingRow["kind"];
	moveDestinationPath: string | undefined;
	replacedNodeId: app_convex_Id<"files_nodes"> | undefined;
	sizeOnlyReplacedNodeId: app_convex_Id<"files_nodes"> | undefined;
	canPreviewDeleteDiff: boolean;
	isAddedFile: boolean;
	isFolder: boolean;
	readiness: "preparing" | "ready";
	recovery?: FileEditorSidebarPendingRow["recovery"];
	copyDestination?: FileEditorSidebarPendingRow["copyDestination"];
	isArchived: boolean;
	rootKind: files_YjsRootKind | null;
	isStale: boolean;
	requiredParents: FileEditorSidebarPendingRow["requiredParents"];
	privateEntry: FileEditorSidebarPendingRow["privateEntry"];
	canAccept: boolean;
	disabled?: boolean;
	onActionSuccess: (message: string) => void;
};

const FileEditorSidebarPendingItem = memo(function FileEditorSidebarPendingItem(
	props: FileEditorSidebarPendingItem_Props,
) {
	const {
		pendingUpdate,
		path,
		kind,
		moveDestinationPath,
		replacedNodeId,
		sizeOnlyReplacedNodeId,
		canPreviewDeleteDiff,
		isAddedFile,
		isFolder,
		readiness,
		isArchived,
		rootKind,
		isStale,
		requiredParents,
		privateEntry,
		canAccept,
		disabled,
		onActionSuccess,
	} = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const { startReview } = AppActivitiesProvider.useContext();

	const [isOpen, setIsOpen] = useState(false);
	const [isBusy, setIsBusy] = useState(false);
	const itemRef = useRef<HTMLLIElement>(null);
	// A stored draft, such as a screenshot, has no text diff. Its open row shows the file details instead.
	const storedIntent = pendingUpdate.createIntent?.kind === "stored" ? pendingUpdate.createIntent : null;

	// Accepting or discarding removes this row. The browser then puts focus on `<body>` and a
	// keyboard user loses their place, so this cleanup gives focus back to the panel. Both panel
	// roots carry `tabIndex={-1}` so they can take it.
	useLayoutEffect(() => {
		const item = itemRef.current;
		return () => {
			if (!item?.contains(document.activeElement)) return;
			const panel = item.closest<HTMLElement>(".FileEditorSidebarPending");
			// Wait for row removal to finish. Keep any focus moved by the review dialog.
			queueMicrotask(() => {
				if (document.activeElement === document.body) panel?.focus();
			});
		};
	}, []);

	// A delete preview always shows the committed Markdown, even when content branches remain on
	// the pending doc. Start loading it on mount so the first expand does not wait for the reads.
	const [deletedCommittedMarkdown, setDeletedCommittedMarkdown] = useState<string | null | undefined>();
	useEffect(() => {
		if (kind !== "delete" || !canPreviewDeleteDiff || pendingUpdate.target.kind !== "saved") {
			return;
		}

		let cancelled = false;
		const nodeId = pendingUpdate.target.id;
		setDeletedCommittedMarkdown(undefined);
		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const fileContentData = await files_fetch_file_yjs_state_and_text({
				membershipId,
				nodeId,
			});
			if (cancelled) return;
			setDeletedCommittedMarkdown(
				fileContentData && !fileContentData.text._nay ? (fileContentData.text._yay ?? null) : null,
			);
		})().catch((error) => {
			if (!cancelled) {
				setDeletedCommittedMarkdown(null);
			}
			console.error("[FileEditorSidebarPending] Failed to load the deleted file content", {
				error,
				nodeId: pendingUpdate.target.id,
			});
		});
		return () => {
			cancelled = true;
		};
	}, [kind, canPreviewDeleteDiff, membershipId, pendingUpdate.target.kind, pendingUpdate.target.id]);

	// Decode lazily: the branch states are fetched page by page and the rich branch spins up a
	// headless Tiptap editor, so only build the diff once the accordion is open. The
	// pending-update prop ref changes only when the doc data changes.
	const [diffText, setDiffText] = useState<string | null>(null);
	useEffect(() => {
		if (!isOpen || kind === "added") {
			setDiffText(null);
			return;
		}
		if (kind === "delete") {
			// The whole committed content shows as removed lines.
			setDiffText(
				typeof deletedCommittedMarkdown === "string" ? createPatch(path, deletedCommittedMarkdown, "") : null,
			);
			return;
		}
		if (sizeOnlyReplacedNodeId) {
			setDiffText(null);
			return;
		}

		let cancelled = false;
		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const decoded = await decode_staged_unstaged({ membershipId, pendingUpdate, rootKind });
			if (cancelled) return;
			if (decoded._nay) {
				console.error("[FileEditorSidebarPending] Failed to decode the pending diff preview", {
					error: decoded._nay,
					nodeId: pendingUpdate.target.id,
				});
				setDiffText(null);
				return;
			}
			setDiffText(createPatch(path, decoded._yay.stagedText, decoded._yay.unstagedText));
		})().catch((error) => {
			console.error("[FileEditorSidebarPending] Unexpected error while decoding the pending diff preview", {
				error,
				nodeId: pendingUpdate.target.id,
			});
			if (!cancelled) {
				setDiffText(null);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [isOpen, kind, sizeOnlyReplacedNodeId, deletedCommittedMarkdown, pendingUpdate, path, membershipId, rootKind]);

	const handleToggle = useFn((event: { currentTarget: HTMLDetailsElement }) => {
		setIsOpen(event.currentTarget.open);
	});

	// The chevron is a real <button>, so clicking it does not trigger the native <summary> toggle.
	// Drive the controlled `open` state directly (and `preventDefault` so the native toggle can't race it).
	const handleChevronToggle = useFn((event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		setIsOpen((open) => !open);
	});

	// Names the row for the action buttons' aria-labels and the panel's status announcements, so
	// "Accept" reads as for example "Accept move of /a.md to /b.md".
	const actionLabel =
		kind === "delete"
			? `delete of ${path}`
			: (kind === "move" || kind === "content_and_move") && moveDestinationPath != null
				? `move of ${path} to ${moveDestinationPath}`
				: `changes to ${path}`;
	// Accept saves the pending parent folders too. The caption does not name them, like for any new
	// file. Only the tooltip and the accessible name list the folders.
	const parentsLabel =
		requiredParents.length > 0 ? `, also adds ${requiredParents.map((parent) => parent.path).join(", ")}` : "";

	// `preventDefault()` stops the native <summary> from toggling when the action buttons are clicked.
	const handleAccept = useFn((event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		if (isBusy || disabled || !canAccept) return;
		// The button stays enabled so the explanation is reachable by click too, not only by
		// hovering the tooltip.
		if (isStale) {
			toast.error(files_PENDING_UPDATE_STALE_BASE_MESSAGE);
			return;
		}
		setIsBusy(true);
		startReview({
			kind: "accept",
			items: [
				// Save the pending parent folders first, so the draft has somewhere to land.
				...requiredParents.map((parent) => ({
					pendingUpdateId: parent.pendingUpdateId,
					reviewedRevision: parent.reviewedRevision,
					selectedContentStateId: null,
				})),
				{
					pendingUpdateId: pendingUpdate._id,
					reviewedRevision: pendingUpdate.revision,
					selectedContentStateId:
						pendingUpdate.pendingArchive || pendingUpdate.pendingReplacement
							? null
							: (pendingUpdate.content?.unstagedStateId ?? null),
				},
			],
		})
			.then(() => onActionSuccess(`Started accepting ${actionLabel}`))
			.catch((error: unknown) => {
				toast.error(error instanceof Error ? error.message : "Failed to start review");
			})
			.finally(() => setIsBusy(false));
	});

	const handleDiscard = useFn((event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		if (isBusy || disabled) return;
		setIsBusy(true);
		startReview({
			kind: "discard",
			items: [
				{
					pendingUpdateId: pendingUpdate._id,
					reviewedRevision: pendingUpdate.revision,
					selectedContentStateId: null,
				},
			],
		})
			.then(() => onActionSuccess(`Started discarding ${actionLabel}`))
			.catch((error: unknown) => {
				toast.error(error instanceof Error ? error.message : "Failed to start review");
			})
			.finally(() => setIsBusy(false));
	});

	// Plain moves have no content to diff. A delete without editable Yjs state also has nothing
	// useful to preview. A new folder and a preparing draft have nothing to open either. Size-only
	// replacements are the exception: their accordion compares stored sizes. A ready stored draft
	// opens its file details.
	if (
		(kind === "added" && !(storedIntent && readiness === "ready")) ||
		(kind === "move" && !sizeOnlyReplacedNodeId) ||
		(kind === "delete" && !canPreviewDeleteDiff)
	) {
		const moveLabel =
			kind === "move" && moveDestinationPath != null
				? `${path} → ${moveDestinationPath}`
				: kind === "added"
					? path + parentsLabel
					: path;

		return (
			<li ref={itemRef}>
				<div
					className={cn(
						"FileEditorSidebarPending-item" satisfies FileEditorSidebarPending_ClassNames,
						"FileEditorSidebarPending-item-move" satisfies FileEditorSidebarPending_ClassNames,
					)}
				>
					<MyLink
						className={cn("FileEditorSidebarPending-item-path" satisfies FileEditorSidebarPending_ClassNames)}
						to="/w/$organizationName/$workspaceName/files"
						params={{ organizationName, workspaceName }}
						search={
							pendingUpdate.target.kind === "private"
								? { pendingNodeId: pendingUpdate.target.id }
								: { nodeId: pendingUpdate.target.id }
						}
						aria-label={moveLabel}
						tooltip={moveLabel}
					>
						{kind === "move" && moveDestinationPath != null ? (
							<PendingMoveLabel path={path} moveDestinationPath={moveDestinationPath} />
						) : (
							<span
								className={cn(
									"FileEditorSidebarPending-item-move-label" satisfies FileEditorSidebarPending_ClassNames,
									kind === "delete"
										? ("FileEditorSidebarPending-item-path-text-deleted" satisfies FileEditorSidebarPending_ClassNames)
										: isAddedFile &&
												("FileEditorSidebarPending-item-path-text-added" satisfies FileEditorSidebarPending_ClassNames),
								)}
							>
								{path}
							</span>
						)}
						<span className={cn("FileEditorSidebarPending-item-caption" satisfies FileEditorSidebarPending_ClassNames)}>
							{readiness === "preparing"
								? "Preparing…"
								: kind === "added"
									? isFolder
										? "Added folder"
										: "Added file"
									: kind === "delete"
										? "Deleted"
										: replacedNodeId != null
											? "Replaced"
											: "Moved"}
						</span>
					</MyLink>
					<span className={cn("FileEditorSidebarPending-item-actions" satisfies FileEditorSidebarPending_ClassNames)}>
						<MyButton
							variant="ghost"
							className={cn("FileEditorSidebarPending-accept" satisfies FileEditorSidebarPending_ClassNames)}
							aria-label={`Accept ${actionLabel}`}
							tooltip={isStale ? files_PENDING_UPDATE_STALE_BASE_MESSAGE : undefined}
							aria-busy={isBusy}
							disabled={!canAccept}
							aria-disabled={isBusy || disabled}
							onClick={handleAccept}
						>
							Accept
						</MyButton>
						<MyButton
							variant="ghost_destructive"
							aria-label={`Discard ${actionLabel}`}
							aria-busy={isBusy}
							aria-disabled={isBusy || disabled}
							onClick={handleDiscard}
						>
							Discard
						</MyButton>
					</span>
				</div>
				<FilePendingNotice recovery={props.recovery} copyDestination={props.copyDestination} />
			</li>
		);
	}

	// Short neutral helper describing what accepting does, always visible. Deleted wins over
	// everything (a delete supersedes the doc's other aspects). The replace indicator wins the
	// next slot: a move onto an occupied destination archives that file, so mark it as Replaced.
	// Copy and replacement rows also show Replaced: accepting them installs a whole-file replacement
	// (content and type). A content-plus-move row compounds: the edits stay Modified (or Added) and
	// the move adds Moved. Plain edits show Modified. Old proposals point the owner to Review.
	// An archived target still accepts — the file stays archived — so the row says so.
	const caption =
		(kind === "delete"
			? "Deleted"
			: isStale
				? "Review to update"
				: replacedNodeId != null
					? "Replaced"
					: kind === "content_and_move"
						? `${isAddedFile ? "Added" : "Modified"} · Moved`
						: isAddedFile
							? "Added file"
							: kind === "copy" || kind === "replacement"
								? "Replaced"
								: "Modified") + (isArchived ? " · Archived" : "");

	// Content-plus-move rows show the same red → green move label as move-only rows; the link
	// still opens the diff. Delete rows always show only their own path. The stale suffix gives
	// assistive tech the caption's meaning.
	const rowLabel =
		(kind === "move" || kind === "content_and_move") && moveDestinationPath != null
			? `${path} → ${moveDestinationPath}`
			: path;
	const rowAccessibleLabel =
		(isStale ? `${rowLabel}, review to update` : rowLabel) + (isArchived ? ", archived" : "") + parentsLabel;

	return (
		<li ref={itemRef}>
			<FilePendingNotice recovery={props.recovery} copyDestination={props.copyDestination} />
			<details
				className={cn("FileEditorSidebarPending-item" satisfies FileEditorSidebarPending_ClassNames)}
				open={isOpen}
				onToggle={handleToggle}
			>
				<summary className={cn("FileEditorSidebarPending-item-summary" satisfies FileEditorSidebarPending_ClassNames)}>
					<MyIconButton
						aria-hidden
						tabIndex={-1}
						variant="ghost-highlightable"
						onMouseDown={(event) => event.preventDefault()}
						onClick={handleChevronToggle}
					>
						<MyIconButtonIcon>{isOpen ? <ChevronDown /> : <ChevronRight />}</MyIconButtonIcon>
					</MyIconButton>
					<MyLink
						className={cn("FileEditorSidebarPending-item-path" satisfies FileEditorSidebarPending_ClassNames)}
						to="/w/$organizationName/$workspaceName/files"
						params={{ organizationName, workspaceName }}
						search={
							// The diff editor cannot represent a deleted file, a size-only replacement, a
							// whole-file copy, or a stored draft (no text branches). The inline preview below
							// handles those, and the link opens the file itself.
							pendingUpdate.target.kind === "private"
								? storedIntent
									? { pendingNodeId: pendingUpdate.target.id }
									: { pendingNodeId: pendingUpdate.target.id, view: "diff_editor" }
								: kind === "delete" || kind === "replacement" || sizeOnlyReplacedNodeId
									? { nodeId: pendingUpdate.target.id }
									: { nodeId: pendingUpdate.target.id, view: "diff_editor" }
						}
						aria-label={rowAccessibleLabel}
						tooltip={rowAccessibleLabel}
					>
						{(kind === "move" || kind === "content_and_move") && moveDestinationPath != null ? (
							<PendingMoveLabel path={path} moveDestinationPath={moveDestinationPath} />
						) : (
							<PendingPathText
								path={path}
								className={cn(
									kind === "delete"
										? ("FileEditorSidebarPending-item-path-text-deleted" satisfies FileEditorSidebarPending_ClassNames)
										: isAddedFile &&
												("FileEditorSidebarPending-item-path-text-added" satisfies FileEditorSidebarPending_ClassNames),
								)}
							/>
						)}
						<span className={cn("FileEditorSidebarPending-item-caption" satisfies FileEditorSidebarPending_ClassNames)}>
							{caption}
						</span>
					</MyLink>
					<span className={cn("FileEditorSidebarPending-item-actions" satisfies FileEditorSidebarPending_ClassNames)}>
						<MyButton
							variant="ghost"
							className={cn("FileEditorSidebarPending-accept" satisfies FileEditorSidebarPending_ClassNames)}
							aria-label={`Accept ${actionLabel}`}
							tooltip={isStale ? files_PENDING_UPDATE_STALE_BASE_MESSAGE : undefined}
							aria-busy={isBusy}
							disabled={!canAccept}
							aria-disabled={isBusy || disabled}
							onClick={handleAccept}
						>
							Accept
						</MyButton>
						<MyButton
							variant="ghost_destructive"
							aria-label={`Discard ${actionLabel}`}
							aria-busy={isBusy}
							aria-disabled={isBusy || disabled}
							onClick={handleDiscard}
						>
							Discard
						</MyButton>
					</span>
				</summary>
				{isOpen && storedIntent && privateEntry ? (
					<FileEditorSidebarPendingStoredFileDetails entry={privateEntry} intent={storedIntent} disabled={!!disabled} />
				) : sizeOnlyReplacedNodeId && pendingUpdate.target.kind === "saved" ? (
					<FileEditorSidebarPendingSizeDiff
						membershipId={membershipId}
						sourceNodeId={pendingUpdate.target.id}
						replacedNodeId={sizeOnlyReplacedNodeId}
						path={path}
					/>
				) : isOpen && kind === "replacement" && pendingUpdate.pendingReplacement ? (
					<div
						role="status"
						className={cn("FileEditorSidebarPending-item-diff" satisfies FileEditorSidebarPending_ClassNames)}
					>
						Replaces the file's content and type with a copy
						{pendingUpdate.copiedFrom ? ` of ${pendingUpdate.copiedFrom.path}` : ""} (
						{pendingUpdate.pendingReplacement.contentType}). Save changes in all open editors first. An existing text
						file keeps its collaboration setting.
					</div>
				) : isOpen && diffText != null ? (
					<DiffMonospaceBlock
						className={cn("FileEditorSidebarPending-item-diff" satisfies FileEditorSidebarPending_ClassNames)}
						diffText={diffText}
						maxHeight="16lh"
					/>
				) : isOpen && kind === "delete" && deletedCommittedMarkdown === undefined ? (
					<div
						role="status"
						className={cn("FileEditorSidebarPending-item-diff" satisfies FileEditorSidebarPending_ClassNames)}
					>
						Loading diff…
					</div>
				) : null}
			</details>
		</li>
	);
});
// #endregion item

// #region restricted item
type FileEditorSidebarPendingRestrictedItem_Props = {
	view: Extract<FileEditorSidebarPendingView, { kind: "restricted" }>;
	disabled: boolean;
	onActionSuccess: (message: string) => void;
};

const FileEditorSidebarPendingRestrictedItem = memo(function FileEditorSidebarPendingRestrictedItem(
	props: FileEditorSidebarPendingRestrictedItem_Props,
) {
	const { view, disabled, onActionSuccess } = props;

	const { startReview } = AppActivitiesProvider.useContext();
	const [isBusy, setIsBusy] = useState(false);

	const handleDiscard = useFn(() => {
		if (isBusy || disabled) return;

		setIsBusy(true);
		startReview({
			kind: "discard",
			items: [
				{
					pendingUpdateId: view.pendingUpdateId,
					reviewedRevision: view.revision,
					selectedContentStateId: null,
				},
			],
		})
			.then(() => onActionSuccess("Started discarding unavailable draft"))
			.catch((error: unknown) => {
				toast.error(error instanceof Error ? error.message : "Failed to discard pending changes");
			})
			.finally(() => setIsBusy(false));
	});

	return (
		<li>
			<div
				className={cn(
					"FileEditorSidebarPending-item" satisfies FileEditorSidebarPending_ClassNames,
					"FileEditorSidebarPending-item-move" satisfies FileEditorSidebarPending_ClassNames,
				)}
			>
				<span className={cn("FileEditorSidebarPending-item-path" satisfies FileEditorSidebarPending_ClassNames)}>
					Draft unavailable
				</span>
				<MyButton
					variant="ghost_destructive"
					aria-label="Discard unavailable draft"
					aria-disabled={isBusy || disabled}
					aria-busy={isBusy}
					onClick={handleDiscard}
				>
					Discard
				</MyButton>
			</div>
		</li>
	);
});
// #endregion restricted item

// #region root
export type FileEditorSidebarPending_ClassNames =
	| "FileEditorSidebarPending"
	| "FileEditorSidebarPending-empty"
	| "FileEditorSidebarPending-status"
	| "FileEditorSidebarPending-header"
	| "FileEditorSidebarPending-header-actions"
	| "FileEditorSidebarPending-header-button"
	| "FileEditorSidebarPending-header-icon"
	| "FileEditorSidebarPending-accept"
	| "FileEditorSidebarPending-list"
	| "FileEditorSidebarPending-item"
	| "FileEditorSidebarPending-item-summary"
	| "FileEditorSidebarPending-item-path"
	| "FileEditorSidebarPending-item-path-text"
	| "FileEditorSidebarPending-item-actions"
	| "FileEditorSidebarPending-item-diff"
	| "FileEditorSidebarPending-item-move"
	| "FileEditorSidebarPending-item-move-label"
	| "FileEditorSidebarPending-item-move-label-from"
	| "FileEditorSidebarPending-item-move-label-to"
	| "FileEditorSidebarPending-item-caption"
	| "FileEditorSidebarPending-item-path-text-added"
	| "FileEditorSidebarPending-item-path-text-deleted";

export const FileEditorSidebarPending = memo(function FileEditorSidebarPending() {
	const { membershipId } = AppTenantProvider.useContext();
	const { startReview, isStartingReview } = AppActivitiesProvider.useContext();

	const [isSubmitting, setIsSubmitting] = useState(false);
	// Busy review buttons keep focus until the dialog opens. Handlers block repeated clicks.
	const isBulkBusy = isSubmitting || isStartingReview;
	const [selectedSource, setSelectedSource] = useState<FileEditorSidebarPendingSource>(PENDING_SOURCE_ALL);
	useGlobalCustomEvent("files::review_all_pending", (event) => {
		if (event.detail.membershipId === membershipId) setSelectedSource(PENDING_SOURCE_ALL);
	});

	// Settled signal for screen readers and automation: successful actions write into this
	// `role="status"` live region imperatively, so no React re-render is needed to announce.
	// Failures already announce through the sonner toasts.
	const statusRef = useRef<HTMLSpanElement>(null);

	const announceActionSuccess = useFn((message: string) => {
		const statusElement = statusRef.current;
		if (statusElement) {
			statusElement.textContent = message;
		}
	});

	const {
		results: pendingUpdatesResult,
		status: pendingUpdatesStatus,
		loadMore,
	} = usePaginatedQuery(
		app_convex_api.files_pending_updates.list_files_pending_updates,
		{ membershipId },
		{ initialNumItems: 20 },
	);
	// Saved rows need every node, to find the node a move would replace. Load the whole workspace only
	// when such a row exists.
	const fileNodesList = FilesTreeProvider.useFullList(pendingUpdatesResult.some((view) => view.kind === "entry"));
	// Keep both the id list and queries object stable. `useQueries` treats a new object as a new set
	// of subscriptions and schedules render-phase state updates while it reconnects them.
	const threadIds = useMemo(
		() => [
			...new Set(
				pendingUpdatesResult.flatMap(
					(view) => (view.kind === "entry" ? view.entry.pendingUpdate?.threadIds : view.threadIds) ?? [],
				),
			),
		],
		[pendingUpdatesResult],
	);
	const threadQueryResults = useQueries(
		useMemo(
			() =>
				Object.fromEntries(
					threadIds.map((threadId) => [
						threadId,
						{
							query: app_convex_api.files_pending_updates.get_pending_source_summary,
							args: { membershipId, threadId },
						},
					]),
				),
			[membershipId, threadIds],
		),
	);

	const nodesById = new Map((fileNodesList ?? []).map((node) => [node._id, node] as const));
	const rows = build_pending_rows(
		pendingUpdatesResult.filter((view) => view.kind === "entry"),
		nodesById,
	);
	const restrictedRows = pendingUpdatesResult.filter((view) => view.kind === "restricted");
	// The counts and the empty state follow the rows the list draws, like the tab badge does.
	const shownSources = [
		...rows.filter((row) => !row.hasActiveChildDraft).map((row) => row.pendingUpdate),
		...restrictedRows.filter((view) => !view.hasActiveChildDraft),
	];
	const protectedDescendantIds = files_collect_protected_descendant_ids(fileNodesList ?? []);

	// The server checks hidden nodes and current policies again when Accept runs.
	const getNodeCapabilities = (node: files_VisibleTreeNode | undefined) => {
		if (!node) {
			return null;
		}

		const parent = node.parentId === files_ROOT_ID ? undefined : nodesById.get(node.parentId);
		// A missing parent is the workspace root, or a node this list cannot see. Accept still
		// re-checks the live parent on the server.
		const parentCanWrite = parent ? parent.canWrite : true;

		return files_get_read_only_capabilities({
			canWrite: node.canWrite,
			parentCanWrite,
			hasVisibleProtectedDescendant: protectedDescendantIds.has(node._id),
		});
	};

	// Accept saves a draft's pending parent folders with it. So check canAcceptWithParents, not
	// canAccept, which is false while a parent folder is pending.
	const canAcceptRow = (row: FileEditorSidebarPendingRow) => {
		if (!row.canAcceptWithParents || row.readiness !== "ready") {
			return false;
		}
		if (row.pendingUpdate.target.kind === "private") return true;

		const node = nodesById.get(row.pendingUpdate.target.id);
		const capabilities = getNodeCapabilities(node);

		if (!node || !capabilities?.canEditContent) {
			return false;
		}

		if (row.kind === "delete" && !capabilities.canArchiveOrRestore) {
			return false;
		}
		if ((row.kind === "move" || row.kind === "content_and_move") && !capabilities.canRelocateOrRename) {
			return false;
		}

		const destinationParent = row.pendingUpdate.pendingMove?.destParent;
		if (destinationParent?.kind === "saved") {
			if (!getNodeCapabilities(nodesById.get(destinationParent.id))?.canReceiveChildren) {
				return false;
			}
		}

		for (const affectedNodeId of [row.replacedNodeId, row.sizeOnlyReplacedNodeId]) {
			if (affectedNodeId && !getNodeCapabilities(nodesById.get(affectedNodeId))?.canArchiveOrRestore) {
				return false;
			}
		}

		return true;
	};

	const sortedThreadIds = [...threadIds].sort((leftThreadId, rightThreadId) => {
		const leftThread = threadQueryResults[leftThreadId];
		const rightThread = threadQueryResults[rightThreadId];
		const leftUpdatedAt =
			leftThread && !(leftThread instanceof Error) ? (leftThread.lastMessageAt ?? leftThread.updatedAt) : -Infinity;
		const rightUpdatedAt =
			rightThread && !(rightThread instanceof Error) ? (rightThread.lastMessageAt ?? rightThread.updatedAt) : -Infinity;
		return rightUpdatedAt - leftUpdatedAt || leftThreadId.localeCompare(rightThreadId);
	});
	const allSourceOptions: FileEditorSidebarPendingSourceOption[] = [
		{
			value: PENDING_SOURCE_ALL,
			label: "All changes",
			description: pendingUpdatesStatus === "Exhausted" ? "Every pending change" : "Loaded pending changes",
			count: shownSources.length,
		},
		{
			value: PENDING_SOURCE_USER,
			label: "Your edits",
			description: "Changes you made in the editor, not from a chat",
			count: shownSources.filter((row) => pending_row_matches_source(row, PENDING_SOURCE_USER)).length,
		},
		...sortedThreadIds.map((threadId) => {
			const thread = threadQueryResults[threadId];
			const count = shownSources.filter((row) => pending_row_matches_source(row, threadId)).length;

			if (thread === undefined) {
				return { value: threadId, label: "Loading chat…", description: "Agent chat", count };
			}
			if (thread instanceof Error || thread === null) {
				return { value: threadId, label: "Unavailable chat", description: "This chat is no longer available", count };
			}

			const lastMessageAt = thread.lastMessageAt ?? thread.updatedAt;
			return {
				value: threadId,
				label: thread.title || "New Chat",
				description: `${thread.archived ? "Archived · " : ""}Last message ${format_datetime(lastMessageAt)}`,
				count,
			};
		}),
	];
	// Sources with no pending changes are hidden (only All changes always stays), so a selected
	// source that empties falls back to All changes.
	const sourceOptions = allSourceOptions.filter((option) => option.value === PENDING_SOURCE_ALL || option.count > 0);
	// Build loaded rows before filtering. The server checks unloaded dependencies again on Accept.
	// One row can still appear under several contributing chats.
	const activeSource = sourceOptions.some((option) => option.value === selectedSource)
		? selectedSource
		: PENDING_SOURCE_ALL;
	const sourceRows = rows.filter((row) => pending_row_matches_source(row.pendingUpdate, activeSource));
	const sourceRestrictedRows = restrictedRows.filter((row) => pending_row_matches_source(row, activeSource));
	const shownRows = sourceRows.filter((row) => !row.hasActiveChildDraft);
	const shownRestrictedRows = sourceRestrictedRows.filter((view) => !view.hasActiveChildDraft);
	const canAcceptAllShownRows =
		shownRows.length > 0 && shownRestrictedRows.length === 0 && shownRows.every(canAcceptRow);

	useEffect(() => {
		if (selectedSource !== activeSource) {
			setSelectedSource(PENDING_SOURCE_ALL);
		}
	}, [selectedSource, activeSource]);

	// A hidden folder draft goes with the drafts inside it. So Accept all sends each shown draft's
	// pending parent folders first, like row Accept.
	const handleAcceptAll = useFn(() => {
		if (isBulkBusy || !canAcceptAllShownRows) return;
		const acceptRows = shownRows.filter((row) => !row.isStale);
		if (acceptRows.length < shownRows.length) toast.warning(PENDING_ACCEPT_ALL_SKIPS_REVIEW_MESSAGE);
		if (acceptRows.length === 0) return;
		const parentsById = new Map(
			acceptRows.flatMap((row) => row.requiredParents.map((parent) => [parent.pendingUpdateId, parent] as const)),
		);
		setIsSubmitting(true);
		startReview({
			kind: "accept",
			items: [
				...[...parentsById.values()].map((parent) => ({
					pendingUpdateId: parent.pendingUpdateId,
					reviewedRevision: parent.reviewedRevision,
					selectedContentStateId: null,
				})),
				...acceptRows.map(({ pendingUpdate }) => ({
					pendingUpdateId: pendingUpdate._id,
					reviewedRevision: pendingUpdate.revision,
					selectedContentStateId:
						pendingUpdate.pendingArchive || pendingUpdate.pendingReplacement
							? null
							: (pendingUpdate.content?.unstagedStateId ?? null),
				})),
			],
		})
			.then(() => announceActionSuccess(`Started accepting ${acceptRows.length} pending changes`))
			.catch((error: unknown) => {
				toast.error(error instanceof Error ? error.message : "Failed to start review");
			})
			.finally(() => setIsSubmitting(false));
	});

	// Discard all sends a hidden folder of this source only when a shown draft inside it is
	// discarded too. A loaded draft that stays, for example another chat's draft, keeps its folders.
	// The server would refuse to discard a folder that still holds such a draft or folder.
	const handleDiscardAll = useFn(() => {
		if (isBulkBusy) return;
		const sourcePendingUpdateIds = new Set(sourceRows.map((row) => row.pendingUpdate._id));
		const keptParentIds = new Set(
			rows
				.filter((row) => !row.hasActiveChildDraft && !shownRows.includes(row))
				.flatMap((row) => row.requiredParents.map((parent) => parent.pendingUpdateId)),
		);
		// A parent folder of another source stays. So every folder above it stays too, because it
		// holds that folder. `requiredParents` is root-first.
		for (const row of shownRows) {
			const parentIds = row.requiredParents.map((parent) => parent.pendingUpdateId);
			const deepestKeptIndex = parentIds.findLastIndex((parentId) => !sourcePendingUpdateIds.has(parentId));
			for (const parentId of parentIds.slice(0, deepestKeptIndex + 1)) keptParentIds.add(parentId);
		}
		const discardParentIds = new Set(
			shownRows
				.flatMap((row) => row.requiredParents.map((parent) => parent.pendingUpdateId))
				.filter((pendingUpdateId) => !keptParentIds.has(pendingUpdateId)),
		);
		setIsSubmitting(true);
		startReview({
			kind: "discard",
			items: [
				...sourceRows
					.filter((row) => !row.hasActiveChildDraft || discardParentIds.has(row.pendingUpdate._id))
					.map(({ pendingUpdate }) => ({
						pendingUpdateId: pendingUpdate._id,
						reviewedRevision: pendingUpdate.revision,
						selectedContentStateId: null,
					})),
				...shownRestrictedRows.map((view) => ({
					pendingUpdateId: view.pendingUpdateId,
					reviewedRevision: view.revision,
					selectedContentStateId: null,
				})),
			],
		})
			.then(() =>
				announceActionSuccess(`Started discarding ${shownRows.length + shownRestrictedRows.length} pending changes`),
			)
			.catch((error: unknown) => {
				toast.error(error instanceof Error ? error.message : "Failed to start review");
			})
			.finally(() => setIsSubmitting(false));
	});

	// The status span stays first in both branches so React keeps the same DOM node (and its
	// pending announcement) when accepting the last row switches the panel to the empty state.
	const statusElement = (
		<span
			ref={statusRef}
			role="status"
			className={cn("FileEditorSidebarPending-status" satisfies FileEditorSidebarPending_ClassNames, "sr-only")}
		/>
	);
	const paginationControl =
		pendingUpdatesStatus !== "Exhausted" && pendingUpdatesStatus !== "LoadingFirstPage" ? (
			<MyButton
				variant="ghost"
				disabled={isBulkBusy || pendingUpdatesStatus === "LoadingMore"}
				onClick={() => loadMore(20)}
			>
				{pendingUpdatesStatus === "LoadingMore" ? "Loading more…" : "Load more pending changes"}
			</MyButton>
		) : null;

	if (pendingUpdatesStatus === "LoadingFirstPage" || shownSources.length === 0) {
		return (
			<>
				{statusElement}
				<div
					// A removed row hands focus back to this panel, so the panel must be focusable.
					// Saving the last row switches to this empty state, so focus lands right here.
					tabIndex={-1}
					aria-label="Pending changes"
					// Keep the root class here too. It owns the pinned viewport-sized box, and the
					// sticky rule in `file-node-view.css` matches this one class for both states.
					className={cn(
						"FileEditorSidebarPending" satisfies FileEditorSidebarPending_ClassNames,
						"FileEditorSidebarPending-empty" satisfies FileEditorSidebarPending_ClassNames,
					)}
				>
					{pendingUpdatesStatus === "LoadingFirstPage"
						? "Loading pending changes…"
						: pendingUpdatesStatus === "Exhausted"
							? "No pending changes"
							: "No changes on the loaded pages"}
					{paginationControl}
				</div>
			</>
		);
	}

	return (
		<>
			{statusElement}
			<div
				className={cn(
					"FileEditorSidebarPending" satisfies FileEditorSidebarPending_ClassNames,
					"app-scrollable" satisfies AppClassName,
				)}
				role="region"
				aria-label="Pending changes"
				// A removed row hands focus back to this panel, so the panel must be focusable.
				tabIndex={-1}
			>
				<div className={cn("FileEditorSidebarPending-header" satisfies FileEditorSidebarPending_ClassNames)}>
					<FileEditorSidebarPendingSourceSelect
						value={activeSource}
						options={sourceOptions}
						onValueChange={setSelectedSource}
					/>
					<div className={cn("FileEditorSidebarPending-header-actions" satisfies FileEditorSidebarPending_ClassNames)}>
						<MyButton
							variant="ghost"
							className={cn(
								"FileEditorSidebarPending-header-button" satisfies FileEditorSidebarPending_ClassNames,
								"FileEditorSidebarPending-accept" satisfies FileEditorSidebarPending_ClassNames,
							)}
							aria-label="Accept all shown pending changes"
							tooltip={shownRows.some((row) => row.isStale) ? PENDING_ACCEPT_ALL_SKIPS_REVIEW_MESSAGE : undefined}
							aria-busy={isBulkBusy}
							disabled={!canAcceptAllShownRows}
							aria-disabled={isBulkBusy}
							onClick={handleAcceptAll}
						>
							<MyButtonIcon
								className={cn("FileEditorSidebarPending-header-icon" satisfies FileEditorSidebarPending_ClassNames)}
							>
								<CheckCheck />
							</MyButtonIcon>
							Accept all
						</MyButton>
						<MyButton
							variant="ghost_destructive"
							className={cn("FileEditorSidebarPending-header-button" satisfies FileEditorSidebarPending_ClassNames)}
							aria-label="Discard all shown pending changes"
							aria-busy={isBulkBusy}
							aria-disabled={isBulkBusy}
							onClick={handleDiscardAll}
						>
							<MyButtonIcon
								className={cn("FileEditorSidebarPending-header-icon" satisfies FileEditorSidebarPending_ClassNames)}
							>
								<Trash2 />
							</MyButtonIcon>
							Discard all
						</MyButton>
					</div>
				</div>
				{pendingUpdatesStatus !== "Exhausted" ? <p>Actions apply to the changes shown below.</p> : null}
				<ul className={cn("FileEditorSidebarPending-list" satisfies FileEditorSidebarPending_ClassNames)}>
					{shownRows.map((row) => (
						<FileEditorSidebarPendingItem
							key={row.pendingUpdate._id}
							pendingUpdate={row.pendingUpdate}
							path={row.path}
							kind={row.kind}
							moveDestinationPath={row.moveDestinationPath}
							replacedNodeId={row.replacedNodeId}
							sizeOnlyReplacedNodeId={row.sizeOnlyReplacedNodeId}
							canPreviewDeleteDiff={row.canPreviewDeleteDiff}
							isAddedFile={row.isAddedFile}
							isFolder={row.isFolder}
							readiness={row.readiness}
							recovery={row.recovery}
							copyDestination={row.copyDestination}
							isArchived={row.isArchived}
							rootKind={row.rootKind}
							isStale={row.isStale}
							requiredParents={row.requiredParents}
							privateEntry={row.privateEntry}
							canAccept={canAcceptRow(row)}
							disabled={isBulkBusy}
							onActionSuccess={announceActionSuccess}
						/>
					))}
					{shownRestrictedRows.map((view) => (
						<FileEditorSidebarPendingRestrictedItem
							key={view.pendingUpdateId}
							view={view}
							disabled={isBulkBusy}
							onActionSuccess={announceActionSuccess}
						/>
					))}
				</ul>
				{paginationControl}
			</div>
		</>
	);
});
// #endregion root

// #region tests
// The NODE_ENV check comes first so client builds erase this block; `import.meta.vitest` is
// only defined when vitest runs this file.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	const makePendingUpdate = (args: {
		id: string;
		fileNodeId: string;
		staged?: string;
		unstaged?: string;
		pendingMove?: { destParentId: string; destName: string; fromPath: string; replacesNodeId?: string };
		copiedFrom?: { nodeId: string; path: string };
		isPrivate?: boolean;
		pendingArchive?: { fromPath: string };
		/**
		 * A proposal on a file with collaboration off stores the asset it was built from.
		 */
		baseAssetId?: string;
	}) =>
		({
			_id: args.id,
			target: { kind: args.isPrivate ? "private" : "saved", id: args.fileNodeId },
			revision: 1,
			// Move-only docs leave the whole canonical content group unset, like the server does.
			...(args.staged != null && args.unstaged != null
				? {
						content: {
							base: args.baseAssetId
								? { kind: "asset", assetId: args.baseAssetId }
								: { kind: "yjs", sequence: 0, lineageGeneration: 0 },
							baseStateId: `${args.id}_base`,
							stagedStateId: `${args.id}_staged`,
							unstagedStateId: `${args.id}_unstaged`,
						},
					}
				: {}),
			...(args.pendingMove
				? {
						pendingMove: {
							destParent:
								args.pendingMove.destParentId === "root"
									? { kind: "root" }
									: { kind: "saved", id: args.pendingMove.destParentId },
							destName: args.pendingMove.destName,
							fromPath: args.pendingMove.fromPath,
							...(args.pendingMove.replacesNodeId
								? { replacesTarget: { kind: "saved", id: args.pendingMove.replacesNodeId } }
								: {}),
						},
					}
				: {}),
			...(args.copiedFrom
				? { copiedFrom: { target: { kind: "saved", id: args.copiedFrom.nodeId }, path: args.copiedFrom.path } }
				: {}),
			...(args.isPrivate
				? {
						createIntent: {
							kind: "text",
							contentType: "text/plain",
							textKind: "plain_text",
							collaborationEnabled: true,
							metadata: [],
						},
					}
				: {}),
			...(args.pendingArchive ? { pendingArchive: args.pendingArchive } : {}),
		}) as unknown as app_convex_Doc<"files_pending_updates">;

	const makeNode = (args: {
		id: string;
		path: string;
		kind?: "file" | "folder";
		parentId?: string;
		/**
		 * A text file with collaboration off, like `list_tree` returns it, with the asset `asset_<id>`.
		 */
		nonCollaborative?: boolean;
		textKind?: "rich_text" | "plain_text";
	}) =>
		({
			_id: args.id,
			path: args.path,
			name: args.path.split("/").pop() ?? args.path,
			kind: args.kind ?? "file",
			parentId: args.parentId ?? "root",
			archiveOperationId: null,
			assetId: null,
			contentType: null,
			textKind: args.textKind ?? null,
			collaborationEnabled: args.textKind ? !args.nonCollaborative : null,
			yjsSnapshotId: null,
			yjsLastSequenceId: null,
			...(args.nonCollaborative ? { assetId: `asset_${args.id}`, contentType: "text/markdown" } : {}),
		}) as unknown as app_convex_Doc<"files_nodes">;

	const makeNodesById = (nodes: app_convex_Doc<"files_nodes">[]) =>
		new Map(nodes.map((node) => [node._id, node] as const));

	const buildFixtureRows = (
		updates: app_convex_Doc<"files_pending_updates">[],
		nodesById: ReturnType<typeof makeNodesById>,
	) => {
		const views = updates.flatMap((pendingUpdate): Extract<FileEditorSidebarPendingView, { kind: "entry" }>[] => {
			const node = [...nodesById.values()].find((node) => node._id === pendingUpdate.target.id);
			if (!node) return [];
			const move = pendingUpdate.pendingMove;
			const parentPath = move?.destParent.kind === "saved" ? nodesById.get(move.destParent.id)?.path : "";
			const path = move ? `${parentPath}/${move.destName}` : node.path;
			if (pendingUpdate.target.kind === "private") {
				return [
					{
						kind: "entry",
						entry: {
							kind: "private",
							node: {
								_id: pendingUpdate.target.id,
								_creationTime: 0,
								organizationId: pendingUpdate.organizationId,
								workspaceId: pendingUpdate.workspaceId,
								userId: pendingUpdate.userId,
								kind: node.kind,
								name: node.name,
								parent: { kind: "root" },
								structuralRevision: 1,
								creationGeneration: 1,
								state: "active",
								closedAt: null,
							},
							pendingUpdate,
							path,
						},
						readiness: "ready",
						canEdit: true,
						canAccept: true,
						canAcceptWithParents: true,
						requiredParents: [],
						savedParentId: null,
						hasActiveChildDraft: false,
					},
				];
			}
			return [
				{
					kind: "entry",
					entry: { kind: "saved", node, pendingUpdate, path },
					readiness: "ready",
					canEdit: true,
					canAccept: true,
					canAcceptWithParents: true,
					requiredParents: [],
					savedParentId: null,
					hasActiveChildDraft: false,
				},
			];
		});
		return build_pending_rows(views, nodesById);
	};

	describe("build_pending_rows", () => {
		test("sorts rows by path regardless of input order", () => {
			const updates = [
				makePendingUpdate({ id: "pu_z", fileNodeId: "node_z", staged: "s", unstaged: "u" }),
				makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
				makePendingUpdate({ id: "pu_m", fileNodeId: "node_m", staged: "s", unstaged: "u" }),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_z", path: "zebra/notes.md" }),
				makeNode({ id: "node_a", path: "alpha/intro.md" }),
				makeNode({ id: "node_m", path: "mid/readme.md" }),
			]);

			const rows = buildFixtureRows(updates, nodesById);

			expect(rows.map((row) => row.path)).toEqual(["alpha/intro.md", "mid/readme.md", "zebra/notes.md"]);
		});

		test("uses the readable owner entry before the saved tree loads", () => {
			const pendingUpdate = makePendingUpdate({ id: "pu_x", fileNodeId: "node_x", staged: "s", unstaged: "u" });
			const node = makeNode({ id: "node_x", path: "/owned.md" });
			const rows = build_pending_rows(
				[
					{
						kind: "entry",
						entry: { kind: "saved", node, pendingUpdate, path: "/owned.md" },
						readiness: "ready",
						canEdit: true,
						canAccept: true,
						canAcceptWithParents: true,
						requiredParents: [],
						savedParentId: null,
						hasActiveChildDraft: false,
					},
				],
				new Map(),
			);

			expect(rows).toHaveLength(1);
			expect(rows[0]?.path).toBe("/owned.md");
		});

		test("keeps the server's flag for a folder draft that holds a draft", () => {
			const pendingUpdate = makePendingUpdate({ id: "pu_folder", fileNodeId: "private_folder", isPrivate: true });
			const [row] = build_pending_rows(
				[
					{
						kind: "entry",
						entry: {
							kind: "private",
							node: {
								_id: "private_folder",
								kind: "folder",
								name: "qa",
								parent: { kind: "root" },
							} as unknown as app_convex_Doc<"files_pending_nodes">,
							pendingUpdate,
							path: "/qa",
						},
						readiness: "ready",
						canEdit: true,
						canAccept: true,
						canAcceptWithParents: true,
						requiredParents: [],
						savedParentId: null,
						hasActiveChildDraft: true,
					},
				],
				new Map(),
			);

			expect(row).toMatchObject({ path: "/qa", isFolder: true, hasActiveChildDraft: true });
		});

		test("builds a content row with the node's shape for a proposal on a file with collaboration off", () => {
			const updates = [
				makePendingUpdate({
					id: "pu_off",
					fileNodeId: "node_off",
					staged: "s",
					unstaged: "u",
					baseAssetId: "asset_node_off",
				}),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_off", path: "/off.md", nonCollaborative: true, textKind: "plain_text" }),
			]);

			const rows = buildFixtureRows(updates, nodesById);

			expect(rows[0]).toMatchObject({ kind: "content", rootKind: "plain_text", isStale: false });
		});

		test("marks the proposal stale once the node's asset is not the one it was built from", () => {
			const updates = [
				makePendingUpdate({ id: "pu_off", fileNodeId: "node_off", staged: "s", unstaged: "u", baseAssetId: "asset_1" }),
				makePendingUpdate({
					id: "pu_gone",
					fileNodeId: "node_missing",
					staged: "s",
					unstaged: "u",
					baseAssetId: "asset_1",
				}),
				makePendingUpdate({
					id: "pu_delete",
					fileNodeId: "node_off_deleted",
					staged: "s",
					unstaged: "u",
					baseAssetId: "asset_1",
					pendingArchive: { fromPath: "/off-deleted.md" },
				}),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_off", path: "/off.md", nonCollaborative: true, textKind: "rich_text" }),
				makeNode({ id: "node_off_deleted", path: "/off-deleted.md", nonCollaborative: true, textKind: "rich_text" }),
			]);

			const rows = buildFixtureRows(updates, nodesById);

			expect(rows.find((row) => row.pendingUpdate._id === "pu_off")?.isStale).toBe(true);
			// Restricted drafts are separate rows without file details.
			expect(rows.find((row) => row.pendingUpdate._id === "pu_gone")).toBeUndefined();
			// Accepting a delete ignores the content branches, so stale content does not block it.
			expect(rows.find((row) => row.pendingUpdate._id === "pu_delete")).toMatchObject({
				kind: "delete",
				isStale: false,
			});
		});

		test("derives row kinds from field presence", () => {
			const pendingMove = { destParentId: files_ROOT_ID, destName: "dest.md", fromPath: "/from.md" };
			const updates = [
				makePendingUpdate({ id: "pu_content", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
				makePendingUpdate({ id: "pu_move", fileNodeId: "node_b", pendingMove }),
				makePendingUpdate({
					id: "pu_copy",
					fileNodeId: "node_c",
					staged: "s",
					unstaged: "u",
					copiedFrom: { nodeId: "node_src", path: "/source.md" },
				}),
				makePendingUpdate({ id: "pu_mixed", fileNodeId: "node_d", staged: "s", unstaged: "u", pendingMove }),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_a", path: "/a.md" }),
				makeNode({ id: "node_b", path: "/b.md" }),
				makeNode({ id: "node_c", path: "/c.md" }),
				makeNode({ id: "node_d", path: "/d.md" }),
			]);

			const rows = buildFixtureRows(updates, nodesById);

			expect(rows.map((row) => row.kind)).toEqual(["content", "move", "copy", "content_and_move"]);
		});

		test("uses the owner's current move destination path", () => {
			const updates = [
				makePendingUpdate({
					id: "pu_root",
					fileNodeId: "node_a",
					pendingMove: { destParentId: files_ROOT_ID, destName: "a.md", fromPath: "/from/a.md" },
				}),
				makePendingUpdate({
					id: "pu_nested",
					fileNodeId: "node_b",
					pendingMove: { destParentId: "node_docs", destName: "b.md", fromPath: "/from/b.md" },
				}),
				makePendingUpdate({
					id: "pu_missing",
					fileNodeId: "node_c",
					pendingMove: { destParentId: "node_gone", destName: "c.md", fromPath: "/from/c.md" },
				}),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_a", path: "/from/a.md" }),
				makeNode({ id: "node_b", path: "/from/b.md" }),
				makeNode({ id: "node_c", path: "/from/c.md" }),
				makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
				makeNode({ id: "node_gone", path: "/other", kind: "folder" }),
			]);

			const rows = buildFixtureRows(updates, nodesById);

			expect(rows.map((row) => row.moveDestinationPath)).toEqual(["/a.md", "/docs/b.md", "/other/c.md"]);
		});

		test("does not include a restricted move in readable rows", () => {
			const updates = [
				makePendingUpdate({
					id: "pu_folder",
					fileNodeId: "node_folder",
					pendingMove: { destParentId: files_ROOT_ID, destName: "archive", fromPath: "/old-archive" },
				}),
				makePendingUpdate({
					id: "pu_gone",
					fileNodeId: "node_gone",
					pendingMove: { destParentId: files_ROOT_ID, destName: "gone.md", fromPath: "/from/gone.md" },
				}),
			];
			const nodesById = makeNodesById([makeNode({ id: "node_folder", path: "/old-archive", kind: "folder" })]);

			const rows = buildFixtureRows(updates, nodesById);

			expect(rows.map((row) => row.path)).toEqual(["/old-archive"]);
		});

		test("derives the replaced occupant id for move rows from live path occupancy only", () => {
			const updates = [
				// Destination occupied by another file → its id.
				makePendingUpdate({
					id: "pu_occupied",
					fileNodeId: "node_m1",
					pendingMove: { destParentId: files_ROOT_ID, destName: "taken.md", fromPath: "/m1.md" },
				}),
				// Free destination → no indicator.
				makePendingUpdate({
					id: "pu_free",
					fileNodeId: "node_m2",
					pendingMove: { destParentId: files_ROOT_ID, destName: "free.md", fromPath: "/m2.md" },
				}),
				// Destination resolves to the node itself → no indicator.
				makePendingUpdate({
					id: "pu_self",
					fileNodeId: "node_m3",
					pendingMove: { destParentId: files_ROOT_ID, destName: "m3.md", fromPath: "/old-m3.md" },
				}),
				// Declared replace target left the destination path and nothing else occupies it →
				// accept archives nothing, so no indicator.
				makePendingUpdate({
					id: "pu_declared",
					fileNodeId: "node_m4",
					pendingMove: {
						destParentId: files_ROOT_ID,
						destName: "somewhere.md",
						fromPath: "/m4.md",
						replacesNodeId: "node_declared",
					},
				}),
				// Declared target gone and the destination free → degrades to a plain move.
				makePendingUpdate({
					id: "pu_declared_gone",
					fileNodeId: "node_m5",
					pendingMove: {
						destParentId: files_ROOT_ID,
						destName: "vacant.md",
						fromPath: "/m5.md",
						replacesNodeId: "node_gone",
					},
				}),
				// Empty folder occupant: folder-onto-EMPTY-folder follows rename() semantics → its id.
				makePendingUpdate({
					id: "pu_folder_move",
					fileNodeId: "node_m6",
					pendingMove: { destParentId: files_ROOT_ID, destName: "taken-folder", fromPath: "/m6" },
				}),
				// Non-empty folder occupant: never replaced → no indicator.
				makePendingUpdate({
					id: "pu_folder_move_full",
					fileNodeId: "node_m8",
					pendingMove: { destParentId: files_ROOT_ID, destName: "full-folder", fromPath: "/m8" },
				}),
				// Folder occupant with no committed children but another pending move targeting
				// INTO it: accept-time validation counts that as occupancy → no indicator.
				makePendingUpdate({
					id: "pu_folder_move_claimed",
					fileNodeId: "node_m9",
					pendingMove: { destParentId: files_ROOT_ID, destName: "claimed-folder", fromPath: "/m9" },
				}),
				makePendingUpdate({
					id: "pu_into_claimed",
					fileNodeId: "node_incoming",
					pendingMove: { destParentId: "node_claimed_folder", destName: "incoming.md", fromPath: "/incoming.md" },
				}),
				// Occupant with its own pending move by the same user: accept forces that move
				// first, so nothing is left at the destination to replace → no indicator.
				makePendingUpdate({
					id: "pu_chained",
					fileNodeId: "node_m7",
					pendingMove: { destParentId: files_ROOT_ID, destName: "vacating.md", fromPath: "/m7.md" },
				}),
				makePendingUpdate({
					id: "pu_vacating",
					fileNodeId: "node_vacating",
					pendingMove: { destParentId: files_ROOT_ID, destName: "elsewhere.md", fromPath: "/vacating.md" },
				}),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_m1", path: "/m1.md" }),
				makeNode({ id: "node_m2", path: "/m2.md" }),
				makeNode({ id: "node_m3", path: "/m3.md" }),
				makeNode({ id: "node_m4", path: "/m4.md" }),
				makeNode({ id: "node_m5", path: "/m5.md" }),
				makeNode({ id: "node_m6", path: "/m6", kind: "folder" }),
				makeNode({ id: "node_m7", path: "/m7.md" }),
				makeNode({ id: "node_m8", path: "/m8", kind: "folder" }),
				makeNode({ id: "node_m9", path: "/m9", kind: "folder" }),
				makeNode({ id: "node_incoming", path: "/incoming.md" }),
				makeNode({ id: "node_claimed_folder", path: "/claimed-folder", kind: "folder" }),
				makeNode({ id: "node_vacating", path: "/vacating.md" }),
				makeNode({ id: "node_taken", path: "/taken.md" }),
				makeNode({ id: "node_declared", path: "/renamed-target.md" }),
				makeNode({ id: "node_taken_folder", path: "/taken-folder", kind: "folder" }),
				makeNode({ id: "node_full_folder", path: "/full-folder", kind: "folder" }),
				makeNode({ id: "node_full_child", path: "/full-folder/keep.md", parentId: "node_full_folder" }),
			]);

			const rows = buildFixtureRows(updates, nodesById);

			expect(rows.map((row) => [row.path, row.replacedNodeId])).toEqual([
				["/incoming.md", undefined],
				["/m1.md", "node_taken"],
				["/m2.md", undefined],
				["/m3.md", undefined],
				["/m4.md", undefined],
				["/m5.md", undefined],
				["/m6", "node_taken_folder"],
				["/m7.md", undefined],
				["/m8", undefined],
				["/m9", undefined],
				["/vacating.md", undefined],
			]);
		});

		test("marks delete rows and lets the delete win over other kinds", () => {
			const updates = [
				// Delete-only doc on a file.
				makePendingUpdate({ id: "pu_del", fileNodeId: "node_a", pendingArchive: { fromPath: "/a.md" } }),
				// Content branches survive an rm on an edited file; the row still shows as delete.
				makePendingUpdate({
					id: "pu_del_content",
					fileNodeId: "node_b",
					staged: "s",
					unstaged: "u",
					pendingArchive: { fromPath: "/b.md" },
				}),
				// Folder deletes always render as plain rows.
				makePendingUpdate({ id: "pu_del_folder", fileNodeId: "node_f", pendingArchive: { fromPath: "/f" } }),
				// Restricted drafts are returned separately without their old paths.
				makePendingUpdate({ id: "pu_del_gone", fileNodeId: "node_gone", pendingArchive: { fromPath: "/gone.md" } }),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_a", path: "/a.md" }),
				makeNode({ id: "node_b", path: "/b.md" }),
				makeNode({ id: "node_f", path: "/f", kind: "folder" }),
			]);

			const rows = buildFixtureRows(updates, nodesById);

			expect(rows.map((row) => [row.path, row.kind])).toEqual([
				["/a.md", "delete"],
				["/b.md", "delete"],
				["/f", "delete"],
			]);
		});

		test("marks rows whose proposal created the file as added", () => {
			const updates = [
				makePendingUpdate({
					id: "pu_added",
					fileNodeId: "node_a",
					staged: "s",
					unstaged: "u",
					isPrivate: true,
				}),
				makePendingUpdate({ id: "pu_edit", fileNodeId: "node_b", staged: "s", unstaged: "u" }),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_a", path: "/a.md" }),
				makeNode({ id: "node_b", path: "/b.md" }),
			]);

			const rows = buildFixtureRows(updates, nodesById);

			expect(rows.map((row) => row.isAddedFile)).toEqual([true, false]);
		});
	});
}
// #endregion tests
