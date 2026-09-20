import "./files-pending-review.css";

import { memo, useState } from "react";
import { useQuery } from "convex/react";
import { MyButton } from "@/components/my-button.tsx";
import { MyLink } from "@/components/my-link.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { FILE_EDITOR_SIDEBAR_TAB_ID_PENDING } from "@/components/files/file-editor/file-editor-sidebar/file-editor-sidebar-pending-strip.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api, type app_convex_FunctionReturnType, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { app_local_storage_set_value } from "@/lib/storage.ts";
import { global_custom_event_dispatch } from "@/lib/global-event.tsx";

type FilesPendingReviewModal_ClassNames =
	| "FilesPendingReviewModal"
	| "FilesPendingReviewModal-items"
	| "FilesPendingReviewModal-item"
	| "FilesPendingReviewModal-pages"
	| "FilesPendingReviewModal-error";

const FilesPendingReviewItem = memo(function FilesPendingReviewItem(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	item: app_convex_FunctionReturnType<typeof app_convex_api.files_pending_update_runs.list_items>["page"][number];
	onOpenReview: () => void;
}) {
	const { membershipId, item, onOpenReview } = props;
	const { organizationName, workspaceName } = AppTenantProvider.useContext();
	const needsReview = item.status === "needs_review" || item.status === "failed" || item.status === "canceled";
	// Names come from current access, never from captured job history.
	const current = useQuery(
		app_convex_api.files_pending_updates.get_file_pending_target,
		needsReview ? { membershipId, target: item.target } : "skip",
	);
	const label = current?.entry.path ?? `Change ${item.order + 1}`;
	return (
		<li className={"FilesPendingReviewModal-item" satisfies FilesPendingReviewModal_ClassNames}>
			<p>
				{label} ·{" "}
				{
					{
						queued: "Queued",
						running: "Working",
						completed: "Completed",
						needs_review: "Needs review",
						failed: "Failed",
						canceled: "Stopped",
					}[item.status]
				}
			</p>
			{item.message ? <p>{item.message}</p> : null}
			{needsReview && current ? (
				<MyLink
					to="/w/$organizationName/$workspaceName/files"
					params={{ organizationName, workspaceName }}
					search={
						item.target.kind === "private"
							? { pendingNodeId: item.target.id, view: "diff_editor" }
							: { nodeId: item.target.id, view: "diff_editor" }
					}
					onClick={onOpenReview}
				>
					Review {label}
				</MyLink>
			) : null}
		</li>
	);
});

