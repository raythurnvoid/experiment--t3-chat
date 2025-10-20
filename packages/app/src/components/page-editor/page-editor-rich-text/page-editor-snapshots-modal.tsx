import "./page-editor-snapshots-modal.css";
import { useState } from "react";
import { useQuery } from "convex/react";
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
} from "../../my-modal.tsx";
import { MyButton } from "../../my-button.tsx";
import { MyIconButton } from "../../my-icon-button.tsx";
import { MySkeleton } from "../../ui/my-skeleton.tsx";
import { Clock, FileText } from "lucide-react";
import type { app_convex_Id } from "@/lib/app-convex-client.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../../lib/ai-chat.ts";

export type PageEditorSnapshotsModal_ClassNames =
	| "PageEditorSnapshotsModal"
	| "PageEditorSnapshotsModal-skeleton-list"
	| "PageEditorSnapshotsModal-skeleton-button"
	| "PageEditorSnapshotsModal-snapshot-item";

export type PageEditorSnapshotsModal_Props = {
	pageId: string;
};

export default function PageEditorSnapshotsModal(props: PageEditorSnapshotsModal_Props) {
	const { pageId } = props;
	const [isListOpen, setIsListOpen] = useState(false);
	const [isPreviewOpen, setIsPreviewOpen] = useState(false);
	const [selectedSnapshotId, setSelectedSnapshotId] = useState<app_convex_Id<"pages_snapshots"> | null>(null);

	const snapshots = useQuery(app_convex_api.ai_docs_temp.get_page_snapshots_list, {
		workspace_id: ai_chat_HARDCODED_ORG_ID,
		project_id: ai_chat_HARDCODED_PROJECT_ID,
		page_id: pageId,
	});

	const selectedSnapshotContent = useQuery(
		app_convex_api.ai_docs_temp.get_page_snapshot_content,
		selectedSnapshotId ? { page_snapshot_id: selectedSnapshotId } : "skip",
	);

	const handleSnapshotClick = (snapshotId: app_convex_Id<"pages_snapshots">) => {
		setSelectedSnapshotId(snapshotId);
		setIsPreviewOpen(true);
	};

	const handleConfirm = () => {
		console.debug("Snapshot selected:", selectedSnapshotId);
		setIsPreviewOpen(false);
		setIsListOpen(false);
		setSelectedSnapshotId(null);
	};

	const handleCancel = () => {
		setIsPreviewOpen(false);
		setSelectedSnapshotId(null);
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

	return (
		<>
			{/* Snapshots Button */}
			<MyIconButton variant="ghost" tooltip="Snapshots" onClick={() => setIsListOpen(true)}>
				<Clock />
			</MyIconButton>

			{/* List Modal */}
			<MyModal open={isListOpen} setOpen={setIsListOpen}>
				<MyModalPopover>
					<MyModalHeader>
						<h2 className="text-lg font-semibold">Page Snapshots</h2>
					</MyModalHeader>

					<MyModalScrollableArea>
						{snapshots === undefined ? (
							<div className="PageEditorSnapshotsModal-skeleton-list">
								{Array.from({ length: 10 }, (_, index) => (
									<MyButton
										key={index}
										variant="ghost"
										className={cn(
											"PageEditorSnapshotsModal-skeleton-button" satisfies PageEditorSnapshotsModal_ClassNames,
										)}
										disabled
									>
										<FileText className="h-4 w-4" />
										<div>
											<MySkeleton className="mb-1 h-4 w-32" />
											<MySkeleton className="h-3 w-24" />
										</div>
									</MyButton>
								))}
							</div>
						) : snapshots.length === 0 ? (
							<div className="flex items-center justify-center py-8">
								<div className="text-sm text-muted-foreground">No snapshots yet</div>
							</div>
						) : (
							<div className="space-y-2">
								{snapshots.map((snapshot) => (
									<MyButton
										key={snapshot._id}
										variant="ghost"
										className={cn(
											"PageEditorSnapshotsModal-snapshot-item" satisfies PageEditorSnapshotsModal_ClassNames,
										)}
										onClick={() => handleSnapshotClick(snapshot._id)}
									>
										<FileText className="h-4 w-4 text-muted-foreground" />
										<div className="min-w-0 flex-1">
											<div className="text-sm font-medium">{formatTime(snapshot._creationTime)}</div>
											<div className="text-xs text-muted-foreground">Created by {snapshot.created_by}</div>
										</div>
									</MyButton>
								))}
							</div>
						)}
					</MyModalScrollableArea>

					<MyModalCloseTrigger />

					{/* Preview Modal */}
					<MyModal open={isPreviewOpen} setOpen={setIsPreviewOpen}>
						<MyModalPopover>
							<MyModalHeader>
								<h2 className="text-lg font-semibold">Snapshot Preview</h2>
							</MyModalHeader>

							<MyModalScrollableArea>
								{selectedSnapshotContent === undefined ? (
									<div className="flex items-center justify-center py-8">
										<div className="text-sm text-muted-foreground">Loading content...</div>
									</div>
								) : selectedSnapshotContent === null ? (
									<div className="flex items-center justify-center py-8">
										<div className="text-sm text-muted-foreground">Content not found</div>
									</div>
								) : (
									<div className="space-y-4">
										<div className="text-sm text-muted-foreground">
											<div>{formatTime(selectedSnapshotContent._creationTime)}</div>
											<div>Created by {selectedSnapshotContent.created_by}</div>
										</div>
										<div className="PageEditorSnapshotsModal-preview">
											<pre className="overflow-auto rounded-lg bg-muted p-4 font-mono text-sm whitespace-pre-wrap">
												{selectedSnapshotContent.content}
											</pre>
										</div>
									</div>
								)}
							</MyModalScrollableArea>

							<MyModalFooter>
								<MyButton variant="outline" onClick={handleCancel}>
									Cancel
								</MyButton>
								<MyButton onClick={handleConfirm}>Confirm</MyButton>
							</MyModalFooter>

							<MyModalCloseTrigger />
						</MyModalPopover>
					</MyModal>
				</MyModalPopover>
			</MyModal>
		</>
	);
}
