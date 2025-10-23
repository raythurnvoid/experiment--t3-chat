import "./page-editor-snapshots-modal.css";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { cn } from "@/lib/utils.ts";
import { format_relative_time, should_show_ago_suffix, should_show_at_prefix } from "@/lib/date.ts";
import {
	MyModal,
	MyModalPopover,
	MyModalHeader,
	MyModalScrollableArea,
	MyModalFooter,
	MyModalCloseTrigger,
	MyModalHeading,
} from "../../my-modal.tsx";
import { MyButton, MyButtonIcon } from "../../my-button.tsx";
import { MyIconButton } from "../../my-icon-button.tsx";
import { MySkeleton } from "../../ui/my-skeleton.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip.tsx";
import { Clock, FileText, ChevronLeft, ChevronRight } from "lucide-react";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../../lib/ai-chat.ts";
import { diffWordsWithSpace } from "diff";
import type { Editor } from "@tiptap/react";

export type PageEditorSnapshotsModal_ClassNames =
	| "PageEditorSnapshotsModal"
	| "PageEditorSnapshotsModal-skeleton-list"
	| "PageEditorSnapshotsModal-skeleton-list-item"
	| "PageEditorSnapshotsModal-snapshot-item"
	| "PageEditorSnapshotsModal-snapshot-icon"
	| "PageEditorSnapshotsModal-snapshot-main-text"
	| "PageEditorSnapshotsModal-snapshot-support-text"
	| "PageEditorSnapshotsModal-empty-message-container"
	| "PageEditorSnapshotsModal-empty-message"
	| "PageEditorSnapshotsModal-preview-scrollable-area"
	| "PageEditorSnapshotsModal-preview-snapshot-data"
	| "PageEditorSnapshotsModal-preview-snapshot-data-time"
	| "PageEditorSnapshotsModal-preview-snapshot-data-author"
	| "PageEditorSnapshotsModal-preview-body"
	| "PageEditorSnapshotsModal-preview-popover"
	| "PageEditorSnapshotsModal-preview-error-container"
	| "PageEditorSnapshotsModal-preview-error-message"
	| "PageEditorSnapshotsModal-preview-snapshot-data-skeleton"
	| "PageEditorSnapshotsModal-preview-body-skeleton"
	| "PageEditorSnapshotsModal-preview-diff-container"
	| "PageEditorSnapshotsModal-preview-diff-word"
	| "PageEditorSnapshotsModal-preview-diff-added"
	| "PageEditorSnapshotsModal-preview-diff-removed"
	| "PageEditorSnapshotsModal-preview-diff-unchanged"
	| "PageEditorSnapshotsModal-navigation-actions"
	| "PageEditorSnapshotsModal-navigation-action";

export type PageEditorSnapshotsModal_Props = {
	pageId: string;
	editor: Editor | null;
};