export const FilesPendingReviewModal = memo(function FilesPendingReviewModal(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	runId: app_convex_Id<"files_pending_update_runs">;
	onClose: () => void;
}) {
	const { membershipId, runId, onClose } = props;
	const { organizationName, workspaceName } = AppTenantProvider.useContext();
	const { stop, pendingStopSourceIds } = AppActivitiesProvider.useContext();
	// A completed review can remove its opener. Keep its panel for focus when the dialog closes.
	const [focusFallback] = useState(() =>
		document.activeElement?.closest<HTMLElement>(".FileEditorSidebarPending, .FileNodeView-editor-area"),
	);

	const run = useQuery(app_convex_api.files_pending_update_runs.get, { membershipId, runId });

	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const [hasPaged, setHasPaged] = useState(false);
	const page = useQuery(
		app_convex_api.files_pending_update_runs.list_items,
		run ? { membershipId, runId, paginationOpts: { numItems: 50, cursor: cursors[cursors.length - 1]! } } : "skip",
	);

	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const isStopPending = pendingStopSourceIds.has(runId);
	const isTerminal = run?.activity.finishedAt !== undefined;
	const progress = run?.activity.progress;

	const remaining =
		progress?.total == null
			? null
			: Math.max(
					0,
					progress.total -
						progress.completed -
						progress.skipped -
						progress.failed -
						progress.blocked -
						progress.canceled,
				);

	const statusLabel =
		run === null
			? "This review is no longer available."
			: !run
				? "Loading review…"
				: isStopPending && !isTerminal && run.activity.status !== "stopping"
					? "Stop requested. Waiting for the server…"
					: run.activity.status === "succeeded"
						? run.run.kind === "accept"
							? "Changes saved."
							: "Changes discarded."
						: run.activity.status === "partial"
							? "Some changes completed."
							: run.activity.status === "failed"
								? "Review could not finish. Check the remaining changes."
								: run.activity.status === "canceled"
									? "Stopped."
									: run.activity.status === "timed_out"
										? "Timed out."
										: run.activity.status === "stopping"
											? "Stopping…"
											: run.run.step === "uploading"
												? "Sending your reviewed changes…"
												: run.run.step === "planning"
													? "Checking linked changes…"
													: run.run.kind === "accept"
														? "Saving reviewed changes…"
														: "Discarding reviewed changes…";

	const handleStop = useFn(() => {
		if (!run?.controls.canStop || isStopPending) return;
		setErrorMessage(null);
		stop({ activityId: run.activity._id, sourceId: runId })
			.then((result) => {
				if (result._nay) setErrorMessage(result._nay.message);
			})
			.catch(() => setErrorMessage("Stop was not confirmed. Reconnect and try again."));
	});
	const handleOpenReview = useFn(() => {
		global_custom_event_dispatch("files::review_all_pending", { membershipId });
		app_local_storage_set_value("app_state::files_last_tab", FILE_EDITOR_SIDEBAR_TAB_ID_PENDING);
		onClose();
	});

	return (
		<MyModal
			open
			setOpen={(open) => {
				if (!open) onClose();
			}}
		>
			<MyModalPopover
				className={"FilesPendingReviewModal" satisfies FilesPendingReviewModal_ClassNames}
				autoFocusOnHide={(opener) => {
					if (opener?.isConnected || !focusFallback?.isConnected) return true;
					focusFallback.focus({ preventScroll: true });
					return false;
				}}
			>
				<MyModalHeader>
					<MyModalHeading>
						{run?.run.kind === "discard" ? "Discard reviewed changes" : "Save reviewed changes"}
					</MyModalHeading>
					<MyModalDescription role="status">{statusLabel}</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					{progress ? (
						<p role="status">
							{progress.completed} {run?.run.kind === "discard" ? "discarded" : "saved"}, {progress.blocked} need
							review, {progress.failed} failed, {progress.skipped} skipped, {progress.canceled} stopped.
							{remaining === null ? "" : ` ${remaining} remaining.`}
						</p>
					) : null}
					{run?.run.needsReviewIds?.length ? (
						<p>Some linked changes were not selected. Open pending changes to review them together.</p>
					) : null}
					{errorMessage || run?.activity.errorMessage ? (
						<p role="alert" className={"FilesPendingReviewModal-error" satisfies FilesPendingReviewModal_ClassNames}>
							{errorMessage ?? run?.activity.errorMessage}
						</p>
					) : null}
					{run && page === undefined ? <p role="status">Loading changes…</p> : null}
					{page ? (
						<ul className={"FilesPendingReviewModal-items" satisfies FilesPendingReviewModal_ClassNames}>
							{page.page.map((item) => (
								<FilesPendingReviewItem
									key={item.pendingUpdateId}
									membershipId={membershipId}
									item={item}
									onOpenReview={handleOpenReview}
								/>
							))}
						</ul>
					) : null}
					{hasPaged || page?.isDone === false ? (
						<div className={"FilesPendingReviewModal-pages" satisfies FilesPendingReviewModal_ClassNames}>
							<MyButton
								variant="ghost"
								disabled={!page || cursors.length === 1}
								onClick={() => setCursors((current) => current.slice(0, -1))}
							>
								Previous page
							</MyButton>
							<span role="status">Page {cursors.length}</span>
							<MyButton
								variant="ghost"
								disabled={!page || page.isDone}
								onClick={() => {
									if (!page) return;
									// Keep the page controls mounted while the next query loads.
									setHasPaged(true);
									setCursors((current) => [...current, page.continueCursor]);
								}}
							>
								Next page
							</MyButton>
						</div>
					) : null}
				</MyModalScrollableArea>
				<MyModalFooter>
					<MyButton variant="ghost" onClick={onClose}>
						{isTerminal ? "Close" : "Hide"}
					</MyButton>
					{run ? (
						<MyLink
							to="/w/$organizationName/$workspaceName/files"
							params={{ organizationName, workspaceName }}
							search={{}}
							onClick={handleOpenReview}
						>
							Review remaining changes
						</MyLink>
					) : null}
					{run?.controls.canStop ? (
						<MyButton variant="secondary" disabled={isStopPending} onClick={handleStop}>
							Stop and keep completed changes
						</MyButton>
					) : null}
				</MyModalFooter>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
