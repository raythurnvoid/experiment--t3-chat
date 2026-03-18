import "./page-editor-snapshots-modal.css";

import { memo, useEffect, useState, type Dispatch, type MouseEvent, type SetStateAction } from "react";
import { useMutation, useQuery } from "convex/react";
import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Clock, FileText } from "lucide-react";
import { diffWordsWithSpace } from "diff";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { format_relative_time } from "@/lib/date.ts";
import { useUiId } from "@/lib/ui.tsx";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, cn, should_never_happen } from "@/lib/utils.ts";
import { MyButton, MyButtonIcon } from "../my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "../my-icon-button.tsx";
import { MyLabel } from "../my-label.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "../my-modal.tsx";
import { MySkeleton } from "../my-skeleton.tsx";
import { MySwitch } from "../my-switch.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "../my-tooltip.tsx";
import { useStableQuery } from "@/hooks/convex-hooks.ts";

type PageEditorSnapshotsModal_UserRecord = {
	displayName?: string;
};

type PageEditorSnapshotsModal_UsersDict = Record<string, PageEditorSnapshotsModal_UserRecord | undefined>;

type PageEditorSnapshotsModal_ListSnapshot = {
	_id: app_convex_Id<"pages_snapshots">;
	_creationTime: number;
	created_by: string;
	is_archived?: boolean;
};

type PageEditorSnapshotsModal_ListQueryResult = {
	snapshots: PageEditorSnapshotsModal_ListSnapshot[];
	usersDict: PageEditorSnapshotsModal_UsersDict;
};

type PageEditorSnapshotsModal_PreviewSnapshotContent = {
	_creationTime: number;
	content: string;
	created_by: string;
	usersDict?: PageEditorSnapshotsModal_UsersDict;
};

const SNAPSHOT_SKELETON_ROW_COUNT = 10;
const PREVIEW_SKELETON_ROW_COUNT = 20;
const LOADING_SKELETON_DELAY_MS = 150;

function useDelayedLoadingState(isLoading: boolean, delayMs = LOADING_SKELETON_DELAY_MS) {
	const [showDelayedLoadingState, setShowDelayedLoadingState] = useState(false);

	useEffect(() => {
		if (!isLoading) {
			setShowDelayedLoadingState(false);
			return;
		}

		const timeoutId = window.setTimeout(() => {
			setShowDelayedLoadingState(true);
		}, delayMs);

		return () => {
			window.clearTimeout(timeoutId);
		};
	}, [delayMs, isLoading]);

	return showDelayedLoadingState;
}

// #region skeleton
type PageEditorSnapshotsModalSkeleton_ClassNames =
	| "PageEditorSnapshotsModalSkeleton-list"
	| "PageEditorSnapshotsModalSkeleton-list-item"
	| "PageEditorSnapshotsModalSkeleton-preview-snapshot-data"
	| "PageEditorSnapshotsModalSkeleton-preview-body";

type PageEditorSnapshotsModalSkeletonList_Props = {
	rowCount?: number;
};

const PageEditorSnapshotsModalSkeletonList = memo(function PageEditorSnapshotsModalSkeletonList(
	props: PageEditorSnapshotsModalSkeletonList_Props,
) {
	const { rowCount = SNAPSHOT_SKELETON_ROW_COUNT } = props;

	return (
		<div className={cn("PageEditorSnapshotsModalSkeleton-list" satisfies PageEditorSnapshotsModalSkeleton_ClassNames)}>
			{Array.from({ length: rowCount }, (_, index) => (
				<MySkeleton
					key={index}
					className={cn(
						"PageEditorSnapshotsModalSkeleton-list-item" satisfies PageEditorSnapshotsModalSkeleton_ClassNames,
					)}
				/>
			))}
		</div>
	);
});

type PageEditorSnapshotsModalSkeletonPreviewModalSnapshotData_Props = {
	rowCount?: number;
};

const PageEditorSnapshotsModalSkeletonPreviewModalSnapshotData = memo(
	function PageEditorSnapshotsModalSkeletonPreviewModalSnapshotData(
		props: PageEditorSnapshotsModalSkeletonPreviewModalSnapshotData_Props,
	) {
		const { rowCount = 3 } = props;

		return Array.from({ length: rowCount }, (_, index) => (
			<MySkeleton
				key={index}
				className={cn(
					"PageEditorSnapshotsModalSkeleton-preview-snapshot-data" satisfies PageEditorSnapshotsModalSkeleton_ClassNames,
				)}
			/>
		));
	},
);

