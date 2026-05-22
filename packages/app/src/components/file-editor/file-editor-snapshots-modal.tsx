import "./file-editor-snapshots-modal.css";

import { memo, useEffect, useState, type Dispatch, type MouseEvent, type SetStateAction } from "react";
import { useConvex, useMutation, useQueries, useQuery } from "convex/react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, Clock, FileText } from "lucide-react";
import { diffWordsWithSpace } from "diff";

import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { format_relative_time } from "@/lib/date.ts";
import { useUiId } from "@/lib/ui.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { cn, should_never_happen } from "@/lib/utils.ts";
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
import { useFn } from "@/hooks/utils-hooks.ts";

type FileEditorSnapshotsModal_UserRecord = {
	displayName?: string;
};

type FileEditorSnapshotsModal_UsersDict = Record<string, FileEditorSnapshotsModal_UserRecord | undefined>;

type FileEditorSnapshotsModal_ListSnapshot = {
	_id: app_convex_Id<"files_snapshots">;
	_creationTime: number;
	createdBy: string;
	archivedAt: number;
};

type FileEditorSnapshotsModal_ListQueryResult = {
	snapshots: FileEditorSnapshotsModal_ListSnapshot[];
};

type FileEditorSnapshotsModal_PreviewSnapshotContent = {
	_creationTime: number;
	content: string;
};

const SNAPSHOT_SKELETON_ROW_COUNT = 10;
const PREVIEW_SKELETON_ROW_COUNT = 20;

// #region skeleton
type FileEditorSnapshotsModalSkeleton_ClassNames =
	| "FileEditorSnapshotsModalSkeleton-list"
	| "FileEditorSnapshotsModalSkeleton-list-item"
	| "FileEditorSnapshotsModalSkeleton-preview-snapshot-data"
	| "FileEditorSnapshotsModalSkeleton-preview-body";

type FileEditorSnapshotsModalSkeletonList_Props = {
	rowCount?: number;
};

const FileEditorSnapshotsModalSkeletonList = memo(function FileEditorSnapshotsModalSkeletonList(
	props: FileEditorSnapshotsModalSkeletonList_Props,
) {
	const { rowCount = SNAPSHOT_SKELETON_ROW_COUNT } = props;

	return (
		<div className={cn("FileEditorSnapshotsModalSkeleton-list" satisfies FileEditorSnapshotsModalSkeleton_ClassNames)}>
			{Array.from({ length: rowCount }, (_, index) => (
				<MySkeleton
					key={index}
					className={cn(
						"FileEditorSnapshotsModalSkeleton-list-item" satisfies FileEditorSnapshotsModalSkeleton_ClassNames,
					)}
				/>
			))}
		</div>
	);
});

type FileEditorSnapshotsModalSkeletonPreviewModalSnapshotData_Props = {
	rowCount?: number;
};

const FileEditorSnapshotsModalSkeletonPreviewModalSnapshotData = memo(
	function FileEditorSnapshotsModalSkeletonPreviewModalSnapshotData(
		props: FileEditorSnapshotsModalSkeletonPreviewModalSnapshotData_Props,
	) {
		const { rowCount = 3 } = props;

		return Array.from({ length: rowCount }, (_, index) => (
			<MySkeleton
				key={index}
				className={cn(
					"FileEditorSnapshotsModalSkeleton-preview-snapshot-data" satisfies FileEditorSnapshotsModalSkeleton_ClassNames,
				)}
			/>
		));
	},
);

type FileEditorSnapshotsModalSkeletonPreviewModalBody_Props = {
	rowCount?: number;
};

const FileEditorSnapshotsModalSkeletonPreviewModalBody = memo(function FileEditorSnapshotsModalSkeletonPreviewModalBody(
	props: FileEditorSnapshotsModalSkeletonPreviewModalBody_Props,
) {
	const { rowCount = PREVIEW_SKELETON_ROW_COUNT } = props;

	return Array.from({ length: rowCount }, (_, index) => (
		<MySkeleton
			key={index}
			className={cn(
				"FileEditorSnapshotsModalSkeleton-preview-body" satisfies FileEditorSnapshotsModalSkeleton_ClassNames,
			)}
		/>
	));
});
// #endregion skeleton