export default function PageEditorSnapshotsModal(props: PageEditorSnapshotsModal_Props) {
	const { pageId, editor } = props;
	const [isListOpen, setIsListOpen] = useState(false);
	const [isPreviewOpen, setIsPreviewOpen] = useState(false);
	const [selectedSnapshotId, setSelectedSnapshotId] = useState<app_convex_Id<"pages_snapshots"> | null>(null);
	const [isRestoring, setIsRestoring] = useState(false);

	const snapshots = useQuery(app_convex_api.ai_docs_temp.get_page_snapshots_list, {
		workspace_id: ai_chat_HARDCODED_ORG_ID,
		project_id: ai_chat_HARDCODED_PROJECT_ID,
		page_id: pageId,
	});

	const selectedSnapshotContent = useQuery(
		app_convex_api.ai_docs_temp.get_page_snapshot_content,
		selectedSnapshotId ? { page_snapshot_id: selectedSnapshotId } : "skip",
	);

	const restoreSnapshotAndBroadcast = useMutation(app_convex_api.ai_docs_temp.restore_snapshot_and_broadcast);

	const getCurrentEditorContent = () => {
		if (!editor) return "";
		return editor.storage.markdown.serializer.serialize(editor.state.doc) as string;
	};

	const createDiff = (snapshotContent: string) => {
		return diffWordsWithSpace(getCurrentEditorContent(), snapshotContent);
	};

	const handleSnapshotClick = (snapshotId: app_convex_Id<"pages_snapshots">) => {
		setSelectedSnapshotId(snapshotId);
		setIsPreviewOpen(true);
	};

	const handleConfirm = async () => {
		if (!selectedSnapshotId) return;

		setIsRestoring(true);
		try {
			await restoreSnapshotAndBroadcast({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageSnapshotId: selectedSnapshotId,
			});
			console.debug("Snapshot restored:", selectedSnapshotId);
			setIsPreviewOpen(false);
			setIsListOpen(false);
			setSelectedSnapshotId(null);
		} catch (err) {
			console.error("Failed to restore snapshot:", err);
		} finally {
			setIsRestoring(false);
		}
	};

	const handleCancel = () => {
		setIsPreviewOpen(false);
		setSelectedSnapshotId(null);
	};

	const handlePreviousSnapshot = () => {
		if (!snapshots || !selectedSnapshotId) return;
		const currentIndex = snapshots.findIndex((s) => s._id === selectedSnapshotId);
		if (currentIndex > 0) {
			setSelectedSnapshotId(snapshots[currentIndex - 1]._id);
		}
	};

	const handleNextSnapshot = () => {
		if (!snapshots || !selectedSnapshotId) return;
		const currentIndex = snapshots.findIndex((s) => s._id === selectedSnapshotId);
		if (currentIndex < snapshots.length - 1) {
			setSelectedSnapshotId(snapshots[currentIndex + 1]._id);
		}
	};

	const formatTime = (timestamp: number) => {
		const relativeTime = format_relative_time(timestamp);
		const showAgo = should_show_ago_suffix(timestamp);
		const showAt = should_show_at_prefix(timestamp);

		if (showAt) {
			return `at ${relativeTime}`;
		}
		if (showAgo) {
			return `${relativeTime} ago`;
		}
		return relativeTime;
	};

	const currentIndex = snapshots && selectedSnapshotId ? snapshots.findIndex((s) => s._id === selectedSnapshotId) : -1;
	const previousSnapshot = currentIndex > 0 ? snapshots?.[currentIndex - 1] : null;
	const nextSnapshot =
		currentIndex >= 0 && currentIndex < (snapshots?.length ?? 0) - 1 ? snapshots?.[currentIndex + 1] : null;
	const isPreviousDisabled = !snapshots || !selectedSnapshotId || currentIndex === 0;
	const isNextDisabled = !snapshots || !selectedSnapshotId || currentIndex === (snapshots?.length ?? 0) - 1;

	return (
		<>
			{/* Snapshots Button */}
			<MyIconButton variant="ghost" tooltip="Snapshots" disabled={!editor} onClick={() => setIsListOpen(true)}>
				<Clock />
			</MyIconButton>

			{/* List Modal */}
			<MyModal open={isListOpen} setOpen={setIsListOpen}>
				<MyModalPopover>
					<MyModalHeader>
						<MyModalHeading>Page Snapshots</MyModalHeading>
					</MyModalHeader>

					<MyModalScrollableArea>
						{snapshots === undefined ? (
							<div className="PageEditorSnapshotsModal-skeleton-list">
								{Array.from({ length: 10 }, (_, index) => (
									<MySkeleton
										key={index}
										className={cn(
											"PageEditorSnapshotsModal-skeleton-list-item" satisfies PageEditorSnapshotsModal_ClassNames,
										)}
									/>
								))}
							</div>
						) : snapshots.length === 0 ? (
							<div
								className={cn(
									"PageEditorSnapshotsModal-empty-message-container" satisfies PageEditorSnapshotsModal_ClassNames,
								)}
							>
								<div
									className={cn("PageEditorSnapshotsModal-empty-message" satisfies PageEditorSnapshotsModal_ClassNames)}
								>
									No snapshots yet
								</div>
							</div>
						) : (
							<div className="space-y-2">
								{snapshots.map((snapshot) => (
									<MyButton
										key={snapshot._id}
										variant="secondary"
										className={cn(
											"PageEditorSnapshotsModal-snapshot-item" satisfies PageEditorSnapshotsModal_ClassNames,
										)}
										onClick={() => handleSnapshotClick(snapshot._id)}
									>
										<MyButtonIcon
											className={cn(
												"PageEditorSnapshotsModal-snapshot-icon" satisfies PageEditorSnapshotsModal_ClassNames,
											)}
										>
											<FileText />
										</MyButtonIcon>
										<span
											className={cn(
												"PageEditorSnapshotsModal-snapshot-main-text" satisfies PageEditorSnapshotsModal_ClassNames,
											)}
										>
											{formatTime(snapshot._creationTime)}
										</span>
										<span
											className={cn(
												"PageEditorSnapshotsModal-snapshot-support-text" satisfies PageEditorSnapshotsModal_ClassNames,
											)}
										>
											{snapshot.created_by}
										</span>
									</MyButton>
								))}
							</div>
						)}
					</MyModalScrollableArea>

					<MyModalCloseTrigger />

					{/* Preview Modal */}
					<MyModal open={isPreviewOpen} setOpen={setIsPreviewOpen}>
						<MyModalPopover
							className={cn("PageEditorSnapshotsModal-preview-popover" satisfies PageEditorSnapshotsModal_ClassNames)}
						>
							<MyModalHeader>
								<MyModalHeading>Snapshot Preview</MyModalHeading>
							</MyModalHeader>

							<MyModalScrollableArea
								className={cn(
									"PageEditorSnapshotsModal-preview-scrollable-area" satisfies PageEditorSnapshotsModal_ClassNames,
								)}
							>
								{selectedSnapshotContent === null ? (
									<div
										className={cn(
											"PageEditorSnapshotsModal-preview-error-container" satisfies PageEditorSnapshotsModal_ClassNames,
										)}
									>
										<div
											className={cn(
												"PageEditorSnapshotsModal-preview-error-message" satisfies PageEditorSnapshotsModal_ClassNames,
											)}
										>
											Error loading snapshot content
										</div>
									</div>
								) : (
									<>
										<div
											className={cn(
												"PageEditorSnapshotsModal-preview-snapshot-data" satisfies PageEditorSnapshotsModal_ClassNames,
											)}
										>
											{selectedSnapshotContent === undefined ? (
												Array.from({ length: 3 }, (_, index) => (
													<MySkeleton
														key={index}
														className={cn(
															"PageEditorSnapshotsModal-preview-snapshot-data-skeleton" satisfies PageEditorSnapshotsModal_ClassNames,
														)}
													/>
												))
											) : (
												<>
													<div
														className={cn(
															"PageEditorSnapshotsModal-preview-snapshot-data-time" satisfies PageEditorSnapshotsModal_ClassNames,
														)}
													>
														{formatTime(selectedSnapshotContent._creationTime)}
													</div>
													<div
														className={cn(
															"PageEditorSnapshotsModal-preview-snapshot-data-author" satisfies PageEditorSnapshotsModal_ClassNames,
														)}
													>
														{selectedSnapshotContent.created_by}
													</div>
													<div
														className={cn(
															"PageEditorSnapshotsModal-navigation-actions" satisfies PageEditorSnapshotsModal_ClassNames,
														)}
													>
														{previousSnapshot && !isPreviousDisabled ? (
															<Tooltip>
																<TooltipTrigger asChild>
																	<MyButton
																		variant="outline"
																		className={cn(
																			"PageEditorSnapshotsModal-navigation-action" satisfies PageEditorSnapshotsModal_ClassNames,
																		)}
																		onClick={handlePreviousSnapshot}
																		disabled={isPreviousDisabled}
																	>
																		<MyButtonIcon>
																			<ChevronLeft />
																		</MyButtonIcon>
																		Previous
																	</MyButton>
																</TooltipTrigger>
																<TooltipContent>
																	<div>
																		<div>{formatTime(previousSnapshot._creationTime)}</div>
																		<div>{previousSnapshot.created_by}</div>
																	</div>
																</TooltipContent>
															</Tooltip>
														) : (
															<MyButton
																variant="outline"
																className={cn(
																	"PageEditorSnapshotsModal-navigation-action" satisfies PageEditorSnapshotsModal_ClassNames,
																)}
																onClick={handlePreviousSnapshot}
																disabled={isPreviousDisabled}
															>
																<MyButtonIcon>
																	<ChevronLeft />
																</MyButtonIcon>
																Previous
															</MyButton>
														)}
														{nextSnapshot && !isNextDisabled ? (
															<Tooltip>
																<TooltipTrigger asChild>
																	<MyButton
																		variant="outline"
																		className={cn(
																			"PageEditorSnapshotsModal-navigation-action" satisfies PageEditorSnapshotsModal_ClassNames,
																		)}
																		onClick={handleNextSnapshot}
																		disabled={isNextDisabled}
																	>
																		Next
																		<MyButtonIcon>
																			<ChevronRight />
																		</MyButtonIcon>
																	</MyButton>
																</TooltipTrigger>
																<TooltipContent>
																	<div>
																		<div>{formatTime(nextSnapshot._creationTime)}</div>
																		<div>{nextSnapshot.created_by}</div>
																	</div>
																</TooltipContent>
															</Tooltip>
														) : (
															<MyButton
																variant="outline"
																className={cn(
																	"PageEditorSnapshotsModal-navigation-action" satisfies PageEditorSnapshotsModal_ClassNames,
																)}
																onClick={handleNextSnapshot}
																disabled={isNextDisabled}
															>
																Next
																<MyButtonIcon>
																	<ChevronRight />
																</MyButtonIcon>
															</MyButton>
														)}
													</div>
												</>
											)}
										</div>
										<pre
											className={cn(
												"PageEditorSnapshotsModal-preview-diff-container" satisfies PageEditorSnapshotsModal_ClassNames,
											)}
										>
											{selectedSnapshotContent === undefined
												? Array.from({ length: 20 }, (_, index) => (
														<MySkeleton
															key={index}
															className={cn(
																"PageEditorSnapshotsModal-preview-body-skeleton" satisfies PageEditorSnapshotsModal_ClassNames,
															)}
														/>
													))
												: createDiff(selectedSnapshotContent.content).map((part, index) => (
														<span
															key={index}
															className={cn(
																"PageEditorSnapshotsModal-preview-diff-word" satisfies PageEditorSnapshotsModal_ClassNames,
																part.added &&
																	("PageEditorSnapshotsModal-preview-diff-added" satisfies PageEditorSnapshotsModal_ClassNames),
																part.removed &&
																	("PageEditorSnapshotsModal-preview-diff-removed" satisfies PageEditorSnapshotsModal_ClassNames),
																!part.added &&
																	!part.removed &&
																	("PageEditorSnapshotsModal-preview-diff-unchanged" satisfies PageEditorSnapshotsModal_ClassNames),
															)}
														>
															{part.value}
														</span>
													))}
										</pre>
									</>
								)}
							</MyModalScrollableArea>

							<MyModalFooter>
								<MyButton variant="outline" onClick={handleCancel} disabled={isRestoring}>
									Cancel
								</MyButton>
								<MyButton
									disabled={selectedSnapshotContent == null || isRestoring}
									aria-busy={selectedSnapshotContent == null || isRestoring}
									onClick={handleConfirm}
								>
									Confirm
								</MyButton>
							</MyModalFooter>

							<MyModalCloseTrigger />
						</MyModalPopover>
					</MyModal>
				</MyModalPopover>
			</MyModal>
		</>
	);
}