type PageEditorSnapshotsModalSkeletonPreviewModalBody_Props = {
	rowCount?: number;
};

const PageEditorSnapshotsModalSkeletonPreviewModalBody = memo(function PageEditorSnapshotsModalSkeletonPreviewModalBody(
	props: PageEditorSnapshotsModalSkeletonPreviewModalBody_Props,
) {
	const { rowCount = PREVIEW_SKELETON_ROW_COUNT } = props;

	return Array.from({ length: rowCount }, (_, index) => (
		<MySkeleton
			key={index}
			className={cn(
				"PageEditorSnapshotsModalSkeleton-preview-body" satisfies PageEditorSnapshotsModalSkeleton_ClassNames,
			)}
		/>
	));
});
// #endregion skeleton

// #region list item
type PageEditorSnapshotsModalListItem_ClassNames =
	| "PageEditorSnapshotsModalListItem"
	| "PageEditorSnapshotsModalListItem-archived"
	| "PageEditorSnapshotsModalListItem-icon"
	| "PageEditorSnapshotsModalListItem-primary-button"
	| "PageEditorSnapshotsModalListItem-archived-label"
	| "PageEditorSnapshotsModalListItem-support-text"
	| "PageEditorSnapshotsModalListItem-actions"
	| "PageEditorSnapshotsModalListItem-action-button";

type PageEditorSnapshotsModalListItem_Props = {
	snapshot: PageEditorSnapshotsModal_ListSnapshot;
	userDisplayName: string;
	onClickArchive: (
		snapshotId: app_convex_Id<"pages_snapshots">,
		isArchived: boolean | undefined,
	) => void | Promise<void>;
	onClickSnapshot: (snapshotId: app_convex_Id<"pages_snapshots">) => void;
};

const PageEditorSnapshotsModalListItem = memo(function PageEditorSnapshotsModalListItem(
	props: PageEditorSnapshotsModalListItem_Props,
) {
	const { snapshot, userDisplayName, onClickArchive, onClickSnapshot } = props;

	const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;

		// Don't forward the click when you hit an interactive element inside the row.
		if (target.closest("button") || target.closest("a") || target.closest('[role="button"]')) {
			return;
		}

		onClickSnapshot(snapshot._id);
	};

	return (
		<div
			className={cn(
				"PageEditorSnapshotsModalListItem" satisfies PageEditorSnapshotsModalListItem_ClassNames,
				snapshot.is_archived &&
					("PageEditorSnapshotsModalListItem-archived" satisfies PageEditorSnapshotsModalListItem_ClassNames),
			)}
			onClick={handleRowClick}
		>
			<MyButtonIcon
				className={cn("PageEditorSnapshotsModalListItem-icon" satisfies PageEditorSnapshotsModalListItem_ClassNames)}
			>
				<FileText />
			</MyButtonIcon>
			<button
				type="button"
				className={cn(
					"PageEditorSnapshotsModalListItem-primary-button" satisfies PageEditorSnapshotsModalListItem_ClassNames,
				)}
				onClick={() => onClickSnapshot(snapshot._id)}
			>
				{format_relative_time(snapshot._creationTime)}
				{snapshot.is_archived && (
					<span
						className={cn(
							"PageEditorSnapshotsModalListItem-archived-label" satisfies PageEditorSnapshotsModalListItem_ClassNames,
						)}
					>
						{" - "}Archived
					</span>
				)}
			</button>
			<span
				className={cn(
					"PageEditorSnapshotsModalListItem-support-text" satisfies PageEditorSnapshotsModalListItem_ClassNames,
				)}
			>
				{userDisplayName}
			</span>
			<div
				className={cn(
					"PageEditorSnapshotsModalListItem-actions" satisfies PageEditorSnapshotsModalListItem_ClassNames,
				)}
			>
				<MyIconButton
					className={cn(
						"PageEditorSnapshotsModalListItem-action-button" satisfies PageEditorSnapshotsModalListItem_ClassNames,
					)}
					variant="ghost-highlightable"
					tooltip={snapshot.is_archived ? "Restore" : "Archive"}
					onClick={() => onClickArchive(snapshot._id, snapshot.is_archived)}
				>
					<MyIconButtonIcon>{snapshot.is_archived ? <ArchiveRestore /> : <Archive />}</MyIconButtonIcon>
				</MyIconButton>
			</div>
		</div>
	);
});
// #endregion list item