// #region list item
type FileEditorSnapshotsModalListItem_ClassNames =
	| "FileEditorSnapshotsModalListItem"
	| "FileEditorSnapshotsModalListItem-archived"
	| "FileEditorSnapshotsModalListItem-icon"
	| "FileEditorSnapshotsModalListItem-primary-button"
	| "FileEditorSnapshotsModalListItem-archived-label"
	| "FileEditorSnapshotsModalListItem-support-text"
	| "FileEditorSnapshotsModalListItem-actions"
	| "FileEditorSnapshotsModalListItem-action-button";

type FileEditorSnapshotsModalListItem_Props = {
	snapshot: FileEditorSnapshotsModal_ListSnapshot;
	userDisplayName: string;
	onClickArchive: (snapshotId: app_convex_Id<"files_snapshots">, isArchived: boolean) => void | Promise<void>;
	onClickSnapshot: (snapshotId: app_convex_Id<"files_snapshots">) => void;
};

const FileEditorSnapshotsModalListItem = memo(function FileEditorSnapshotsModalListItem(
	props: FileEditorSnapshotsModalListItem_Props,
) {
	const { snapshot, userDisplayName, onClickArchive, onClickSnapshot } = props;
	const isArchived = snapshot.archivedAt > 0;

	const handleRowClick = useFn((event: MouseEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;

		// Don't forward the click when you hit an interactive element inside the row.
		if (target.closest("button") || target.closest("a") || target.closest('[role="button"]')) {
			return;
		}

		onClickSnapshot(snapshot._id);
	});

	const handlePrimaryClick = useFn(() => {
		onClickSnapshot(snapshot._id);
	});

	const handleArchiveClick = useFn(() => {
		onClickArchive(snapshot._id, isArchived);
	});

	return (
		<div
			className={cn(
				"FileEditorSnapshotsModalListItem" satisfies FileEditorSnapshotsModalListItem_ClassNames,
				isArchived &&
					("FileEditorSnapshotsModalListItem-archived" satisfies FileEditorSnapshotsModalListItem_ClassNames),
			)}
			onClick={handleRowClick}
		>
			<MyButtonIcon
				className={cn("FileEditorSnapshotsModalListItem-icon" satisfies FileEditorSnapshotsModalListItem_ClassNames)}
			>
				<FileText />
			</MyButtonIcon>
			<button
				type="button"
				className={cn(
					"FileEditorSnapshotsModalListItem-primary-button" satisfies FileEditorSnapshotsModalListItem_ClassNames,
				)}
				onClick={handlePrimaryClick}
			>
				{format_relative_time(snapshot._creationTime)}
				{isArchived && (
					<span
						className={cn(
							"FileEditorSnapshotsModalListItem-archived-label" satisfies FileEditorSnapshotsModalListItem_ClassNames,
						)}
					>
						{" - "}Archived
					</span>
				)}
			</button>
			<span
				className={cn(
					"FileEditorSnapshotsModalListItem-support-text" satisfies FileEditorSnapshotsModalListItem_ClassNames,
				)}
			>
				{userDisplayName}
			</span>
			<div
				className={cn("FileEditorSnapshotsModalListItem-actions" satisfies FileEditorSnapshotsModalListItem_ClassNames)}
			>
				<MyIconButton
					className={cn(
						"FileEditorSnapshotsModalListItem-action-button" satisfies FileEditorSnapshotsModalListItem_ClassNames,
					)}
					variant="ghost-highlightable"
					tooltip={isArchived ? "Restore" : "Archive"}
					onClick={handleArchiveClick}
				>
					<MyIconButtonIcon>{isArchived ? <ArchiveRestore /> : <Archive />}</MyIconButtonIcon>
				</MyIconButton>
			</div>
		</div>
	);
});
// #endregion list item

// #region list controls
type FileEditorSnapshotsModalListControls_ClassNames = "FileEditorSnapshotsModalListControls";

type FileEditorSnapshotsModalListControls_Props = {
	showArchived: boolean;
	showArchivedId: string;
	onCheckedChange: (checked: boolean) => void;
};

