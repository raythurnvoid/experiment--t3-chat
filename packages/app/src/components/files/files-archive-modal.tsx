import "./files-archive-modal.css";

import { memo, useId, useState, type RefObject } from "react";
import { useConvex, useQuery } from "convex/react";
import { toast } from "sonner";

import { MyButton } from "@/components/my-button.tsx";
import { MyRadio } from "@/components/my-radio.tsx";
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
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionArgs,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { files_VisibleTreeNode } from "@/lib/files.ts";

type FilesArchiveModal_ClassNames =
	| "FilesArchiveModal"
	| "FilesArchiveModal-content"
	| "FilesArchiveModal-list"
	| "FilesArchiveModal-error";

/**
 * What the dialog needs to name a row. Hosts already hold these on the tree node they act on.
 */
export type FilesArchiveModal_Node = Pick<files_VisibleTreeNode, "_id" | "name" | "kind">;

export type FilesArchiveModal_Props = {
	/** The nodes to archive. `null` keeps the dialog closed. */
	nodes: FilesArchiveModal_Node[] | null;
	/** Focused again when the dialog closes without archiving. */
	returnFocusRef?: RefObject<HTMLElement | null>;
	/** The user closed it: Cancel, Escape, the backdrop or the close button. Nothing was written. */
	onClose: () => void;
	/**
	 * The archive succeeded for every id, or a background job took it over. The host clears its
	 * state and reacts.
	 */
	onArchived: (nodeIds: app_convex_Id<"files_nodes">[]) => void;
};

/**
 * The one Archive confirmation shared by the sidebar row menu, the folder explorer row menu and
 * the breadcrumb menu. It owns the archive mutation and shows a refusal inline. Every host already
 * gates its Archive control on `canArchiveOrRestore`, and the server refuses anyway, so there is no
 * gate here.
 */