// #region list controls
type PageEditorSnapshotsModalListControls_ClassNames = "PageEditorSnapshotsModalListControls";

type PageEditorSnapshotsModalListControls_Props = {
	showArchived: boolean;
	showArchivedId: string;
	onCheckedChange: (checked: boolean) => void;
};

const PageEditorSnapshotsModalListControls = memo(function PageEditorSnapshotsModalListControls(
	props: PageEditorSnapshotsModalListControls_Props,
) {
	const { showArchived, showArchivedId, onCheckedChange } = props;

	return (
		<div className={cn("PageEditorSnapshotsModalListControls" satisfies PageEditorSnapshotsModalListControls_ClassNames)}>
			<MyLabel htmlFor={showArchivedId}>Show archived</MyLabel>
			<MySwitch id={showArchivedId} checked={showArchived} onCheckedChange={onCheckedChange} />
		</div>
	);
});
// #endregion list controls

// #region list
type PageEditorSnapshotsModalList_ClassNames =
	| "PageEditorSnapshotsModalList"
	| "PageEditorSnapshotsModalList-empty-message-container"
	| "PageEditorSnapshotsModalList-empty-message";

type PageEditorSnapshotsModalList_Props = {
	snapshotsQueryResult: PageEditorSnapshotsModal_ListQueryResult | undefined;
	showSkeletonWhenLoading: boolean;
	onClickArchive: (
		snapshotId: app_convex_Id<"pages_snapshots">,
		isArchived: boolean | undefined,
	) => void | Promise<void>;
	onClickSnapshot: (snapshotId: app_convex_Id<"pages_snapshots">) => void;
};

const PageEditorSnapshotsModalList = memo(function PageEditorSnapshotsModalList(props: PageEditorSnapshotsModalList_Props) {
	const { snapshotsQueryResult, showSkeletonWhenLoading, onClickArchive, onClickSnapshot } = props;

	if (snapshotsQueryResult === undefined) {
		if (!showSkeletonWhenLoading) {
			return null;
		}

		return <PageEditorSnapshotsModalSkeletonList />;
	}

	if (snapshotsQueryResult.snapshots.length === 0) {
		return (
			<div
				className={cn(
					"PageEditorSnapshotsModalList-empty-message-container" satisfies PageEditorSnapshotsModalList_ClassNames,
				)}
			>
				<div
					className={cn("PageEditorSnapshotsModalList-empty-message" satisfies PageEditorSnapshotsModalList_ClassNames)}
				>
					No snapshots yet
				</div>
			</div>
		);
	}

	return (
		<div className={cn("PageEditorSnapshotsModalList" satisfies PageEditorSnapshotsModalList_ClassNames)}>
			{snapshotsQueryResult.snapshots.map((snapshot) => (
				<PageEditorSnapshotsModalListItem
					key={snapshot._id}
					snapshot={snapshot}
					userDisplayName={snapshotsQueryResult.usersDict[snapshot.created_by]?.displayName ?? "Unknown"}
					onClickArchive={onClickArchive}
					onClickSnapshot={onClickSnapshot}
				/>
			))}
		</div>
	);
});
// #endregion list

// #region preview modal diff block
type PageEditorSnapshotsModalPreviewModalDiffBlock_ClassNames =
	| "PageEditorSnapshotsModalPreviewModalDiffBlock"
	| "PageEditorSnapshotsModalPreviewModalDiffBlock-word"
	| "PageEditorSnapshotsModalPreviewModalDiffBlock-added"
	| "PageEditorSnapshotsModalPreviewModalDiffBlock-removed"
	| "PageEditorSnapshotsModalPreviewModalDiffBlock-unchanged";

type PageEditorSnapshotsModalPreviewModalDiffBlock_Props = {
	getCurrentMarkdown: () => string;
	selectedSnapshotContent: PageEditorSnapshotsModal_PreviewSnapshotContent | undefined;
	showSkeletonWhenLoading: boolean;
};

