import "./files-clipboard.css";

import { createContext, memo, use, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useConvex, useQuery } from "convex/react";
import { ClipboardPaste, Copy, Scissors } from "lucide-react";
import { toast } from "sonner";
import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyRadio } from "@/components/my-radio.tsx";
import {
	MyMenuItem,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
} from "@/components/my-menu.tsx";
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
	app_convex_api,
	type app_convex_Doc,
	type app_convex_FunctionArgs,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { files_ROOT_ID, files_TRANSFER_SELECTION_PAGE_SIZE } from "@/lib/files.ts";

// #region provider
type FilesClipboard = {
	mode: "cut" | "copy";
	sourceIds: app_convex_Id<"files_nodes">[];
	revision: string;
};

type FilesTransferRun = NonNullable<app_convex_FunctionReturnType<typeof app_convex_api.files_transfer.get>>;

const FilesClipboardContext = createContext<{
	clipboard: FilesClipboard | null;
	isPasting: boolean;
	setClipboard: (mode: FilesClipboard["mode"], sourceIds: app_convex_Id<"files_nodes">[]) => void;
	clearClipboard: () => void;
	paste: (targetParentId: app_convex_Doc<"files_nodes">["parentId"]) => void;
	openRun: (runId: app_convex_Id<"files_transfer_runs">) => void;
} | null>(null);

