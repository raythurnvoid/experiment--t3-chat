import "./files-archive-modal.css";

import { memo, useId, useRef, useState, type RefObject } from "react";
import { useConvex, usePaginatedQuery, useQuery } from "convex/react";
import { toast } from "sonner";

import { ActivityStatusIcon } from "@/components/activity-status-icon.tsx";
import { TextMonospaceBlock } from "@/components/monospace-block/monospace-block-text.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyProgressBar } from "@/components/my-progress-bar.tsx";
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
	| "FilesArchiveModal-list-toggle"
	| "FilesArchiveModal-error";

/**
 * What the dialog needs to name a row. Hosts already hold these on the tree node they act on.
 */
export type FilesArchiveModal_Node = Pick<files_VisibleTreeNode, "_id" | "name" | "path" | "kind">;

export type FilesArchiveModal_Props = {
	/** The nodes to archive. `null` keeps the dialog closed. */
	nodes: FilesArchiveModal_Node[] | null;
	/** Focused again when the dialog closes without archiving. */
	returnFocusRef?: RefObject<HTMLElement | null>;
	/** The user closed it: Cancel, Escape, the backdrop or the close button. Nothing was written. */
	onClose: () => void;
	/**
	 * The ids the archive stamped. Ids the server refused, or still has to check, stay active and are
	 * not in the list. When no id was stamped yet, the dialog calls `onClose` instead. The host clears
	 * its state and reacts.
	 */
	onArchived: (nodeIds: app_convex_Id<"files_nodes">[]) => void;
};

/**
 * The one Archive confirmation shared by the sidebar row menu, the folder explorer row menu and
 * the breadcrumb menu. It owns the archive mutation and shows a refusal inline. Every host already
 * gates its Archive control on the clicked row or the selection. A multi-select can still hold rows
 * the person cannot change. The server refuses those and archives the rest, so there is no gate here.
 */