const PageEditorSnapshotsModalPreviewModalDiffBlock = memo(function PageEditorSnapshotsModalPreviewModalDiffBlock(
	props: PageEditorSnapshotsModalPreviewModalDiffBlock_Props,
) {
	const { getCurrentMarkdown, selectedSnapshotContent, showSkeletonWhenLoading } = props;

	return (
		<pre
			className={cn(
				"PageEditorSnapshotsModalPreviewModalDiffBlock" satisfies PageEditorSnapshotsModalPreviewModalDiffBlock_ClassNames,
			)}
		>
			{selectedSnapshotContent === undefined ? (
				showSkeletonWhenLoading ? <PageEditorSnapshotsModalSkeletonPreviewModalBody /> : null
			) : (
				diffWordsWithSpace(getCurrentMarkdown(), selectedSnapshotContent.content).map((part, index) => (
					<span
						key={index}
						className={cn(
							"PageEditorSnapshotsModalPreviewModalDiffBlock-word" satisfies PageEditorSnapshotsModalPreviewModalDiffBlock_ClassNames,
							part.added &&
								("PageEditorSnapshotsModalPreviewModalDiffBlock-added" satisfies PageEditorSnapshotsModalPreviewModalDiffBlock_ClassNames),
							part.removed &&
								("PageEditorSnapshotsModalPreviewModalDiffBlock-removed" satisfies PageEditorSnapshotsModalPreviewModalDiffBlock_ClassNames),
							!part.added &&
								!part.removed &&
								("PageEditorSnapshotsModalPreviewModalDiffBlock-unchanged" satisfies PageEditorSnapshotsModalPreviewModalDiffBlock_ClassNames),
						)}
					>
						{part.value}
					</span>
				))
			)}
		</pre>
	);
});
// #endregion preview modal diff block

// #region preview modal
type PageEditorSnapshotsModalPreviewModal_ClassNames =
	| "PageEditorSnapshotsModalPreviewModal"
	| "PageEditorSnapshotsModalPreviewModal-scrollable-area"
	| "PageEditorSnapshotsModalPreviewModal-snapshot-data"
	| "PageEditorSnapshotsModalPreviewModal-snapshot-data-time"
	| "PageEditorSnapshotsModalPreviewModal-snapshot-data-author"
	| "PageEditorSnapshotsModalPreviewModal-navigation-actions"
	| "PageEditorSnapshotsModalPreviewModal-navigation-action"
	| "PageEditorSnapshotsModalPreviewModal-error-container"
	| "PageEditorSnapshotsModalPreviewModal-error-message";

type PageEditorSnapshotsModalPreviewModal_Props = {
	getCurrentMarkdown: () => string;
	isNextDisabled: boolean;
	isPreviousDisabled: boolean;
	isRestoring: boolean;
	nextSnapshot: PageEditorSnapshotsModal_ListSnapshot | null;
	onClickCancel: () => void;
	onClickConfirm: () => void;
	onClickNext: () => void;
	onClickPrevious: () => void;
	open: boolean;
	previousSnapshot: PageEditorSnapshotsModal_ListSnapshot | null;
	selectedSnapshotContent: PageEditorSnapshotsModal_PreviewSnapshotContent | null | undefined;
	selectedSnapshotMarkdown: string | null;
	setOpen: Dispatch<SetStateAction<boolean>>;
	showSkeletonWhenLoading: boolean;
	snapshotsQueryResult: PageEditorSnapshotsModal_ListQueryResult | undefined;
};