const FilesClipboardProvider = Object.assign(
	memo(function FilesClipboardProvider(props: {
		membershipId: app_convex_Id<"organizations_workspaces_users">;
		children: ReactNode;
	}) {
		const { membershipId, children } = props;
		const convex = useConvex();
		const { pendingStopSourceIds } = AppActivitiesProvider.useContext();
		const currentRuns = useQuery(app_convex_api.files_transfer.list_current, { membershipId });
		const [clipboard, setClipboardValue] = useState<FilesClipboard | null>(null);
		const [runId, setRunId] = useState<app_convex_Id<"files_transfer_runs"> | null>(null);
		const [isRunOpen, setIsRunOpen] = useState(false);
		const [isStarting, setIsStarting] = useState(false);
		const [startError, setStartError] = useState<{ message: string; stopRequested: boolean } | null>(null);
		const run = useQuery(app_convex_api.files_transfer.get, runId ? { membershipId, runId } : "skip");
		const [cutRun, setCutRun] = useState<{
			runId: app_convex_Id<"files_transfer_runs">;
			revision: string;
			finished: boolean;
		} | null>(null);
		// Keep tracking the cut run when Activity opens a different run in the dialog.
		const cutRunResult = useQuery(
			app_convex_api.files_transfer.get,
			cutRun && !cutRun.finished ? { membershipId, runId: cutRun.runId } : "skip",
		);
		const startPendingRef = useRef(false);
		const mountedRef = useRef(true);
		const startRequestRef = useRef<{
			requestId: string;
			clipboard: FilesClipboard;
			targetParentId: app_convex_Doc<"files_nodes">["parentId"];
			runId?: app_convex_Id<"files_transfer_runs">;
			stopRequested?: boolean;
		} | null>(null);
		// A still-loading run list may hide an already-active run, so treat it as busy.
		const isPasting = isStarting || startError !== null || currentRuns === undefined || currentRuns.length > 0;

		useEffect(() => {
			mountedRef.current = true;
			return () => {
				mountedRef.current = false;
			};
		}, []);

		const setClipboard = useFn((mode: FilesClipboard["mode"], sourceIds: app_convex_Id<"files_nodes">[]) => {
			if (sourceIds.length === 0) return;
			setClipboardValue({ mode, sourceIds: [...new Set(sourceIds)], revision: crypto.randomUUID() });
		});

		const clearClipboard = useFn(() => setClipboardValue(null));

		const openRun = useFn((nextRunId: app_convex_Id<"files_transfer_runs">) => {
			setRunId(nextRunId);
			setIsRunOpen(true);
		});

		const isIntakeStopped = useFn((nextRunId: app_convex_Id<"files_transfer_runs">) => {
			const current = run?._id === nextRunId ? run : currentRuns?.find((item) => item._id === nextRunId);
			return (
				!mountedRef.current ||
				pendingStopSourceIds.has(nextRunId) ||
				current?.activity.status === "stopping" ||
				current?.activity.finishedAt !== undefined
			);
		});

		const sendPaste = useFn(() => {
			const request = startRequestRef.current;
			if (!request || startPendingRef.current) return;

			// The ref blocks a second start in the same tick; the state only disables after a render.
			startPendingRef.current = true;
			setIsStarting(true);
			const selection = request.clipboard;
			(async (/* iife */) => {
				let refusal: string | undefined;
				if (!request.stopRequested) {
					// Replay the original selection and pages after a lost reply, even if the clipboard changed.
					const started = await convex.mutation(app_convex_api.files_transfer.start, {
						membershipId,
						requestId: request.requestId,
						kind: selection.mode === "cut" ? "move" : "copy",
						...(selection.mode === "copy" ? { expectedSourceCount: selection.sourceIds.length } : {}),
						sourceIds:
							selection.mode === "copy"
								? selection.sourceIds.slice(0, files_TRANSFER_SELECTION_PAGE_SIZE)
								: selection.sourceIds,
						targetParentId: request.targetParentId,
					});
					refusal = started._nay?.message;
					if (!started._nay) {
						request.runId = started._yay.runId;
						if (mountedRef.current) openRun(request.runId);
						if (selection.mode === "cut") {
							setCutRun({ runId: request.runId, revision: selection.revision, finished: false });
						} else {
							for (
								let offset = files_TRANSFER_SELECTION_PAGE_SIZE;
								offset < selection.sourceIds.length;
								offset += files_TRANSFER_SELECTION_PAGE_SIZE
							) {
								if (isIntakeStopped(request.runId)) break;
								const appended = await convex.mutation(app_convex_api.files_transfer.append_sources, {
									membershipId,
									runId: request.runId,
									offset,
									sourceIds: selection.sourceIds.slice(offset, offset + files_TRANSFER_SELECTION_PAGE_SIZE),
								});
								if (appended._nay) {
									refusal = appended._nay.message;
									break;
								}
							}
							request.stopRequested = !!refusal || isIntakeStopped(request.runId);
							if (!request.stopRequested) {
								const sealed = await convex.mutation(app_convex_api.files_transfer.seal, {
									membershipId,
									runId: request.runId,
								});
								refusal = sealed._nay?.message;
							}
						}
					}
				}
				if (refusal) toast.error(refusal);
				if (request.runId && (refusal || request.stopRequested)) {
					request.stopRequested = true;
					const stopped = await convex.mutation(app_convex_api.files_transfer.stop, {
						membershipId,
						runId: request.runId,
					});
					if (stopped._nay) {
						setStartError({
							message: `${stopped._nay.message}. Stop was not confirmed. Retry to stop this request.`,
							stopRequested: true,
						});
						return;
					}
				}
				startRequestRef.current = null;
				setStartError(null);
			})()
				.catch((error) => {
					console.error("[FilesClipboardProvider.paste] Failed to send paste request", { error });
					setStartError({
						message: request.stopRequested
							? "Stop was not confirmed. Retry to stop this request."
							: "Could not confirm Paste. Retry the same request when connected, or stop it from Activity.",
						stopRequested: !!request.stopRequested,
					});
				})
				.finally(() => {
					startPendingRef.current = false;
					setIsStarting(false);
				});
		});

		const paste = useFn((targetParentId: app_convex_Doc<"files_nodes">["parentId"]) => {
			if (!clipboard || isPasting || startPendingRef.current || startRequestRef.current) return;
			startRequestRef.current = { requestId: crypto.randomUUID(), clipboard, targetParentId };
			sendPaste();
		});

		useEffect(() => {
			if (!cutRunResult || !cutRun || cutRun.finished || cutRunResult.activity.finishedAt === undefined) return;
			const revision = cutRun.revision;
			// Keep the revision so a later retry can finish clearing this Cut.
			setCutRun({ ...cutRun, finished: true });
			setClipboardValue((current) => {
				// A newer Cut or Copy changes the revision, so an older run finishing must not touch it.
				if (current?.revision !== revision) return current;
				const sourceIds = current.sourceIds.filter((id) => !cutRunResult.movedNodeIds.includes(id));
				return sourceIds.length > 0 ? { ...current, sourceIds } : null;
			});
		}, [cutRunResult, cutRun]);

		return (
			<FilesClipboardContext.Provider value={{ clipboard, isPasting, setClipboard, clearClipboard, paste, openRun }}>
				{children}
				{startError && !isRunOpen ? (
					<div>
						<p role="alert">{startError.message}</p>
						<MyButton disabled={isStarting} onClick={sendPaste}>
							{startError.stopRequested ? "Retry Stop" : "Retry Paste"}
						</MyButton>
					</div>
				) : null}
				{isRunOpen && runId ? (
					<FilesTransferRunModal
						key={runId}
						membershipId={membershipId}
						runId={runId}
						run={run}
						startError={startError}
						isStarting={isStarting}
						onResume={sendPaste}
						onRetry={(nextRunId) => {
							if (cutRun?.runId === runId) setCutRun({ ...cutRun, runId: nextRunId, finished: false });
							openRun(nextRunId);
						}}
						onClose={() => setIsRunOpen(false)}
					/>
				) : null}
			</FilesClipboardContext.Provider>
		);
	}),
	{
		useContext() {
			const value = use(FilesClipboardContext);
			if (!value) throw new Error("FilesClipboardProvider.useContext must be used within FilesClipboardProvider");
			return value;
		},
		useHotkeys: useFilesClipboardHotkeys,
	},
);