const FileEditorSnapshotsModalListControls = memo(function FileEditorSnapshotsModalListControls(
	props: FileEditorSnapshotsModalListControls_Props,
) {
	const { showArchived, showArchivedId, onCheckedChange } = props;

	return (
		<div
			className={cn("FileEditorSnapshotsModalListControls" satisfies FileEditorSnapshotsModalListControls_ClassNames)}
		>
			<MyLabel htmlFor={showArchivedId}>Show archived</MyLabel>
			<MySwitch id={showArchivedId} checked={showArchived} onCheckedChange={onCheckedChange} />
		</div>
	);
});
// #endregion list controls

// #region list
type FileEditorSnapshotsModalList_ClassNames =
	| "FileEditorSnapshotsModalList"
	| "FileEditorSnapshotsModalList-empty-message-container"
	| "FileEditorSnapshotsModalList-empty-message";

type FileEditorSnapshotsModalList_Props = {
	snapshotsQueryResult: FileEditorSnapshotsModal_ListQueryResult | undefined;
	usersDict: FileEditorSnapshotsModal_UsersDict;
	showSkeletonWhenLoading: boolean;
	onClickArchive: (snapshotId: app_convex_Id<"files_snapshots">, isArchived: boolean) => void | Promise<void>;
	onClickSnapshot: (snapshotId: app_convex_Id<"files_snapshots">) => void;
};

const FileEditorSnapshotsModalList = memo(function FileEditorSnapshotsModalList(
	props: FileEditorSnapshotsModalList_Props,
) {
	const { snapshotsQueryResult, usersDict, showSkeletonWhenLoading, onClickArchive, onClickSnapshot } = props;

	if (snapshotsQueryResult === undefined) {
		if (!showSkeletonWhenLoading) {
			return null;
		}

		return <FileEditorSnapshotsModalSkeletonList />;
	}

	if (snapshotsQueryResult.snapshots.length === 0) {
		return (
			<div
				className={cn(
					"FileEditorSnapshotsModalList-empty-message-container" satisfies FileEditorSnapshotsModalList_ClassNames,
				)}
			>
				<div
					className={cn("FileEditorSnapshotsModalList-empty-message" satisfies FileEditorSnapshotsModalList_ClassNames)}
				>
					No snapshots yet
				</div>
			</div>
		);
	}

	return (
		<div className={cn("FileEditorSnapshotsModalList" satisfies FileEditorSnapshotsModalList_ClassNames)}>
			{snapshotsQueryResult.snapshots.map((snapshot) => (
				<FileEditorSnapshotsModalListItem
					key={snapshot._id}
					snapshot={snapshot}
					userDisplayName={usersDict[snapshot.createdBy]?.displayName ?? "Unknown"}
					onClickArchive={onClickArchive}
					onClickSnapshot={onClickSnapshot}
				/>
			))}
		</div>
	);
});
// #endregion list

// #region preview modal diff block
type FileEditorSnapshotsModalPreviewModalDiffBlock_ClassNames =
	| "FileEditorSnapshotsModalPreviewModalDiffBlock"
	| "FileEditorSnapshotsModalPreviewModalDiffBlock-word"
	| "FileEditorSnapshotsModalPreviewModalDiffBlock-added"
	| "FileEditorSnapshotsModalPreviewModalDiffBlock-removed"
	| "FileEditorSnapshotsModalPreviewModalDiffBlock-unchanged";

type FileEditorSnapshotsModalPreviewModalDiffBlockInner_Props = {
	currentMarkdown: string;
	snapshotMarkdown: string;
};

const FileEditorSnapshotsModalPreviewModalDiffBlockInner = memo(
	function FileEditorSnapshotsModalPreviewModalDiffBlockInner(
		props: FileEditorSnapshotsModalPreviewModalDiffBlockInner_Props,
	) {
		const { currentMarkdown, snapshotMarkdown } = props;

		const diffParts = diffWordsWithSpace(currentMarkdown, snapshotMarkdown);

		return (
			<>
				{diffParts.map((part, index) => (
					<span
						key={index}
						className={cn(
							"FileEditorSnapshotsModalPreviewModalDiffBlock-word" satisfies FileEditorSnapshotsModalPreviewModalDiffBlock_ClassNames,
							part.added &&
								("FileEditorSnapshotsModalPreviewModalDiffBlock-added" satisfies FileEditorSnapshotsModalPreviewModalDiffBlock_ClassNames),
							part.removed &&
								("FileEditorSnapshotsModalPreviewModalDiffBlock-removed" satisfies FileEditorSnapshotsModalPreviewModalDiffBlock_ClassNames),
							!part.added &&
								!part.removed &&
								("FileEditorSnapshotsModalPreviewModalDiffBlock-unchanged" satisfies FileEditorSnapshotsModalPreviewModalDiffBlock_ClassNames),
						)}
					>
						{part.value}
					</span>
				))}
			</>
		);
	},
);