export const FilesArchiveModal = memo(function FilesArchiveModal(props: FilesArchiveModal_Props) {
	const { nodes, returnFocusRef, onClose, onArchived } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const { openArchiveRun } = AppActivitiesProvider.useContext();

	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	// Tie Show more to the nodes it was clicked for, so the next dialog opens small again.
	const [expandedNodes, setExpandedNodes] = useState<FilesArchiveModal_Node[] | null>(null);
	const isListExpanded = nodes !== null && expandedNodes === nodes;

	const hasFolder = nodes?.some((node) => node.kind === "folder") ?? false;
	// One item is named in the heading, so it gets no list.
	const hasList = nodes !== null && nodes.length > 1;
	const heading = hasList ? `Archive ${nodes.length} items?` : `Archive “${nodes?.[0]?.name ?? ""}”?`;

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
				if (!result._yay) {
					onArchived(nodeIds);
					return;
				}

				// The archive continues as a background job. For example, the request stamps a named folder and
				// the job stamps what is inside it. While the job still checks, every waiting item stays in the
				// tree until the check passes.
				const { runId, notArchivedNodeIds, refusedItems, waitingNodeIds, isChecking } = result._yay;
				const action = { label: "View", onClick: () => openArchiveRun(runId) };
				const waitingNodes = nodes.filter((node) => waitingNodeIds.includes(node._id));
				// Warn as soon as a refusal is known. A job that ended in the request is kept only because it
				// refused items, and a job still running can already have refused some. The warning wins over the
				// checking text, and only counts the waiting items.
				// Name the item and the reason when one item was refused. Activity lists each refused item.
				const refusedNode =
					refusedItems.length === 1 ? nodes.find((node) => node._id === refusedItems[0]!.nodeId) : undefined;
				const waitingSentence =
					waitingNodes.length > 0
						? ` ${waitingNodes.length} more ${waitingNodes.length === 1 ? "is" : "are"} ${isChecking ? "being checked" : "still being archived"}.`
						: "";
				if (refusedNode) {
					// Some refusal messages end with a period and some do not.
					const reason = refusedItems[0]!.message.replace(/\.?$/, ".");
					toast.warning(`"${refusedNode.name}" was not archived: ${reason}${waitingSentence}`, { action });
				} else if (refusedItems.length > 0) {
					toast.warning(`${refusedItems.length} items were not archived.${waitingSentence} See Activity.`, { action });
				} else if (isChecking && waitingNodes.length > 0) {
					const checkingText =
						waitingNodes.length === 1
							? `Checking "${waitingNodes[0]!.name}" before archiving. It stays in the list until the check ends.`
							: `Checking ${waitingNodes.length} items before archiving. They stay in the list until the check ends.`;
					toast.info(`${checkingText} See Activity.`, { action });
				} else {
					toast.info("Archiving in the background. See Activity.", { action });
				}
				// A background job can still refuse more items later. The host learns only about the ones it
				// stamped. Every host closes the dialog only in `onArchived`, so close it here when the job
				// stamped none yet. An empty list would also move the host's focus.
				const keptNodeIdSet = new Set([...notArchivedNodeIds, ...waitingNodeIds]);
				const archivedNodeIds = nodeIds.filter((nodeId) => !keptNodeIdSet.has(nodeId));
				if (archivedNodeIds.length > 0) {
					onArchived(archivedNodeIds);
				} else {
					handleClose();
				}
			})
			.catch((error: unknown) => {
				console.error("[FilesArchiveModal.handleConfirm] Unexpected async error", { error, nodeIds });
				setError("Failed to archive. Try again.");
			})
			.finally(() => setPending(false));
	});

	return (
		<MyModal open={nodes !== null} setOpen={handleOpenChange}>
			{/* Start on Cancel, the safe choice. Otherwise the name list would take focus first. */}
			<MyModalPopover
				className={"FilesArchiveModal" satisfies FilesArchiveModal_ClassNames}
				initialFocus={cancelRef}
				unmountOnHide
			>
				<MyModalHeader>
					<MyModalHeading>{heading}</MyModalHeading>
					<MyModalDescription>
						Archived items are hidden. You can restore them later.
						{hasFolder ? " Folders are archived with everything inside." : null}
					</MyModalDescription>
				</MyModalHeader>
				{/* Leave out the empty body when there is no list and no refusal to show. */}
				{hasList || error ? (
					<MyModalScrollableArea>
						<div className={"FilesArchiveModal-content" satisfies FilesArchiveModal_ClassNames}>
							{/* One path per line in a read-only text block, so Ctrl+A selects only the paths to copy
							    them. It grows only from Show more: growing on click would move the text under a
							    selection the person is making. */}
							{hasList ? (
								<TextMonospaceBlock
									aria-label="Items to archive"
									text={nodes.map((node) => node.path).join("\n")}
									maxHeight={isListExpanded ? "16lh" : "6lh"}
								/>
							) : null}
							{nodes && nodes.length > 6 ? (
								<MyButton
									className={"FilesArchiveModal-list-toggle" satisfies FilesArchiveModal_ClassNames}
									variant="ghost"
									aria-expanded={isListExpanded}
									onClick={() => setExpandedNodes(isListExpanded ? null : nodes)}
								>
									{isListExpanded ? "Show less" : "Show more"}
								</MyButton>
							) : null}
							{error ? (
								<p role="alert" className={"FilesArchiveModal-error" satisfies FilesArchiveModal_ClassNames}>
									{error}
								</p>
							) : null}
						</div>
					</MyModalScrollableArea>
				) : null}
				<MyModalFooter>
					<MyButton ref={cancelRef} variant="ghost" disabled={pending} onClick={handleClose}>
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

const FilesArchiveRunOutcomes = memo(function FilesArchiveRunOutcomes(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	runId: app_convex_Id<"files_archive_runs">;
}) {
	const outcomes = usePaginatedQuery(app_convex_api.files_archive_runs.list_outcomes, props, { initialNumItems: 50 });
	return (
		<section aria-label="Items that remain">
			<h3>Items that remain</h3>
			{outcomes.status === "LoadingFirstPage" ? <p role="status">Loading results…</p> : null}
			{outcomes.results.map((item) => (
				<div key={item.order}>
					{item.path !== null ? <p>{item.path}</p> : null}
					<p>
						{item.path === null
							? "Permission denied"
							: item.kind === "retained_folder"
								? "This folder remains because it still contains items."
								: item.message}
					</p>
				</div>
			))}
			{outcomes.status === "CanLoadMore" || outcomes.status === "LoadingMore" ? (
				<MyButton
					variant="outline"
					aria-busy={outcomes.status === "LoadingMore" || undefined}
					onClick={() => {
						if (outcomes.status === "CanLoadMore") outcomes.loadMore(50);
					}}
				>
					{outcomes.status === "LoadingMore" ? "Loading…" : "Load more"}
				</MyButton>
			) : null}
		</section>
	);
});