export { FilesClipboardProvider };

function useFilesClipboardHotkeys(args: {
	target: RefObject<HTMLElement | null>;
	enabled?: boolean;
	getSourceIds: (event: KeyboardEvent, mode: FilesClipboard["mode"]) => app_convex_Id<"files_nodes">[];
	getTargetParentId: (event: KeyboardEvent) => app_convex_Doc<"files_nodes">["parentId"] | null;
}) {
	const { clipboard, isPasting, setClipboard, clearClipboard, paste } = FilesClipboardProvider.useContext();
	const options = { target: args.target, enabled: args.enabled ?? true, preventDefault: false, stopPropagation: false };
	const handleSetClipboard = (event: KeyboardEvent, mode: FilesClipboard["mode"]) => {
		// Leave selected text to the browser's normal copy and cut.
		if (event.defaultPrevented || event.isComposing || document.getSelection()?.isCollapsed === false) return;
		const sourceIds = args.getSourceIds(event, mode);
		if (sourceIds.length === 0) return;
		event.preventDefault();
		setClipboard(mode, sourceIds);
	};
	AppHotkeysProvider.useHotkey("Mod+C", (event) => handleSetClipboard(event, "copy"), options);
	AppHotkeysProvider.useHotkey("Mod+X", (event) => handleSetClipboard(event, "cut"), options);
	AppHotkeysProvider.useHotkey(
		"Mod+V",
		(event) => {
			if (event.defaultPrevented || event.isComposing || !clipboard || isPasting) return;
			const targetParentId = args.getTargetParentId(event);
			if (targetParentId === null) return;
			event.preventDefault();
			paste(targetParentId);
		},
		options,
	);
	AppHotkeysProvider.useHotkey(
		"Escape",
		(event) => {
			// Only a cut marks its rows, so only a cut gets an Escape cancel.
			if (event.defaultPrevented || event.isComposing || clipboard?.mode !== "cut" || isPasting) return;
			event.preventDefault();
			clearClipboard();
		},
		options,
	);
}
// #endregion provider

// #region menu items
export const FilesClipboardMenuItems = memo(function FilesClipboardMenuItems(props: {
	sourceIds: app_convex_Id<"files_nodes">[];
	canCut: boolean;
	canCopy: boolean;
	targetParentId: app_convex_Doc<"files_nodes">["parentId"] | null;
	targetName: string | null;
	canPaste: boolean;
}) {
	const { sourceIds, canCut, canCopy, targetParentId, targetName, canPaste } = props;
	const { clipboard, isPasting, setClipboard, paste } = FilesClipboardProvider.useContext();
	return (
		<>
			<MyMenuItem hideOnClick disabled={!canCut} onClick={() => setClipboard("cut", sourceIds)}>
				<MyMenuItemContent>
					<MyMenuItemContentIcon>
						<Scissors />
					</MyMenuItemContentIcon>
					<MyMenuItemContentPrimary>Cut</MyMenuItemContentPrimary>
				</MyMenuItemContent>
			</MyMenuItem>
			<MyMenuItem hideOnClick disabled={!canCopy} onClick={() => setClipboard("copy", sourceIds)}>
				<MyMenuItemContent>
					<MyMenuItemContentIcon>
						<Copy />
					</MyMenuItemContentIcon>
					<MyMenuItemContentPrimary>Copy</MyMenuItemContentPrimary>
				</MyMenuItemContent>
			</MyMenuItem>
			{targetParentId !== null ? (
				<MyMenuItem
					hideOnClick
					disabled={!canPaste || !clipboard || isPasting}
					aria-description={`Paste into ${targetName}`}
					onClick={() => paste(targetParentId)}
				>
					<MyMenuItemContent>
						<MyMenuItemContentIcon>
							<ClipboardPaste />
						</MyMenuItemContentIcon>
						<MyMenuItemContentPrimary>
							{targetParentId === files_ROOT_ID ? "Paste into root folder" : "Paste"}
						</MyMenuItemContentPrimary>
					</MyMenuItemContent>
				</MyMenuItem>
			) : null}
		</>
	);
});
// #endregion menu items