type FileEditorSnapshotsModalPreviewModalDiffBlock_Props = {
	currentMarkdown: string;
	selectedSnapshotContent: FileEditorSnapshotsModal_PreviewSnapshotContent | undefined;
	showSkeletonWhenLoading: boolean;
};

const FileEditorSnapshotsModalPreviewModalDiffBlock = memo(function FileEditorSnapshotsModalPreviewModalDiffBlock(
	props: FileEditorSnapshotsModalPreviewModalDiffBlock_Props,
) {
	const { currentMarkdown, selectedSnapshotContent, showSkeletonWhenLoading } = props;

	return (
		<pre
			className={cn(
				"FileEditorSnapshotsModalPreviewModalDiffBlock" satisfies FileEditorSnapshotsModalPreviewModalDiffBlock_ClassNames,
			)}
		>
			{selectedSnapshotContent === undefined ? (
				showSkeletonWhenLoading ? (
					<FileEditorSnapshotsModalSkeletonPreviewModalBody />
				) : null
			) : (
				<FileEditorSnapshotsModalPreviewModalDiffBlockInner
					currentMarkdown={currentMarkdown}
					snapshotMarkdown={selectedSnapshotContent.content}
				/>
			)}
		</pre>
	);
});
// #endregion preview modal diff block

// #region preview modal
type FileEditorSnapshotsModalPreviewModal_ClassNames =
	| "FileEditorSnapshotsModalPreviewModal"
	| "FileEditorSnapshotsModalPreviewModal-scrollable-area"
	| "FileEditorSnapshotsModalPreviewModal-snapshot-data"
	| "FileEditorSnapshotsModalPreviewModal-snapshot-data-time"
	| "FileEditorSnapshotsModalPreviewModal-snapshot-data-author"
	| "FileEditorSnapshotsModalPreviewModal-navigation-actions"
	| "FileEditorSnapshotsModalPreviewModal-navigation-action"
	| "FileEditorSnapshotsModalPreviewModal-error-container"
	| "FileEditorSnapshotsModalPreviewModal-error-message";

type FileEditorSnapshotsModalPreviewModal_Props = {
	isNextDisabled: boolean;
	isPreviousDisabled: boolean;
	isRestoring: boolean;
	membershipId: app_convex_Id<"workspaces_projects_users">;
	nextSnapshot: FileEditorSnapshotsModal_ListSnapshot | null;
	open: boolean;
	nodeId: app_convex_Id<"files_nodes">;
	previousSnapshot: FileEditorSnapshotsModal_ListSnapshot | null;
	selectedSnapshotId: app_convex_Id<"files_snapshots"> | null;
	usersDict: FileEditorSnapshotsModal_UsersDict;
	getCurrentMarkdown: () => string;
	setOpen: Dispatch<SetStateAction<boolean>>;
	onClickCancel: () => void;
	onClickConfirm: (snapshotMarkdown: string) => void;
	onClickNext: () => void;
	onClickPrevious: () => void;
};