const PageEditorSnapshotsModalPreviewModal = memo(function PageEditorSnapshotsModalPreviewModal(
	props: PageEditorSnapshotsModalPreviewModal_Props,
) {
	const {
		getCurrentMarkdown,
		isNextDisabled,
		isPreviousDisabled,
		isRestoring,
		nextSnapshot,
		onClickCancel,
		onClickConfirm,
		onClickNext,
		onClickPrevious,
		open,
		previousSnapshot,
		selectedSnapshotContent,
		selectedSnapshotMarkdown,
		setOpen,
		showSkeletonWhenLoading,
		snapshotsQueryResult,
	} = props;

	return (
		<MyModal open={open} setOpen={setOpen}>
			<MyModalPopover
				className={cn("PageEditorSnapshotsModalPreviewModal" satisfies PageEditorSnapshotsModalPreviewModal_ClassNames)}
			>
				<MyModalHeader>
					<MyModalHeading>Snapshot Preview</MyModalHeading>
				</MyModalHeader>

				<MyModalScrollableArea
					className={cn(
						"PageEditorSnapshotsModalPreviewModal-scrollable-area" satisfies PageEditorSnapshotsModalPreviewModal_ClassNames,
					)}
				>
					{selectedSnapshotContent === null ? (
						<div
							className={cn(
								"PageEditorSnapshotsModalPreviewModal-error-container" satisfies PageEditorSnapshotsModalPreviewModal_ClassNames,
							)}
						>
							<div
								className={cn(
									"PageEditorSnapshotsModalPreviewModal-error-message" satisfies PageEditorSnapshotsModalPreviewModal_ClassNames,
								)}
							>
								Error loading snapshot content
							</div>
						</div>
					) : (
						<>
							<div
								className={cn(
									"PageEditorSnapshotsModalPreviewModal-snapshot-data" satisfies PageEditorSnapshotsModalPreviewModal_ClassNames,
								)}
							>
								{selectedSnapshotContent === undefined ? (
									showSkeletonWhenLoading ? <PageEditorSnapshotsModalSkeletonPreviewModalSnapshotData /> : null
								) : (
									<>
										<div
											className={cn(
												"PageEditorSnapshotsModalPreviewModal-snapshot-data-time" satisfies PageEditorSnapshotsModalPreviewModal_ClassNames,
											)}
										>
											{format_relative_time(selectedSnapshotContent._creationTime)}
										</div>
										<div
											className={cn(
												"PageEditorSnapshotsModalPreviewModal-snapshot-data-author" satisfies PageEditorSnapshotsModalPreviewModal_ClassNames,
											)}
										>
											{selectedSnapshotContent.usersDict?.[selectedSnapshotContent.created_by]?.displayName ?? "Unknown"}
										</div>
										<div
											className={cn(
												"PageEditorSnapshotsModalPreviewModal-navigation-actions" satisfies PageEditorSnapshotsModalPreviewModal_ClassNames,
											)}
										>
											<MyTooltip>
												<MyTooltipTrigger>
													<MyButton
														variant="outline"
														className={cn(
															"PageEditorSnapshotsModalPreviewModal-navigation-action" satisfies PageEditorSnapshotsModalPreviewModal_ClassNames,
														)}
														onClick={onClickPrevious}
														disabled={isPreviousDisabled}
													>
														<MyButtonIcon>
															<ChevronLeft />
														</MyButtonIcon>
														Newer
													</MyButton>
												</MyTooltipTrigger>
												{previousSnapshot && !isPreviousDisabled && (
													<MyTooltipContent unmountOnHide>
														<div>
															<div>{format_relative_time(previousSnapshot._creationTime)}</div>
															<div>
																{snapshotsQueryResult?.usersDict[previousSnapshot.created_by]?.displayName ?? "Unknown"}
															</div>
														</div>
													</MyTooltipContent>
												)}
											</MyTooltip>

											<MyTooltip>
												<MyTooltipTrigger>
													<MyButton
														variant="outline"
														className={cn(
															"PageEditorSnapshotsModalPreviewModal-navigation-action" satisfies PageEditorSnapshotsModalPreviewModal_ClassNames,
														)}
														onClick={onClickNext}
														disabled={isNextDisabled}
													>
														Older
														<MyButtonIcon>
															<ChevronRight />
														</MyButtonIcon>
													</MyButton>
												</MyTooltipTrigger>
												{nextSnapshot && !isNextDisabled && (
													<MyTooltipContent unmountOnHide>
														<div>
															<div>{format_relative_time(nextSnapshot._creationTime)}</div>
															<div>{snapshotsQueryResult?.usersDict[nextSnapshot.created_by]?.displayName ?? "Unknown"}</div>
														</div>
													</MyTooltipContent>
												)}
											</MyTooltip>
										</div>
									</>
								)}
							</div>
							<PageEditorSnapshotsModalPreviewModalDiffBlock
								getCurrentMarkdown={getCurrentMarkdown}
								selectedSnapshotContent={selectedSnapshotContent}
								showSkeletonWhenLoading={showSkeletonWhenLoading}
							/>
						</>
					)}
				</MyModalScrollableArea>

				<MyModalFooter>
					<MyButton variant="outline" onClick={onClickCancel} disabled={isRestoring}>
						Cancel
					</MyButton>
					<MyButton
						disabled={selectedSnapshotMarkdown == null || isRestoring}
						aria-busy={selectedSnapshotMarkdown == null || isRestoring}
						onClick={onClickConfirm}
					>
						Confirm
					</MyButton>
				</MyModalFooter>

				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion preview modal

// #region root
export type PageEditorSnapshotsModal_ClassNames = "PageEditorSnapshotsModal";

export type PageEditorSnapshotsModal_Props = {
	getCurrentMarkdown: () => string;
	onApplySnapshotMarkdown?: (markdown: string) => void;
	pageId: app_convex_Id<"pages">;
	sessionId: string;
};

export const PageEditorSnapshotsModal = memo(function PageEditorSnapshotsModal(props: PageEditorSnapshotsModal_Props) {
	const { getCurrentMarkdown, onApplySnapshotMarkdown, pageId, sessionId } = props;
	const [isListOpen, setIsListOpen] = useState(false);
	const [isPreviewOpen, setIsPreviewOpen] = useState(false);
	const [selectedSnapshotId, setSelectedSnapshotId] = useState<app_convex_Id<"pages_snapshots"> | null>(null);
	const [isRestoring, setIsRestoring] = useState(false);
	const [showArchived, setShowArchived] = useState(false);
	const showArchivedId = useUiId("PageEditorSnapshotsModal-show-archived");

	const snapshotsQueryResult = useStableQuery(app_convex_api.ai_docs_temp.get_page_snapshots_list, {
		workspace_id: ai_chat_HARDCODED_ORG_ID,
		project_id: ai_chat_HARDCODED_PROJECT_ID,
		page_id: pageId,
		show_archived: showArchived,
	});

	const selectedSnapshotContent = useQuery(
		app_convex_api.ai_docs_temp.get_page_snapshot_content,
		selectedSnapshotId
			? {
					workspace_id: ai_chat_HARDCODED_ORG_ID,
					project_id: ai_chat_HARDCODED_PROJECT_ID,
					page_id: pageId,
					page_snapshot_id: selectedSnapshotId,
				}
			: "skip",
	);

	const restoreSnapshot = useMutation(app_convex_api.ai_docs_temp.restore_snapshot);
	const archiveSnapshot = useMutation(app_convex_api.ai_docs_temp.archive_snapshot);
	const unarchiveSnapshot = useMutation(app_convex_api.ai_docs_temp.unarchive_snapshot);

	const selectedSnapshotMarkdown =
		selectedSnapshotContent && "content" in selectedSnapshotContent ? selectedSnapshotContent.content : null;
	const showListLoadingSkeleton = useDelayedLoadingState(isListOpen && snapshotsQueryResult === undefined);
	const showPreviewLoadingSkeleton = useDelayedLoadingState(
		isPreviewOpen && selectedSnapshotId != null && selectedSnapshotContent === undefined,
	);

	const handleClickSnapshot = (snapshotId: app_convex_Id<"pages_snapshots">) => {
		setSelectedSnapshotId(snapshotId);
		setIsPreviewOpen(true);
	};

	const handleClickConfirm = () => {
		if (!selectedSnapshotId) return;
		if (selectedSnapshotMarkdown == null) return;

		setIsRestoring(true);
		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			await restoreSnapshot({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageSnapshotId: selectedSnapshotId,
				pageId: pageId,
				sessionId: sessionId,
				currentMarkdownContent: getCurrentMarkdown(),
			});
			console.debug("Snapshot restored:", selectedSnapshotId);

			onApplySnapshotMarkdown?.(selectedSnapshotMarkdown);

			setIsPreviewOpen(false);
			setIsListOpen(false);
			setSelectedSnapshotId(null);
		})()
			.catch((err) => {
				console.error("Failed to restore snapshot:", err);
			})
			.finally(() => {
				setIsRestoring(false);
			});
	};

	const handleClickCancel = () => {
		setIsPreviewOpen(false);
		setSelectedSnapshotId(null);
	};

	const handleClickPreviousSnapshot = () => {
		if (!snapshotsQueryResult || !selectedSnapshotId) {
			const error = should_never_happen("[PageEditorSnapshotsModal.handleClickPreviousSnapshot]: missing deps", {
				snapshotsQueryResult,
				selectedSnapshotId,
			});
			console.error(error);
			throw error;
		}

		const currentIndex = snapshotsQueryResult.snapshots.findIndex((snapshot) => snapshot._id === selectedSnapshotId);
		if (currentIndex > 0) {
			setSelectedSnapshotId(snapshotsQueryResult.snapshots[currentIndex - 1]._id);
		}
	};

	const handleClickNextSnapshot = () => {
		if (!snapshotsQueryResult || !selectedSnapshotId) {
			const error = should_never_happen("[PageEditorSnapshotsModal.handleClickNextSnapshot]: missing deps", {
				snapshotsQueryResult,
				selectedSnapshotId,
			});
			console.error(error);
			throw error;
		}

		const currentIndex = snapshotsQueryResult.snapshots.findIndex((snapshot) => snapshot._id === selectedSnapshotId);
		if (currentIndex < snapshotsQueryResult.snapshots.length - 1) {
			setSelectedSnapshotId(snapshotsQueryResult.snapshots[currentIndex + 1]._id);
		}
	};

	const handleClickArchive = async (
		snapshotId: app_convex_Id<"pages_snapshots">,
		isArchived: boolean | undefined,
	) => {
		const mutation = isArchived ? unarchiveSnapshot : archiveSnapshot;
		await mutation({
			workspace_id: ai_chat_HARDCODED_ORG_ID,
			project_id: ai_chat_HARDCODED_PROJECT_ID,
			page_snapshot_id: snapshotId,
		});
	};

	const currentIndex =
		snapshotsQueryResult && selectedSnapshotId
			? snapshotsQueryResult.snapshots.findIndex((snapshot) => snapshot._id === selectedSnapshotId)
			: -1;
	const previousSnapshot = currentIndex > 0 ? (snapshotsQueryResult?.snapshots[currentIndex - 1] ?? null) : null;
	const nextSnapshot =
		currentIndex >= 0 && currentIndex < (snapshotsQueryResult?.snapshots.length ?? 0) - 1
			? (snapshotsQueryResult?.snapshots[currentIndex + 1] ?? null)
			: null;
	const isPreviousDisabled = !snapshotsQueryResult || !selectedSnapshotId || currentIndex === 0;
	const isNextDisabled =
		!snapshotsQueryResult || !selectedSnapshotId || currentIndex === (snapshotsQueryResult?.snapshots.length ?? 0) - 1;

	return (
		<>
			<MyIconButton variant="ghost" tooltip="Snapshots" onClick={() => setIsListOpen(true)}>
				<Clock />
			</MyIconButton>

			<MyModal open={isListOpen} setOpen={setIsListOpen}>
				<MyModalPopover className={cn("PageEditorSnapshotsModal" satisfies PageEditorSnapshotsModal_ClassNames)}>
					<MyModalHeader>
						<MyModalHeading>Page Snapshots</MyModalHeading>
					</MyModalHeader>

					<PageEditorSnapshotsModalListControls
						showArchived={showArchived}
						showArchivedId={showArchivedId}
						onCheckedChange={setShowArchived}
					/>

					<MyModalScrollableArea>
						<PageEditorSnapshotsModalList
							snapshotsQueryResult={snapshotsQueryResult ?? undefined}
							showSkeletonWhenLoading={showListLoadingSkeleton}
							onClickArchive={handleClickArchive}
							onClickSnapshot={handleClickSnapshot}
						/>
					</MyModalScrollableArea>

					<MyModalCloseTrigger />

					<PageEditorSnapshotsModalPreviewModal
						getCurrentMarkdown={getCurrentMarkdown}
						isNextDisabled={isNextDisabled}
						isPreviousDisabled={isPreviousDisabled}
						isRestoring={isRestoring}
						nextSnapshot={nextSnapshot}
						onClickCancel={handleClickCancel}
						onClickConfirm={handleClickConfirm}
						onClickNext={handleClickNextSnapshot}
						onClickPrevious={handleClickPreviousSnapshot}
						open={isPreviewOpen}
						previousSnapshot={previousSnapshot}
						selectedSnapshotContent={
							selectedSnapshotContent === undefined || selectedSnapshotContent === null
								? selectedSnapshotContent
								: {
										_creationTime: selectedSnapshotContent._creationTime,
										content: selectedSnapshotContent.content,
										created_by: selectedSnapshotContent.created_by,
										usersDict: selectedSnapshotContent.usersDict,
									}
						}
						selectedSnapshotMarkdown={selectedSnapshotMarkdown}
						setOpen={setIsPreviewOpen}
						showSkeletonWhenLoading={showPreviewLoadingSkeleton}
						snapshotsQueryResult={snapshotsQueryResult ?? undefined}
					/>
				</MyModalPopover>
			</MyModal>
		</>
	);
});
// #endregion root