export const FilesArchiveModal = memo(function FilesArchiveModal(props: FilesArchiveModal_Props) {
	const { nodes, returnFocusRef, onClose, onArchived } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const { openArchiveRun } = AppActivitiesProvider.useContext();

	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const hasFolder = nodes?.some((node) => node.kind === "folder") ?? false;
	const heading = nodes && nodes.length > 1 ? `Archive ${nodes.length} items?` : `Archive “${nodes?.[0]?.name ?? ""}”?`;

	const handleClose = useFn(() => {
		// Clear the refusal here and in `handleConfirm`, so a second open does not start with old text.
		setError(null);
		onClose();
		queueMicrotask(() => returnFocusRef?.current?.focus());
	});

	const handleOpenChange = useFn((open: boolean) => {
		// Escape and the backdrop cannot close the dialog while the archive is being written.
		if (!open && !pending) {
			handleClose();
		}
	});

	const handleConfirm = useFn(() => {
		if (!nodes) return;
		const nodeIds = nodes.map((node) => node._id);
		setPending(true);
		setError(null);
		app_convex
			.mutation(app_convex_api.files_nodes.archive_nodes, { membershipId, nodeIds })
			.then((result) => {
				if (result._nay) {
					console.error("[FilesArchiveModal.handleConfirm] Failed to archive nodes", { result, nodeIds });
					// Same words as the sidebar's other permission refusals.
					setError(
						result._nay.message === "Permission denied"
							? "You don't have permission to edit files in this workspace."
							: result._nay.message,
					);
					return;
				}
				// A big archive continues as a background job. Its items leave the tree as the job runs.
				if (result._yay) {
					const { runId } = result._yay;
					toast.info("Archiving in the background. See Activity.", {
						action: { label: "View", onClick: () => openArchiveRun(runId) },
					});
				}
				onArchived(nodeIds);
			})
			.catch((error: unknown) => {
				console.error("[FilesArchiveModal.handleConfirm] Unexpected async error", { error, nodeIds });
				setError("Failed to archive. Try again.");
			})
			.finally(() => setPending(false));
	});

	return (
		<MyModal open={nodes !== null} setOpen={handleOpenChange}>
			<MyModalPopover className={"FilesArchiveModal" satisfies FilesArchiveModal_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>{heading}</MyModalHeading>
					<MyModalDescription>
						Archived items are hidden from the tree. Show them from the sidebar's More options menu, and bring one back
						with Restore in its row menu.
						{hasFolder ? " A folder is archived with everything inside it." : null}
					</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					<div className={"FilesArchiveModal-content" satisfies FilesArchiveModal_ClassNames}>
						{nodes && nodes.length > 1 ? (
							<ul className={"FilesArchiveModal-list" satisfies FilesArchiveModal_ClassNames}>
								{nodes.map((node) => (
									<li key={node._id}>{node.name}</li>
								))}
							</ul>
						) : null}
						{error ? (
							<p role="alert" className={"FilesArchiveModal-error" satisfies FilesArchiveModal_ClassNames}>
								{error}
							</p>
						) : null}
					</div>
				</MyModalScrollableArea>
				<MyModalFooter>
					<MyButton variant="ghost" disabled={pending} onClick={handleClose}>
						Cancel
					</MyButton>
					<MyButton variant="destructive" disabled={pending} aria-busy={pending} onClick={handleConfirm}>
						{pending ? "Archiving..." : "Archive"}
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger disabled={pending} />
			</MyModalPopover>
		</MyModal>
	);
});

type FilesArchiveRunModal_ResolveArgs = app_convex_FunctionArgs<
	typeof app_convex_api.files_archive_runs.resolve_conflicts
>;

type FilesArchiveRunModal_ClassNames =
	| "FilesArchiveRunModal"
	| "FilesArchiveRunModal-content"
	| "FilesArchiveRunModal-conflict"
	| "FilesArchiveRunModal-path"
	| "FilesArchiveRunModal-choice"
	| "FilesArchiveRunModal-error";

type FilesArchiveRunModal_Props = {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	runId: app_convex_Id<"files_archive_runs">;
	onClose: () => void;
};

/**
 * Progress of one background Archive or Restore, and the name clash a Restore waits on. The clash
 * choices are the ones a pasted move offers, because a restore moves items back.
 */
export const FilesArchiveRunModal = memo(function FilesArchiveRunModal(props: FilesArchiveRunModal_Props) {
	const { membershipId, runId, onClose } = props;
	const convex = useConvex();
	const { pendingStopSourceIds, stop } = AppActivitiesProvider.useContext();
	const run = useQuery(app_convex_api.files_archive_runs.get, { membershipId, runId });
	const [choice, setChoice] = useState<FilesArchiveRunModal_ResolveArgs["choice"] | null>(null);
	const [applyToRemaining, setApplyToRemaining] = useState<FilesArchiveRunModal_ResolveArgs["applyToRemaining"]>({
		file: null,
		folder: null,
	});
	const [isSaving, setIsSaving] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [previousRevision, setPreviousRevision] = useState(run?.revision);
	const choiceName = `FilesArchiveRunModal-${useId()}-choice`;

	// A new clash starts with no choice picked.
	if (previousRevision !== run?.revision) {
		setPreviousRevision(run?.revision);
		setChoice(null);
	}

	const status = run?.activity.status;
	const progress = run?.activity.progress;
	const isActive = run?.activity.finishedAt === undefined;
	const isStopPending = pendingStopSourceIds.has(runId);
	const conflict = run?.conflict ?? null;

	const statusLabel =
		run === undefined
			? "Loading…"
			: run === null
				? "This job is no longer available."
				: isStopPending && isActive && status !== "stopping"
					? "Stop requested. Waiting for the server…"
					: {
							queued: run.kind === "restore" ? "Restoring in the background…" : "Archiving in the background…",
							running: run.kind === "restore" ? "Restoring in the background…" : "Archiving in the background…",
							awaiting_input: "Choose how to handle this name.",
							stopping: "Stopping…",
							succeeded: "Completed.",
							partial: "Partly completed.",
							failed: "Failed.",
							canceled: "Stopped.",
							timed_out: "Timed out.",
						}[run.activity.status];

	const handleStop = useFn(() => {
		if (!run?.controls.canStop || isSaving || isStopPending) return;

		setErrorMessage(null);
		stop({ activityId: run.activity._id, sourceId: runId })
			.then((result) => {
				if (result._nay) setErrorMessage(result._nay.message);
			})
			.catch((error: unknown) => {
				console.error("[FilesArchiveRunModal.handleStop] Failed to stop the archive job", { error, runId });
				setErrorMessage("Stop was not confirmed. Reconnect and try again.");
			});
	});

	const handleContinue = useFn(() => {
		if (!run || !choice || isSaving || isStopPending) return;

		setIsSaving(true);
		setErrorMessage(null);
		convex
			.mutation(app_convex_api.files_archive_runs.resolve_conflicts, {
				membershipId,
				runId,
				revision: run.revision,
				choice,
				applyToRemaining,
			})
			.then((result) => {
				if (result._nay) setErrorMessage(result._nay.message);
			})
			.catch((error: unknown) => {
				console.error("[FilesArchiveRunModal.handleContinue] Failed to resolve the name clash", { error, runId });
				setErrorMessage("Could not save your choice. Try again when connected.");
			})
			.finally(() => setIsSaving(false));
	});

	return (
		<MyModal
			open
			setOpen={(open) => {
				if (!open) onClose();
			}}
		>
			<MyModalPopover className={"FilesArchiveRunModal" satisfies FilesArchiveRunModal_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>{run?.activity.title ?? "Archive"}</MyModalHeading>
					<MyModalDescription role="status">{statusLabel}</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					<div className={"FilesArchiveRunModal-content" satisfies FilesArchiveRunModal_ClassNames}>
						{progress ? (
							<p role="status">
								{progress.completed} {run?.kind === "restore" ? "restored" : "archived"}, {progress.skipped} skipped.
								{progress.total !== null ? ` Total: ${progress.total}.` : isActive ? " Checking items…" : null}
							</p>
						) : null}
						{conflict ? (
							<fieldset
								className={"FilesArchiveRunModal-conflict" satisfies FilesArchiveRunModal_ClassNames}
								disabled={isSaving || isStopPending}
							>
								<legend className={"FilesArchiveRunModal-path" satisfies FilesArchiveRunModal_ClassNames}>
									{conflict.path ?? conflict.name ?? "An item you cannot open"}
								</legend>
								<p>
									This name already exists. Keep both adds a unique counter. Skipping a folder keeps it and its contents
									archived.
								</p>
								{conflict.occupantPath ? (
									<p className={"FilesArchiveRunModal-path" satisfies FilesArchiveRunModal_ClassNames}>
										In the way: {conflict.occupantPath}
									</p>
								) : null}
								<label className={"FilesArchiveRunModal-choice" satisfies FilesArchiveRunModal_ClassNames}>
									<MyRadio name={choiceName} checked={choice === "keep_both"} onChange={() => setChoice("keep_both")} />
									Keep both
								</label>
								{/* Replace archives the item in the way. The server says when that is possible. */}
								{conflict.canReplace ? (
									<label className={"FilesArchiveRunModal-choice" satisfies FilesArchiveRunModal_ClassNames}>
										<MyRadio name={choiceName} checked={choice === "replace"} onChange={() => setChoice("replace")} />
										{conflict.kind === "file" ? "Replace" : "Replace empty folder"}
									</label>
								) : null}
								<label className={"FilesArchiveRunModal-choice" satisfies FilesArchiveRunModal_ClassNames}>
									<MyRadio name={choiceName} checked={choice === "skip"} onChange={() => setChoice("skip")} />
									Skip
								</label>
							</fieldset>
						) : null}
						{conflict
							? (["file", "folder"] as const).map((kind) => (
									<fieldset key={kind} disabled={isSaving || isStopPending}>
										<legend>Apply to remaining {kind} name conflicts</legend>
										{(kind === "file"
											? ([null, "keep_both", "skip", "replace"] as const)
											: ([null, "keep_both", "skip"] as const)
										).map((remaining) => (
											<label
												key={remaining ?? "ask"}
												className={"FilesArchiveRunModal-choice" satisfies FilesArchiveRunModal_ClassNames}
											>
												<MyRadio
													name={`${choiceName}-remaining-${kind}`}
													checked={applyToRemaining[kind] === remaining}
													onChange={() => setApplyToRemaining((current) => ({ ...current, [kind]: remaining }))}
												/>
												{remaining === null
													? "Ask each time"
													: remaining === "keep_both"
														? "Keep both"
														: remaining === "skip"
															? "Skip"
															: "Replace"}
											</label>
										))}
									</fieldset>
								))
							: null}
						{errorMessage || run?.activity.errorMessage ? (
							<p role="alert" className={"FilesArchiveRunModal-error" satisfies FilesArchiveRunModal_ClassNames}>
								{errorMessage ?? run?.activity.errorMessage}
							</p>
						) : null}
					</div>
				</MyModalScrollableArea>
				<MyModalFooter>
					<MyButton variant="ghost" onClick={onClose}>
						{isActive ? "Hide" : "Close"}
					</MyButton>
					{run && isActive ? (
						<MyButton
							variant="secondary"
							disabled={isSaving || isStopPending || !run.controls.canStop}
							onClick={handleStop}
						>
							Stop
						</MyButton>
					) : null}
					{conflict ? (
						<MyButton disabled={isSaving || isStopPending || !choice} onClick={handleContinue}>
							Continue
						</MyButton>
					) : null}
				</MyModalFooter>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