// #region run modal
type ConflictChoices = app_convex_FunctionArgs<typeof app_convex_api.files_transfer.resolve_conflicts>;

type FilesTransferRunModal_ClassNames =
	| "FilesTransferRunModal"
	| "FilesTransferRunModal-items"
	| "FilesTransferRunModal-defaults"
	| "FilesTransferRunModal-item"
	| "FilesTransferRunModal-path"
	| "FilesTransferRunModal-choice"
	| "FilesTransferRunModal-pages"
	| "FilesTransferRunModal-error";

const FilesTransferRunModal = memo(function FilesTransferRunModal(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	runId: app_convex_Id<"files_transfer_runs">;
	run: FilesTransferRun | null | undefined;
	startError: { message: string; stopRequested: boolean } | null;
	isStarting: boolean;
	onResume: () => void;
	onRetry: (runId: app_convex_Id<"files_transfer_runs">) => void;
	onClose: () => void;
}) {
	const { membershipId, runId, run, startError, isStarting, onResume, onRetry, onClose } = props;
	const convex = useConvex();
	const { pendingStopSourceIds, stop } = AppActivitiesProvider.useContext();
	const [choices, setChoices] = useState<Record<string, ConflictChoices["choices"][number]["choice"]>>({});
	const [applyToRemaining, setApplyToRemaining] = useState<ConflictChoices["applyToRemaining"]>({
		file: null,
		folder: null,
	});
	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const itemPage = useQuery(
		app_convex_api.files_transfer.list_items,
		run
			? {
					membershipId,
					runId,
					paginationOpts: { numItems: 50, cursor: cursors[cursors.length - 1]! },
				}
			: "skip",
	);
	const [isSaving, setIsSaving] = useState(false);
	const retryRequestRef = useRef<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [previousRevision, setPreviousRevision] = useState(run?.revision);
	const conflictChoiceName = `FilesTransferRunModal-${useId()}-choice`;

	if (previousRevision !== run?.revision) {
		setPreviousRevision(run?.revision);
		setChoices({});
		setApplyToRemaining({ file: null, folder: null });
	}

	const status = run?.activity.status;
	const progress = run?.activity.progress;
	const isTerminal = run?.activity.finishedAt !== undefined;
	const isSelecting = run?.step === "uploading" || run?.step === "select" || run?.step === "normalize";
	const isStopPending = pendingStopSourceIds.has(runId);
	const conflicts = itemPage?.page.filter((item) => item.state === "conflict") ?? [];

	const completedLabel =
		run?.publication === "proposal" ? "ready for review" : run?.kind === "move" ? "moved" : "copied";

	const pageChoices = conflicts.map((item) => {
		const remaining = item.source && item.conflictKind === "name_conflict" ? applyToRemaining[item.kind] : null;

		// Replace and Merge need a destination doc to act on. When another item in the same paste claims
		// the name, nothing is there yet, so the bulk choice cannot apply and the user picks per item.
		const choice =
			choices[item.itemId] ?? ((remaining === "replace" || remaining === "merge") && !item.conflict ? null : remaining);

		return {
			itemId: item.itemId,
			choice,
			...(item.conflict && (choice === "replace" || choice === "merge")
				? {
						reviewedTarget: item.conflict.target,
						reviewedVersion: item.conflict.version,
					}
				: {}),
		};
	});

	const canContinue =
		conflicts.length > 0 &&
		pageChoices.every((selected, index) => {
			const item = conflicts[index]!;
			return (
				selected.choice === "skip" ||
				(item.source &&
					item.conflictKind === "name_conflict" &&
					(selected.choice === "keep_both" ||
						(item.conflict !== null &&
							selected.choice === (item.kind === "file" || run?.kind === "move" ? "replace" : "merge"))))
			);
		});

	const statusLabel =
		isStopPending && !isTerminal && status !== "stopping"
			? "Stop requested. Waiting for the server…"
			: !run
				? "Loading…"
				: run.step === "uploading" && !isTerminal && status !== "stopping"
					? "Loading selection…"
					: status === "queued" ||
						  (status === "running" && (isSelecting || run.step === "discover" || run.step === "retry"))
						? "Checking files…"
						: status === "awaiting_input"
							? "Choose how to handle these files."
							: status === "running"
								? run.kind === "move"
									? "Moving files…"
									: "Copying files…"
								: status === "stopping"
									? "Stopping…"
									: status === "succeeded"
										? run.publication === "proposal"
											? "Ready for review."
											: "Completed."
										: status === "canceled"
											? "Stopped."
											: status === "partial"
												? "Some files completed."
												: status === "timed_out"
													? "Timed out."
													: "Failed.";

	const handleStop = useFn(() => {
		if (!run || !run.controls.canStop || isSaving || isStopPending) return;

		setErrorMessage(null);
		stop({ activityId: run.activity._id, sourceId: runId })
			.then((result) => {
				if (result._nay) setErrorMessage(result._nay.message);
			})
			.catch((error) => {
				console.error("[FilesTransferRunModal.handleStop] Failed to stop paste", { error });
				setErrorMessage("Stop was not confirmed. Reconnect and try again.");
			});
	});

	const handleContinue = useFn(() => {
		if (!run || !canContinue || isSaving || isStopPending) return;

		setIsSaving(true);
		setErrorMessage(null);
		convex
			.mutation(app_convex_api.files_transfer.resolve_conflicts, {
				membershipId,
				runId,
				revision: run.revision,
				choices: pageChoices.flatMap((selected) => (selected.choice ? [{ ...selected, choice: selected.choice }] : [])),
				applyToRemaining,
			})
			.then((result) => {
				if (result._nay) setErrorMessage(result._nay.message);
			})
			.catch((error) => {
				console.error("[FilesTransferRunModal.handleContinue] Failed to resolve conflicts", { error });
				setErrorMessage("Could not save your choices. Try again when connected.");
			})
			.finally(() => setIsSaving(false));
	});

	const handleRetry = useFn(() => {
		if (!run?.controls.canRetry || isSaving) return;
		setIsSaving(true);
		setErrorMessage(null);
		if (!retryRequestRef.current) retryRequestRef.current = crypto.randomUUID();
		convex
			.mutation(app_convex_api.files_transfer.retry_remaining, {
				membershipId,
				runId,
				requestId: retryRequestRef.current,
			})
			.then((result) => {
				if (result._nay) {
					retryRequestRef.current = null;
					setErrorMessage(result._nay.message);
					return;
				}
				onRetry(result._yay.runId);
			})
			.catch((error) => {
				console.error("[FilesTransferRunModal.handleRetry] Failed to retry files", { error });
				setErrorMessage("Could not confirm the retry. Try again when connected.");
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
			<MyModalPopover className={"FilesTransferRunModal" satisfies FilesTransferRunModal_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>{!run ? "Paste files" : run.kind === "move" ? "Move files" : "Copy files"}</MyModalHeading>
					<MyModalDescription role="status">
						{run === null ? "This operation is no longer available." : statusLabel}
					</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					{startError ? (
						<div>
							<p role="alert">{startError.message}</p>
							<MyButton disabled={isStarting} onClick={onResume}>
								{startError.stopRequested ? "Retry Stop" : "Retry Paste"}
							</MyButton>
						</div>
					) : null}
					{run?.step === "uploading" && !isTerminal ? (
						<p>
							Copy starts after the full selection arrives. Keep this tab open. If you reload, stop this request in
							Activity and paste again.
						</p>
					) : null}
					{progress && isSelecting ? (
						<p role="status">
							{isTerminal
								? "Selection ended before finding files."
								: "File counts appear after the selection is checked."}
						</p>
					) : null}
					{progress && !isSelecting ? (
						<p role="status">
							{progress.completed} {completedLabel}, {progress.skipped} skipped, {progress.failed} failed,{" "}
							{progress.blocked} need a choice, {progress.canceled} stopped.{" "}
							{progress.total === null
								? `${progress.discovered} found. ${isTerminal ? "Stopped while finding files." : "Finding files…"}`
								: `${Math.max(0, progress.total - progress.completed - progress.skipped - progress.failed - progress.blocked - progress.canceled)} remaining.`}
						</p>
					) : null}
					{run && !isSelecting && itemPage === undefined ? <p role="status">Loading items…</p> : null}
					{itemPage === null ? <p>These items are no longer available.</p> : null}
					{itemPage && !isSelecting ? (
						<div className={"FilesTransferRunModal-items" satisfies FilesTransferRunModal_ClassNames}>
							{itemPage.page.map((item) => {
								const isConflict = status === "awaiting_input" && item.state === "conflict";
								const canChoose = item.source && item.conflictKind === "name_conflict";
								const selectedChoice = choices[item.itemId] ?? (canChoose ? applyToRemaining[item.kind] : null);
								return (
									<fieldset
										key={item.itemId}
										className={"FilesTransferRunModal-item" satisfies FilesTransferRunModal_ClassNames}
										disabled={isSaving || isStopPending}
									>
										<legend className={"FilesTransferRunModal-path" satisfies FilesTransferRunModal_ClassNames}>
											{item.source?.path ?? item.output?.path ?? "Unavailable item"}
										</legend>
										{isConflict ? (
											<>
												<p>
													{!canChoose
														? "This item changed location or is no longer available. Skip it or stop."
														: item.conflict
															? "This name already exists. Keep both adds a unique counter. Skipping a folder skips its contents."
															: "Another item in this paste already uses this name. Keep both adds a unique counter. Skipping a folder skips its contents."}
												</p>
												{canChoose ? (
													<>
														{/* Only Replace and Merge act on a destination doc, so they need one to exist. */}
														{item.conflict ? (
															<>
																<p className={"FilesTransferRunModal-path" satisfies FilesTransferRunModal_ClassNames}>
																	Destination: {item.conflict.path}
																</p>
																<p>
																	{item.kind === "file"
																		? "Replace overwrites the destination file."
																		: run?.kind === "move"
																			? "Replace empty folder removes the empty destination folder."
																			: "Merge adds these files to the destination folder."}
																</p>
															</>
														) : null}
														<label
															className={"FilesTransferRunModal-choice" satisfies FilesTransferRunModal_ClassNames}
														>
															<MyRadio
																name={`${conflictChoiceName}-${item.itemId}`}
																checked={selectedChoice === "keep_both"}
																onChange={() => setChoices((current) => ({ ...current, [item.itemId]: "keep_both" }))}
															/>
															Keep both
														</label>
														{item.conflict ? (
															<label
																className={"FilesTransferRunModal-choice" satisfies FilesTransferRunModal_ClassNames}
															>
																<MyRadio
																	name={`${conflictChoiceName}-${item.itemId}`}
																	checked={
																		selectedChoice ===
																		(item.kind === "file" || run?.kind === "move" ? "replace" : "merge")
																	}
																	onChange={() =>
																		setChoices((current) => ({
																			...current,
																			[item.itemId]: item.kind === "file" || run?.kind === "move" ? "replace" : "merge",
																		}))
																	}
																/>
																{item.kind === "file"
																	? "Replace"
																	: run?.kind === "move"
																		? "Replace empty folder"
																		: "Merge"}
															</label>
														) : null}
													</>
												) : null}
												<label className={"FilesTransferRunModal-choice" satisfies FilesTransferRunModal_ClassNames}>
													<MyRadio
														name={`${conflictChoiceName}-${item.itemId}`}
														checked={selectedChoice === "skip"}
														onChange={() => setChoices((current) => ({ ...current, [item.itemId]: "skip" }))}
													/>
													Skip
												</label>
											</>
										) : (
											<>
												<p>
													{item.state === "completed"
														? run?.publication === "proposal"
															? "Ready for review"
															: "Saved"
														: item.state === "skipped"
															? "Skipped"
															: item.state === "failed"
																? "Failed"
																: item.state === "canceled"
																	? "Stopped"
																	: item.state === "conflict"
																		? "Needs a choice"
																		: "Preparing"}
												</p>
												{item.output ? (
													<p className={"FilesTransferRunModal-path" satisfies FilesTransferRunModal_ClassNames}>
														Destination: {item.output.path}
													</p>
												) : null}
											</>
										)}
										{item.errorMessage ? (
											<p className={"FilesTransferRunModal-error" satisfies FilesTransferRunModal_ClassNames}>
												{item.errorMessage}
											</p>
										) : null}
									</fieldset>
								);
							})}
							{itemPage.page.length === 0 ? <p>No items on this page.</p> : null}
						</div>
					) : null}
					{run && !isSelecting ? (
						<div className={"FilesTransferRunModal-pages" satisfies FilesTransferRunModal_ClassNames}>
							<MyButton
								variant="ghost"
								disabled={isSaving || !itemPage || cursors.length === 1}
								onClick={() => setCursors((current) => current.slice(0, -1))}
							>
								Previous page
							</MyButton>
							<span role="status">Page {cursors.length}</span>
							<MyButton
								variant="ghost"
								disabled={isSaving || !itemPage || itemPage.isDone}
								onClick={() => {
									if (itemPage) setCursors((current) => [...current, itemPage.continueCursor]);
								}}
							>
								Next page
							</MyButton>
						</div>
					) : null}
					{status === "awaiting_input" && run ? (
						<div className={"FilesTransferRunModal-defaults" satisfies FilesTransferRunModal_ClassNames}>
							{(["file", "folder"] as const).map((kind) => (
								<fieldset key={kind} disabled={isSaving || isStopPending}>
									<legend>Apply to remaining {kind} name conflicts</legend>
									{([null, "keep_both", "skip"] as const).map((choice) => (
										<label
											key={choice ?? "ask"}
											className={"FilesTransferRunModal-choice" satisfies FilesTransferRunModal_ClassNames}
										>
											<MyRadio
												name={`${conflictChoiceName}-remaining-${kind}`}
												checked={applyToRemaining[kind] === choice}
												onChange={() => setApplyToRemaining((current) => ({ ...current, [kind]: choice }))}
											/>
											{choice === null ? "Ask each time" : choice === "keep_both" ? "Keep both" : "Skip"}
										</label>
									))}
									{kind === "file" || run.kind === "copy" ? (
										<label className={"FilesTransferRunModal-choice" satisfies FilesTransferRunModal_ClassNames}>
											<MyRadio
												name={`${conflictChoiceName}-remaining-${kind}`}
												checked={applyToRemaining[kind] === (kind === "file" ? "replace" : "merge")}
												onChange={() =>
													setApplyToRemaining((current) =>
														kind === "file" ? { ...current, file: "replace" } : { ...current, folder: "merge" },
													)
												}
											/>
											{kind === "file" ? "Replace" : "Merge"}
										</label>
									) : null}
								</fieldset>
							))}
						</div>
					) : null}
					{errorMessage || run?.activity.errorMessage ? (
						<p role="alert" className={"FilesTransferRunModal-error" satisfies FilesTransferRunModal_ClassNames}>
							{errorMessage ?? run?.activity.errorMessage}
						</p>
					) : null}
				</MyModalScrollableArea>
				<MyModalFooter>
					<MyButton variant="ghost" onClick={onClose}>
						{isTerminal ? "Close" : "Hide"}
					</MyButton>
					{run && !isTerminal ? (
						<MyButton
							variant="secondary"
							disabled={isSaving || isStopPending || !run.controls.canStop}
							onClick={handleStop}
						>
							{run.activity.progress.completed > 0 && run.kind === "copy" ? "Stop and keep completed copies" : "Stop"}
						</MyButton>
					) : null}
					{status === "awaiting_input" && run ? (
						<MyButton disabled={isSaving || isStopPending || !canContinue} onClick={handleContinue}>
							Continue
						</MyButton>
					) : null}
					{run?.controls.canRetry ? (
						<MyButton disabled={isSaving} onClick={handleRetry}>
							Retry remaining files
						</MyButton>
					) : null}
				</MyModalFooter>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion run modal