const FileEditorSnapshotsModalPreviewModal = memo(function FileEditorSnapshotsModalPreviewModal(
	props: FileEditorSnapshotsModalPreviewModal_Props,
) {
	const {
		isNextDisabled,
		isPreviousDisabled,
		isRestoring,
		membershipId,
		nextSnapshot,
		open,
		nodeId,
		previousSnapshot,
		selectedSnapshotId,
		usersDict,
		getCurrentMarkdown,
		setOpen,
		onClickCancel,
		onClickConfirm,
		onClickNext,
		onClickPrevious,
	} = props;

	const convex = useConvex();

	const snapshot = useQuery(
		app_convex_api.files_nodes.get_file_snapshot,
		open && selectedSnapshotId
			? {
					membershipId,
					nodeId,
					snapshotId: selectedSnapshotId,
				}
			: "skip",
	);

	const [selectedSnapshotContent, setSelectedSnapshotContent] = useState<
		| {
				content: string;
				snapshotId: app_convex_Id<"files_snapshots">;
				_creationTime: number;
		  }
		| null
		| undefined
	>(undefined);

	useEffect(() => {
		if (!open || !selectedSnapshotId) {
			setSelectedSnapshotContent(undefined);
			return;
		}

		const abortController = new AbortController();
		let didCancel = false;
		setSelectedSnapshotContent(undefined);
		convex
			.action(app_convex_api.files_nodes.create_file_snapshot_content_url, {
				membershipId,
				nodeId,
				snapshotId: selectedSnapshotId,
			})
			.then(async (snapshotContentUrl) => {
				if (didCancel) return;
				if (!snapshotContentUrl) {
					setSelectedSnapshotContent(null);
					return;
				}

				const response = await fetch(snapshotContentUrl.url, { signal: abortController.signal });
				if (!response.ok) {
					throw new Error("Failed to fetch snapshot content", {
						cause: {
							status: response.status,
							nodeId,
							snapshotId: selectedSnapshotId,
						},
					});
				}

				const content = await response.text();
				if (didCancel) return;
				setSelectedSnapshotContent({
					content,
					snapshotId: snapshotContentUrl.snapshotId,
					_creationTime: snapshotContentUrl._creationTime,
				});
			})
			.catch((error) => {
				if (didCancel || abortController.signal.aborted) return;
				console.error("[FileEditorSnapshotsModalPreviewModal] Failed to load snapshot content", {
					error,
					nodeId,
					snapshotId: selectedSnapshotId,
				});
				setSelectedSnapshotContent(null);
			});

		return () => {
			didCancel = true;
			abortController.abort();
		};
	}, [convex, membershipId, nodeId, open, selectedSnapshotId]);

	const selectedSnapshotMarkdown = selectedSnapshotContent?.content ?? null;
	const currentMarkdownForSnapshotDiff = selectedSnapshotContent === undefined ? "" : getCurrentMarkdown();

	const handleClickConfirm = useFn(() => {
		if (selectedSnapshotMarkdown == null) return;
		onClickConfirm(selectedSnapshotMarkdown);
	});

	return (
		<MyModal open={open} setOpen={setOpen}>
			<MyModalPopover
				className={cn("FileEditorSnapshotsModalPreviewModal" satisfies FileEditorSnapshotsModalPreviewModal_ClassNames)}
			>
				<MyModalHeader>
					<MyModalHeading>Snapshot Preview</MyModalHeading>
				</MyModalHeader>

				<MyModalScrollableArea
					className={cn(
						"FileEditorSnapshotsModalPreviewModal-scrollable-area" satisfies FileEditorSnapshotsModalPreviewModal_ClassNames,
					)}
				>
					{snapshot === null || selectedSnapshotContent === null ? (
						<div
							className={cn(
								"FileEditorSnapshotsModalPreviewModal-error-container" satisfies FileEditorSnapshotsModalPreviewModal_ClassNames,
							)}
						>
							<div
								className={cn(
									"FileEditorSnapshotsModalPreviewModal-error-message" satisfies FileEditorSnapshotsModalPreviewModal_ClassNames,
								)}
							>
								Error loading snapshot content
							</div>
						</div>
					) : (
						<>
							<div
								className={cn(
									"FileEditorSnapshotsModalPreviewModal-snapshot-data" satisfies FileEditorSnapshotsModalPreviewModal_ClassNames,
								)}
							>
								{open &&
								selectedSnapshotId != null &&
								(snapshot === undefined || selectedSnapshotContent === undefined) ? (
									<FileEditorSnapshotsModalSkeletonPreviewModalSnapshotData />
								) : snapshot != null && selectedSnapshotContent != null ? (
									<>
										<div
											className={cn(
												"FileEditorSnapshotsModalPreviewModal-snapshot-data-time" satisfies FileEditorSnapshotsModalPreviewModal_ClassNames,
											)}
										>
											{format_relative_time(selectedSnapshotContent._creationTime)}
										</div>
										<div
											className={cn(
												"FileEditorSnapshotsModalPreviewModal-snapshot-data-author" satisfies FileEditorSnapshotsModalPreviewModal_ClassNames,
											)}
										>
											{usersDict[snapshot.createdBy]?.displayName ?? "Unknown"}
										</div>
										<div
											className={cn(
												"FileEditorSnapshotsModalPreviewModal-navigation-actions" satisfies FileEditorSnapshotsModalPreviewModal_ClassNames,
											)}
										>
											<MyTooltip>
												<MyTooltipTrigger>
													<MyButton
														variant="outline"
														className={cn(
															"FileEditorSnapshotsModalPreviewModal-navigation-action" satisfies FileEditorSnapshotsModalPreviewModal_ClassNames,
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
															<div>{usersDict[previousSnapshot.createdBy]?.displayName ?? "Unknown"}</div>
														</div>
													</MyTooltipContent>
												)}
											</MyTooltip>

											<MyTooltip>
												<MyTooltipTrigger>
													<MyButton
														variant="outline"
														className={cn(
															"FileEditorSnapshotsModalPreviewModal-navigation-action" satisfies FileEditorSnapshotsModalPreviewModal_ClassNames,
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
															<div>{usersDict[nextSnapshot.createdBy]?.displayName ?? "Unknown"}</div>
														</div>
													</MyTooltipContent>
												)}
											</MyTooltip>
										</div>
									</>
								) : null}
							</div>
							<FileEditorSnapshotsModalPreviewModalDiffBlock
								currentMarkdown={currentMarkdownForSnapshotDiff}
								selectedSnapshotContent={selectedSnapshotContent ?? undefined}
								showSkeletonWhenLoading={
									open &&
									selectedSnapshotId != null &&
									(snapshot === undefined || selectedSnapshotContent === undefined)
								}
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
						onClick={handleClickConfirm}
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

// #region modal
export type FileEditorSnapshotsModal_ClassNames = "FileEditorSnapshotsModal";

type FileEditorSnapshotsModalListModal_Props = {
	isListOpen: boolean;
	isNextDisabled: boolean;
	isPreviewOpen: boolean;
	isPreviousDisabled: boolean;
	isRestoring: boolean;
	listShowSkeletonWhenLoading: boolean;
	membershipId: app_convex_Id<"workspaces_projects_users">;
	nextSnapshot: FileEditorSnapshotsModal_ListSnapshot | null;
	nodeId: app_convex_Id<"files_nodes">;
	previousSnapshot: FileEditorSnapshotsModal_ListSnapshot | null;
	selectedSnapshotId: app_convex_Id<"files_snapshots"> | null;
	showArchived: boolean;
	showArchivedId: string;
	snapshotsQueryResult: FileEditorSnapshotsModal_ListQueryResult | undefined;
	usersDict: FileEditorSnapshotsModal_UsersDict;
	getCurrentMarkdown: () => string;
	setIsListOpen: Dispatch<SetStateAction<boolean>>;
	setIsPreviewOpen: Dispatch<SetStateAction<boolean>>;
	setShowArchived: Dispatch<SetStateAction<boolean>>;
	onClickArchive: FileEditorSnapshotsModalList_Props["onClickArchive"];
	onClickCancel: () => void;
	onClickConfirm: (snapshotMarkdown: string) => void;
	onClickNextSnapshot: () => void;
	onClickPreviousSnapshot: () => void;
	onClickSnapshot: (snapshotId: app_convex_Id<"files_snapshots">) => void;
};

const FileEditorSnapshotsModalListModal = memo(function FileEditorSnapshotsModalListModal(
	props: FileEditorSnapshotsModalListModal_Props,
) {
	const {
		isListOpen,
		isNextDisabled,
		isPreviewOpen,
		isPreviousDisabled,
		isRestoring,
		listShowSkeletonWhenLoading,
		membershipId,
		nextSnapshot,
		nodeId,
		previousSnapshot,
		selectedSnapshotId,
		showArchived,
		showArchivedId,
		snapshotsQueryResult,
		usersDict,
		getCurrentMarkdown,
		setIsListOpen,
		setIsPreviewOpen,
		setShowArchived,
		onClickArchive,
		onClickCancel,
		onClickConfirm,
		onClickNextSnapshot,
		onClickPreviousSnapshot,
		onClickSnapshot,
	} = props;

	return (
		<MyModal open={isListOpen} setOpen={setIsListOpen}>
			<MyModalPopover className={cn("FileEditorSnapshotsModal" satisfies FileEditorSnapshotsModal_ClassNames)}>
				<MyModalHeader>
					<MyModalHeading>File Snapshots</MyModalHeading>
				</MyModalHeader>

				<FileEditorSnapshotsModalListControls
					showArchived={showArchived}
					showArchivedId={showArchivedId}
					onCheckedChange={setShowArchived}
				/>

				<MyModalScrollableArea>
					<FileEditorSnapshotsModalList
						snapshotsQueryResult={snapshotsQueryResult}
						usersDict={usersDict}
						showSkeletonWhenLoading={listShowSkeletonWhenLoading}
						onClickArchive={onClickArchive}
						onClickSnapshot={onClickSnapshot}
					/>
				</MyModalScrollableArea>

				<MyModalCloseTrigger />

				<FileEditorSnapshotsModalPreviewModal
					isNextDisabled={isNextDisabled}
					isPreviousDisabled={isPreviousDisabled}
					isRestoring={isRestoring}
					membershipId={membershipId}
					nextSnapshot={nextSnapshot}
					open={isPreviewOpen}
					nodeId={nodeId}
					previousSnapshot={previousSnapshot}
					selectedSnapshotId={selectedSnapshotId}
					usersDict={usersDict}
					getCurrentMarkdown={getCurrentMarkdown}
					setOpen={setIsPreviewOpen}
					onClickCancel={onClickCancel}
					onClickConfirm={onClickConfirm}
					onClickNext={onClickNextSnapshot}
					onClickPrevious={onClickPreviousSnapshot}
				/>
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion modal

// #region root
export type FileEditorSnapshotsModal_Props = {
	nodeId: app_convex_Id<"files_nodes">;
	sessionId: string;
	getCurrentMarkdown: () => string;
	onApplySnapshotMarkdown?: (markdown: string) => void;
};

export const FileEditorSnapshotsModal = memo(function FileEditorSnapshotsModal(props: FileEditorSnapshotsModal_Props) {
	const { nodeId, sessionId, getCurrentMarkdown, onApplySnapshotMarkdown } = props;

	const convex = useConvex();

	const { membershipId } = AppTenantProvider.useContext();

	const [isListOpen, setIsListOpen] = useState(false);
	const [isPreviewOpen, setIsPreviewOpen] = useState(false);
	const [selectedSnapshotId, setSelectedSnapshotId] = useState<app_convex_Id<"files_snapshots"> | null>(null);
	const [isRestoring, setIsRestoring] = useState(false);
	const [showArchived, setShowArchived] = useState(false);
	const showArchivedId = useUiId("FileEditorSnapshotsModal-show-archived");

	const snapshotsQueryResult = useStableQuery(
		app_convex_api.files_nodes.get_file_snapshots_list,
		isListOpen
			? {
					membershipId,
					nodeId,
					showArchived,
				}
			: "skip",
	);

	const snapshotUserIds = snapshotsQueryResult
		? [...new Set(snapshotsQueryResult.snapshots.map((row) => row.createdBy))]
		: [];

	const userAnagraphicsQueryResults = useQueries(
		Object.fromEntries(
			snapshotUserIds.map((userId) => [
				userId,
				{
					query: app_convex_api.users.get_anagraphic,
					args: { userId },
				},
			]),
		),
	);

	const usersDict = ((/* iife */) => {
		const usersDict: FileEditorSnapshotsModal_UsersDict = {};

		if (!snapshotsQueryResult) {
			return usersDict;
		}

		for (const userId of snapshotUserIds) {
			const queryResult = userAnagraphicsQueryResults[userId];
			if (queryResult === undefined || queryResult instanceof Error || queryResult === null) {
				continue;
			}

			usersDict[userId] = {
				displayName: queryResult?.displayName,
			};
		}

		return usersDict;
	})();

	const archiveSnapshot = useMutation(app_convex_api.files_nodes.archive_snapshot);
	const unarchiveSnapshot = useMutation(app_convex_api.files_nodes.unarchive_snapshot);

	const handleOpenSnapshotsList = useFn(() => {
		setIsListOpen(true);
	});

	const handleClickSnapshot = useFn((snapshotId: app_convex_Id<"files_snapshots">) => {
		setSelectedSnapshotId(snapshotId);
		setIsPreviewOpen(true);
	});

	const handleClickConfirm = useFn((selectedSnapshotMarkdown: string) => {
		if (!selectedSnapshotId) return;

		setIsRestoring(true);
		Promise.try(async () => {
			const restoreResult = await convex.action(app_convex_api.files_nodes.restore_snapshot_r2, {
				membershipId,
				snapshotId: selectedSnapshotId,
				nodeId: nodeId,
				sessionId: sessionId,
			});
			if (restoreResult._nay) {
				console.error("Failed to restore snapshot:", restoreResult._nay);
				toast.error(restoreResult._nay.message ?? "Failed to restore snapshot");
				return;
			}

			console.debug("Snapshot restored:", selectedSnapshotId);

			onApplySnapshotMarkdown?.(selectedSnapshotMarkdown);

			setIsPreviewOpen(false);
			setIsListOpen(false);
			setSelectedSnapshotId(null);
		})
			.catch((err) => {
				console.error("Failed to restore snapshot:", err);
			})
			.finally(() => {
				setIsRestoring(false);
			});
	});

	const handleClickCancel = useFn(() => {
		setIsPreviewOpen(false);
		setSelectedSnapshotId(null);
	});

	const handleClickPreviousSnapshot = useFn(() => {
		if (!snapshotsQueryResult || !selectedSnapshotId) {
			const error = should_never_happen("[FileEditorSnapshotsModal.handleClickPreviousSnapshot]: missing deps", {
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
	});

	const handleClickNextSnapshot = useFn(() => {
		if (!snapshotsQueryResult || !selectedSnapshotId) {
			const error = should_never_happen("[FileEditorSnapshotsModal.handleClickNextSnapshot]: missing deps", {
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
	});

	const handleClickArchive = useFn<FileEditorSnapshotsModalList_Props["onClickArchive"]>(
		async (snapshotId, isArchived) => {
			const mutation = isArchived ? unarchiveSnapshot : archiveSnapshot;
			const archiveResult = await mutation({
				membershipId,
				snapshotId: snapshotId,
			});
			if (archiveResult._nay) {
				toast.error(archiveResult._nay.message ?? "Failed to update snapshot");
			}
		},
	);

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
			<MyIconButton variant="ghost" tooltip="Open file snapshots" onClick={handleOpenSnapshotsList}>
				<Clock />
			</MyIconButton>

			<FileEditorSnapshotsModalListModal
				isListOpen={isListOpen}
				isNextDisabled={isNextDisabled}
				isPreviewOpen={isPreviewOpen}
				isPreviousDisabled={isPreviousDisabled}
				isRestoring={isRestoring}
				listShowSkeletonWhenLoading={isListOpen}
				membershipId={membershipId}
				nextSnapshot={nextSnapshot}
				nodeId={nodeId}
				previousSnapshot={previousSnapshot}
				selectedSnapshotId={selectedSnapshotId}
				showArchived={showArchived}
				showArchivedId={showArchivedId}
				snapshotsQueryResult={snapshotsQueryResult ?? undefined}
				usersDict={usersDict}
				getCurrentMarkdown={getCurrentMarkdown}
				setIsListOpen={setIsListOpen}
				setIsPreviewOpen={setIsPreviewOpen}
				setShowArchived={setShowArchived}
				onClickArchive={handleClickArchive}
				onClickCancel={handleClickCancel}
				onClickConfirm={handleClickConfirm}
				onClickNextSnapshot={handleClickNextSnapshot}
				onClickPreviousSnapshot={handleClickPreviousSnapshot}
				onClickSnapshot={handleClickSnapshot}
			/>
		</>
	);
});
// #endregion root
