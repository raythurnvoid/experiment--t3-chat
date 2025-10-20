import "./page-editor-snapshots-modal.css";
import { useState } from "react";
import { useQuery } from "convex/react";
import { app_convex_api } from "../../../lib/app-convex-client.ts";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "../../../lib/ai-chat.ts";
import { cn } from "../../../lib/utils.ts";
import {
	MyModal,
	MyModalBackdrop,
	MyModalPopover,
	MyModalHeader,
	MyModalScrollableArea,
	MyModalFooter,
	MyModalCloseTrigger,
} from "../../my-modal.tsx";
import { MyButton } from "../../my-button.tsx";
import { MyIconButton } from "../../my-icon-button.tsx";
import { Clock, FileText } from "lucide-react";
import type { Id } from "../../../../convex/_generated/dataModel";

export type PageEditorSnapshotsModal_ClassNames = "PageEditorSnapshotsModal";

export type PageEditorSnapshotsModal_Props = {
	pageId: string;
};

export default function PageEditorSnapshotsModal(props: PageEditorSnapshotsModal_Props) {
	const { pageId } = props;
	const [isListOpen, setIsListOpen] = useState(false);
	const [isPreviewOpen, setIsPreviewOpen] = useState(false);
	const [selectedSnapshotId, setSelectedSnapshotId] = useState<Id<"pages_snapshots"> | null>(null);

	const snapshots = useQuery(app_convex_api.ai_docs_temp.get_page_snapshots_list, {
		workspace_id: ai_chat_HARDCODED_ORG_ID,
		project_id: ai_chat_HARDCODED_PROJECT_ID,
		page_id: pageId,
	});

	const selectedSnapshotContent = useQuery(
		app_convex_api.ai_docs_temp.get_page_snapshot_content,
		selectedSnapshotId ? { page_snapshot_id: selectedSnapshotId } : "skip",
	);

	const handleSnapshotClick = (snapshotId: Id<"pages_snapshots">) => {
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

	const formatDate = (timestamp: number) => {
		return new Date(timestamp).toLocaleString("en-GB", {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
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
							<div className="flex items-center justify-center py-8">
								<div className="text-sm text-muted-foreground">Loading snapshots...</div>
							</div>
						) : snapshots.length === 0 ? (
							<div className="flex items-center justify-center py-8">
								<div className="text-sm text-muted-foreground">No snapshots yet</div>
							</div>
						) : (
							<div className="space-y-2">
								{snapshots.map((snapshot) => (
									<div
										key={snapshot._id}
										className={cn(
											"PageEditorSnapshotsModal-item",
											"flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-accent hover:text-accent-foreground",
										)}
										onClick={() => handleSnapshotClick(snapshot._id)}
									>
										<FileText className="h-4 w-4 text-muted-foreground" />
										<div className="min-w-0 flex-1">
											<div className="text-sm font-medium">Snapshot {snapshot._id.slice(-8)}</div>
											<div className="text-xs text-muted-foreground">{formatDate(snapshot._creationTime)}</div>
										</div>
									</div>
								))}
							</div>
						)}
					</MyModalScrollableArea>

					<MyModalCloseTrigger />
				</MyModalPopover>
			</MyModal>

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
									Created: {formatDate(selectedSnapshotContent._creationTime)}
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
		</>
	);
}
