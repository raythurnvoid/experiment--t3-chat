import "./files-clipboard.css";

import { createContext, memo, use, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { useConvex, useQuery } from "convex/react";
import { ClipboardPaste, Copy, Scissors, X } from "lucide-react";
import { toast } from "sonner";
import { AppHotkeysProvider } from "@/components/app-hotkeys.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyRadio } from "@/components/my-radio.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
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
import {
	app_convex_api,
	type app_convex_Doc,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { files_ROOT_ID } from "@/lib/files.ts";

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
	pendingStopRunId: app_convex_Id<"files_transfer_runs"> | null;
	setClipboard: (mode: FilesClipboard["mode"], sourceIds: app_convex_Id<"files_nodes">[]) => void;
	clearClipboard: () => void;
	paste: (targetParentId: app_convex_Doc<"files_nodes">["parentId"]) => void;
	stop: (
		runId: app_convex_Id<"files_transfer_runs">,
	) => Promise<app_convex_FunctionReturnType<typeof app_convex_api.files_transfer.stop>>;
	openRun: (runId: app_convex_Id<"files_transfer_runs">) => void;
} | null>(null);

const FilesClipboardProvider = Object.assign(
	memo(function FilesClipboardProvider(props: {
		membershipId: app_convex_Id<"organizations_workspaces_users">;
		children: ReactNode;
	}) {
		const { membershipId, children } = props;
		const convex = useConvex();
		const currentRuns = useQuery(app_convex_api.files_transfer.list_current, { membershipId });
		const [clipboard, setClipboardValue] = useState<FilesClipboard | null>(null);
		const [runId, setRunId] = useState<app_convex_Id<"files_transfer_runs"> | null>(null);
		const [isRunOpen, setIsRunOpen] = useState(false);
		const [isStarting, setIsStarting] = useState(false);
		const [pendingStopRunId, setPendingStopRunId] = useState<app_convex_Id<"files_transfer_runs"> | null>(null);
		const run = useQuery(app_convex_api.files_transfer.get, runId ? { membershipId, runId } : "skip");
		const [cutRun, setCutRun] = useState<{ runId: app_convex_Id<"files_transfer_runs">; revision: string } | null>(
			null,
		);
		// Keep tracking the cut run when Activity opens a different run in the dialog.
		const cutRunResult = useQuery(
			app_convex_api.files_transfer.get,
			cutRun ? { membershipId, runId: cutRun.runId } : "skip",
		);
		const startPendingRef = useRef(false);
		const startRequestRef = useRef<{
			requestId: string;
			revision: string;
			targetParentId: app_convex_Doc<"files_nodes">["parentId"];
		} | null>(null);
		// A still-loading run list may hide an already-active run, so treat it as busy.
		const isPasting = isStarting || currentRuns === undefined || currentRuns.length > 0;

		const setClipboard = useFn((mode: FilesClipboard["mode"], sourceIds: app_convex_Id<"files_nodes">[]) => {
			if (sourceIds.length === 0) return;
			setClipboardValue({ mode, sourceIds: [...new Set(sourceIds)], revision: crypto.randomUUID() });
		});

		const clearClipboard = useFn(() => setClipboardValue(null));

		const openRun = useFn((nextRunId: app_convex_Id<"files_transfer_runs">) => {
			setRunId(nextRunId);
			setIsRunOpen(true);
		});

		const paste = useFn((targetParentId: app_convex_Doc<"files_nodes">["parentId"]) => {
			if (!clipboard || isPasting || startPendingRef.current) return;

			// The ref blocks a second start in the same tick; the state only disables after a render.
			startPendingRef.current = true;
			setIsStarting(true);
			// Keep the same request after a lost response, so a retry cannot start a second run.
			if (
				startRequestRef.current?.revision !== clipboard.revision ||
				startRequestRef.current.targetParentId !== targetParentId
			) {
				startRequestRef.current = { requestId: crypto.randomUUID(), revision: clipboard.revision, targetParentId };
			}
			convex
				.mutation(app_convex_api.files_transfer.start, {
					membershipId,
					requestId: startRequestRef.current.requestId,
					kind: clipboard.mode === "cut" ? "move" : "copy",
					sourceIds: clipboard.sourceIds,
					targetParentId,
				})
				.then((result) => {
					if (result._nay) {
						startRequestRef.current = null;
						toast.error(result._nay.message);
						return;
					}
					startRequestRef.current = null;
					if (clipboard.mode === "cut") {
						setCutRun({ runId: result._yay.runId, revision: clipboard.revision });
					}
					openRun(result._yay.runId);
				})
				.catch((error) => {
					console.error("[FilesClipboardProvider.paste] Failed to start paste", { error });
					toast.error("Could not confirm Paste. Try again when connected.");
				})
				.finally(() => {
					startPendingRef.current = false;
					setIsStarting(false);
				});
		});

		const stop = useFn((runId: app_convex_Id<"files_transfer_runs">) => {
			// Keep the pending request visible after the dialog or Activity closes.
			setPendingStopRunId(runId);
			return convex
				.mutation(app_convex_api.files_transfer.stop, { membershipId, runId })
				.finally(() => setPendingStopRunId(null));
		});

		useEffect(() => {
			if (!cutRunResult || !cutRun || !["completed", "canceled", "failed"].includes(cutRunResult.phase)) return;
			const revision = cutRun.revision;
			setCutRun(null);
			if (cutRunResult.phase !== "completed") return;
			setClipboardValue((current) => {
				// A newer Cut or Copy changes the revision, so an older run finishing must not touch it.
				if (current?.revision !== revision) return current;
				const sourceIds = current.sourceIds.filter((id) => !cutRunResult.movedNodeIds.includes(id));
				return sourceIds.length > 0 ? { ...current, sourceIds } : null;
			});
		}, [cutRunResult, cutRun]);

		return (
			<FilesClipboardContext.Provider
				value={{ clipboard, isPasting, pendingStopRunId, setClipboard, clearClipboard, paste, stop, openRun }}
			>
				{children}
				{isRunOpen && runId ? (
					<FilesTransferRunModal
						key={runId}
						membershipId={membershipId}
						runId={runId}
						run={run}
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

// #region toolbar
type FilesClipboardToolbar_ClassNames = "FilesClipboardToolbar" | "FilesClipboardToolbar-status";

export const FilesClipboardToolbar = memo(function FilesClipboardToolbar(props: {
	targetParentId: app_convex_Doc<"files_nodes">["parentId"] | null;
	targetName: string;
	canPaste: boolean;
	isBusy?: boolean;
}) {
	const { targetParentId, targetName, canPaste, isBusy = false } = props;
	const { clipboard, isPasting, clearClipboard, paste } = FilesClipboardProvider.useContext();
	const descriptionId = `FilesClipboardToolbar-${useId()}-description`;
	const disabledReason = !clipboard
		? "Choose files with Cut or Copy first."
		: isPasting
			? "A paste is already running in this workspace."
			: isBusy
				? "Wait for the current file operation to finish."
				: !canPaste || targetParentId === null
					? "You cannot paste into this folder."
					: null;
	return (
		<div className={"FilesClipboardToolbar" satisfies FilesClipboardToolbar_ClassNames}>
			<span role="status" className={"FilesClipboardToolbar-status" satisfies FilesClipboardToolbar_ClassNames}>
				{clipboard ? `${clipboard.sourceIds.length} ready to ${clipboard.mode === "cut" ? "move" : "copy"}` : ""}
			</span>
			<MyIconButton
				variant="ghost-highlightable"
				tooltip={disabledReason ?? `Paste into ${targetName}`}
				aria-label="Paste files"
				aria-describedby={descriptionId}
				disabled={disabledReason !== null}
				onClick={() => {
					if (targetParentId !== null) paste(targetParentId);
				}}
			>
				<MyIconButtonIcon>
					<ClipboardPaste />
				</MyIconButtonIcon>
			</MyIconButton>
			<span id={descriptionId} className="sr-only">
				Paste into {targetName}. {disabledReason}
			</span>
			{clipboard ? (
				<MyIconButton variant="ghost-highlightable" tooltip="Clear file clipboard" onClick={clearClipboard}>
					<MyIconButtonIcon>
						<X />
					</MyIconButtonIcon>
				</MyIconButton>
			) : null}
		</div>
	);
});
// #endregion toolbar

// #region run modal
type FilesTransferRunModal_ClassNames =
	| "FilesTransferRunModal"
	| "FilesTransferRunModal-conflicts"
	| "FilesTransferRunModal-conflict"
	| "FilesTransferRunModal-path"
	| "FilesTransferRunModal-choice"
	| "FilesTransferRunModal-error";

const FilesTransferRunModal = memo(function FilesTransferRunModal(props: {
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	runId: app_convex_Id<"files_transfer_runs">;
	run: FilesTransferRun | null | undefined;
	onClose: () => void;
}) {
	const { membershipId, runId, run, onClose } = props;
	const convex = useConvex();
	const { pendingStopRunId, stop } = FilesClipboardProvider.useContext();
	const [choices, setChoices] = useState<Record<string, "keep_both" | "skip">>({});
	const [applyToRemaining, setApplyToRemaining] = useState<"keep_both" | "skip" | null>(null);
	const [isSaving, setIsSaving] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [previousRevision, setPreviousRevision] = useState(run?.revision);
	const conflictChoiceName = `FilesTransferRunModal-${useId()}-choice`;

	if (previousRevision !== run?.revision) {
		setPreviousRevision(run?.revision);
		setChoices({});
		setApplyToRemaining(null);
	}

	const isTerminal = run?.phase === "completed" || run?.phase === "canceled" || run?.phase === "failed";
	const isStopPending = pendingStopRunId === runId;
	const completedLabel = run?.kind === "move" ? "moved" : "copied";
	const statusLabel =
		isStopPending && !isTerminal && run?.phase !== "stopping"
			? "Stop requested. Waiting for the server…"
			: !run
				? "Loading…"
				: run.phase === "checking"
					? "Checking files…"
					: run.phase === "awaiting_choice"
						? "Choose how to handle these files."
						: run.phase === "running"
							? run.kind === "move"
								? "Moving files…"
								: "Copying files…"
							: run.phase === "stopping"
								? "Stopping…"
								: run.phase === "completed"
									? "Completed."
									: run.phase === "canceled"
										? "Stopped."
										: "Failed.";

	const handleStop = useFn(() => {
		if (isSaving || isStopPending) return;

		setErrorMessage(null);
		stop(runId)
			.then((result) => {
				if (result._nay) setErrorMessage(result._nay.message);
			})
			.catch((error) => {
				console.error("[FilesTransferRunModal.handleStop] Failed to stop paste", { error });
				setErrorMessage("Stop was not confirmed. Reconnect and try again.");
			});
	});

	const handleContinue = useFn(() => {
		if (!run || isSaving || isStopPending) return;

		setIsSaving(true);
		setErrorMessage(null);
		convex
			.mutation(app_convex_api.files_transfer.resolve_conflicts, {
				membershipId,
				runId,
				revision: run.revision,
				choices: run.conflicts.map((conflict) => ({
					itemId: conflict.itemId,
					choice: choices[conflict.itemId] ?? applyToRemaining ?? "skip",
				})),
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
					{run ? (
						<p role="status">
							{run.completed} {completedLabel}, {run.skipped} skipped, {run.failed} failed,{" "}
							{Math.max(0, run.total - run.completed - run.skipped - run.failed)} remaining.
						</p>
					) : null}
					{run?.phase === "awaiting_choice" ? (
						<div className={"FilesTransferRunModal-conflicts" satisfies FilesTransferRunModal_ClassNames}>
							{run.conflicts.map((conflict) => (
								<fieldset
									key={conflict.itemId}
									className={"FilesTransferRunModal-conflict" satisfies FilesTransferRunModal_ClassNames}
									disabled={isSaving || isStopPending}
								>
									<legend className={"FilesTransferRunModal-path" satisfies FilesTransferRunModal_ClassNames}>
										{conflict.sourcePath ?? "Unavailable item"}
									</legend>
									<p>
										{conflict.kind === "name_conflict"
											? `${conflict.targetName ?? "This name"} already exists. Keep both adds a unique counter. Skipping a folder skips its contents.`
											: "This item changed location or is no longer available. Skip it or stop."}
									</p>
									{conflict.kind === "name_conflict" ? (
										<label className={"FilesTransferRunModal-choice" satisfies FilesTransferRunModal_ClassNames}>
											<MyRadio
												name={`${conflictChoiceName}-${conflict.itemId}`}
												checked={choices[conflict.itemId] === "keep_both"}
												onChange={() => setChoices((current) => ({ ...current, [conflict.itemId]: "keep_both" }))}
											/>
											Keep both
										</label>
									) : null}
									<label className={"FilesTransferRunModal-choice" satisfies FilesTransferRunModal_ClassNames}>
										<MyRadio
											name={`${conflictChoiceName}-${conflict.itemId}`}
											checked={choices[conflict.itemId] === "skip"}
											onChange={() => setChoices((current) => ({ ...current, [conflict.itemId]: "skip" }))}
										/>
										Skip
									</label>
								</fieldset>
							))}
							<fieldset disabled={isSaving || isStopPending}>
								<legend>Apply to remaining name conflicts</legend>
								<label className={"FilesTransferRunModal-choice" satisfies FilesTransferRunModal_ClassNames}>
									<MyRadio
										name={`${conflictChoiceName}-remaining`}
										checked={applyToRemaining === null}
										onChange={() => setApplyToRemaining(null)}
									/>
									Ask each time
								</label>
								<label className={"FilesTransferRunModal-choice" satisfies FilesTransferRunModal_ClassNames}>
									<MyRadio
										name={`${conflictChoiceName}-remaining`}
										checked={applyToRemaining === "keep_both"}
										onChange={() => setApplyToRemaining("keep_both")}
									/>
									Keep both
								</label>
								<label className={"FilesTransferRunModal-choice" satisfies FilesTransferRunModal_ClassNames}>
									<MyRadio
										name={`${conflictChoiceName}-remaining`}
										checked={applyToRemaining === "skip"}
										onChange={() => setApplyToRemaining("skip")}
									/>
									Skip
								</label>
							</fieldset>
						</div>
					) : null}
					{errorMessage || run?.errorMessage ? (
						<p role="alert" className={"FilesTransferRunModal-error" satisfies FilesTransferRunModal_ClassNames}>
							{errorMessage ?? run?.errorMessage}
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
							disabled={isSaving || isStopPending || run.phase === "stopping"}
							onClick={handleStop}
						>
							{run.completed > 0 && run.kind === "copy" ? "Stop and keep completed copies" : "Cancel"}
						</MyButton>
					) : null}
					{run?.phase === "awaiting_choice" ? (
						<MyButton
							disabled={
								isSaving ||
								isStopPending ||
								run.conflicts.some(
									(conflict) => !choices[conflict.itemId] && !(conflict.kind === "name_conflict" && applyToRemaining),
								)
							}
							onClick={handleContinue}
						>
							Continue
						</MyButton>
					) : null}
				</MyModalFooter>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion run modal