type FilesArchiveRunModal_ResolveArgs = app_convex_FunctionArgs<
	typeof app_convex_api.files_archive_runs.resolve_conflicts
>;

type FilesArchiveRunModal_ClassNames =
	| "FilesArchiveRunModal"
	| "FilesArchiveRunModal-title"
	| "FilesArchiveRunModal-content"
	| "FilesArchiveRunModal-line"
	| "FilesArchiveRunModal-conflict"
	| "FilesArchiveRunModal-path"
	| "FilesArchiveRunModal-section"
	| "FilesArchiveRunModal-heading"
	| "FilesArchiveRunModal-group"
	| "FilesArchiveRunModal-reason"
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
	const idPrefix = `FilesArchiveRunModal-${useId()}`;
	const choiceName = `${idPrefix}-choice`;
	const archivedHeadingId = `${idPrefix}-archived`;
	const notArchivedHeadingId = `${idPrefix}-not-archived`;

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
	const archivedPaths = (run?.archived ?? []).flatMap((item) => (item.path === null ? [] : [item.path]));
	// Name each refusal reason once, with the paths it refused under it. One reason, like a read-only
	// file inside a folder, can refuse many items.
	const notArchivedGroups: Array<{ message: string; paths: string[]; lockedCount: number }> = [];
	for (const item of run?.notArchived ?? []) {
		let group = notArchivedGroups.find((notArchivedGroup) => notArchivedGroup.message === item.message);
		if (!group) {
			group = { message: item.message, paths: [], lockedCount: 0 };
			notArchivedGroups.push(group);
		}
		// The server leaves out the path of an item the person can no longer read.
		if (item.path === null) {
			group.lockedCount += 1;
		} else {
			group.paths.push(item.path);
		}
	}
	// Match the Activity card: a refused item, like a read-only file, is expected and does not make the
	// archive look partly failed. The "Not archived" section below names each refused item.
	const isRefusalOnly =
		run?.kind === "archive" && !run.force && status === "partial" && progress?.failed === 0 && progress.canceled === 0;
	const handledCount = progress
		? progress.completed + progress.skipped + progress.failed + progress.blocked + progress.canceled
		: 0;
	const missedCount = progress ? progress.failed + progress.blocked : 0;
	const verbs = run?.kind === "restore" ? ["Restoring", "Restored"] : ["Archiving", "Archived"];

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
						}[isRefusalOnly ? "succeeded" : run.activity.status];

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
					<MyModalHeading className={"FilesArchiveRunModal-title" satisfies FilesArchiveRunModal_ClassNames}>
						{run ? <ActivityStatusIcon activity={run.activity} isRefusalOnly={isRefusalOnly} /> : null}
						{run?.activity.title ?? "Archive"}
					</MyModalHeading>
					<MyModalDescription role="status">{statusLabel}</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					<div className={"FilesArchiveRunModal-content" satisfies FilesArchiveRunModal_ClassNames}>
						{/* The same bar and line as the Activity card. `total` stays null until the check has found
						    every item. */}
						{progress && isActive && status !== "awaiting_input" ? (
							<MyProgressBar aria-label="Progress" value={handledCount} max={progress.total} />
						) : null}
						{progress ? (
							<p className={"FilesArchiveRunModal-line" satisfies FilesArchiveRunModal_ClassNames}>
								{isActive
									? progress.total === null
										? `${verbs[0]}…`
										: `${verbs[0]} ${handledCount} of ${progress.total} items…`
									: run?.force && status === "partial"
										? `${progress.completed} items moved to Trash. Some items remain.`
										: missedCount > 0
											? `${verbs[1]} ${progress.completed} of ${progress.completed + missedCount} items.`
											: `${verbs[1]} ${progress.completed} ${progress.completed === 1 ? "item" : "items"}.`}
							</p>
						) : null}
						{/* The paths the person picked. A folder counts with everything inside, so the line above can
						    count more items than this list shows. */}
						{archivedPaths.length > 0 ? (
							<section
								className={"FilesArchiveRunModal-section" satisfies FilesArchiveRunModal_ClassNames}
								aria-labelledby={archivedHeadingId}
							>
								<h3
									id={archivedHeadingId}
									className={"FilesArchiveRunModal-heading" satisfies FilesArchiveRunModal_ClassNames}
								>
									{isActive ? "To archive" : "Archived"} ({archivedPaths.length})
								</h3>
								<TextMonospaceBlock
									aria-label={isActive ? "Items to archive" : "Archived items"}
									text={archivedPaths.join("\n")}
									maxHeight="8lh"
								/>
							</section>
						) : null}
						{/* The archive refuses each selected item it cannot change, with everything inside it. Paths
						    stay in the same monospace block as above, and each reason is written once above its paths. */}
						{run && run.notArchived.length > 0 ? (
							<section
								className={"FilesArchiveRunModal-section" satisfies FilesArchiveRunModal_ClassNames}
								aria-labelledby={notArchivedHeadingId}
							>
								<h3
									id={notArchivedHeadingId}
									className={"FilesArchiveRunModal-heading" satisfies FilesArchiveRunModal_ClassNames}
								>
									Not archived ({run.notArchived.length})
								</h3>
								{notArchivedGroups.map((group) => (
									<div
										key={group.message}
										className={"FilesArchiveRunModal-group" satisfies FilesArchiveRunModal_ClassNames}
									>
										<p className={"FilesArchiveRunModal-reason" satisfies FilesArchiveRunModal_ClassNames}>
											{group.message}
										</p>
										{group.paths.length > 0 ? (
											<TextMonospaceBlock
												aria-label={`Not archived: ${group.message}`}
												text={group.paths.join("\n")}
												maxHeight="8lh"
											/>
										) : null}
										{group.lockedCount > 0 ? (
											<p className={"FilesArchiveRunModal-reason" satisfies FilesArchiveRunModal_ClassNames}>
												{group.lockedCount === 1
													? "1 item you cannot open"
													: `${group.lockedCount} items you cannot open`}
											</p>
										) : null}
									</div>
								))}
							</section>
						) : null}
						{run?.force ? <FilesArchiveRunOutcomes membershipId={membershipId} runId={runId} /> : null}
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
								{/* Keep both needs a new name that keeps every path inside the limit. The server says when one fits. */}
								{conflict.canKeepBoth ? (
									<label className={"FilesArchiveRunModal-choice" satisfies FilesArchiveRunModal_ClassNames}>
										<MyRadio
											name={choiceName}
											checked={choice === "keep_both"}
											onChange={() => setChoice("keep_both")}
										/>
										Keep both
									</label>
								) : null}
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
					{/* An archive has no Stop. A restore has Stop only while it waits for a clash choice. */}
					{run?.controls.canStop ? (
						<MyButton variant="secondary" disabled={isSaving || isStopPending} onClick={handleStop}>
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
