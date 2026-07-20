import "./file-editor-sidebar-pending.css";
import { CheckCheck, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPatch } from "diff";
import { useConvex, useQuery } from "convex/react";
import { toast } from "sonner";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyLink } from "@/components/my-link.tsx";
import { DiffMonospaceBlock } from "@/components/monospace-block/monospace-block-diff.tsx";
import { files_truncate_path_for_width } from "@/lib/file-paths.ts";
import {
	files_ROOT_ID,
	files_pending_update_has_yjs_content,
	files_yjs_doc_create_from_array_buffer_update,
	files_yjs_doc_get_markdown,
} from "@/lib/files.ts";
import { async_all_settled_with_limit, delay } from "@/lib/async.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { APP_FONT_FAMILY } from "@/lib/ui.tsx";
import { cn } from "@/lib/utils.ts";

// Keep these Pretext metrics in sync with `.FileEditorSidebarPending-item-path-text`;
// duplicating them here avoids `getComputedStyle` during path resize work.
const PENDING_PATH_FONT = `500 16px ${APP_FONT_FAMILY}`;
const PENDING_PATH_LETTER_SPACING = 0;

const PENDING_MISSING_PATH_LABEL = "(unknown file)";

// "Stale save" is the only benign `_nay` literal: the server returns it before any write when a
// Save's read went stale (another tab, the agent). The pending update doc survives and the
// reactive queries show the truth, so it is not a failure.
const PENDING_BENIGN_NAY_MESSAGES = new Set(["Stale save"]);

type FileEditorSidebarPendingRow = {
	pendingUpdate: app_convex_Doc<"files_pending_updates">;
	path: string;
	kind: "content" | "move" | "copy" | "content_and_move";
	nodeKind: app_convex_Doc<"files_nodes">["kind"] | undefined;
	moveDestinationPath: string | undefined;
	/**
	 * Name of the active node that accepting this move will replace (soft-archive, like `mv -f`):
	 * the node that occupies the destination path right now, ignoring the declared replace target.
	 * File moves replace a file occupant; folder moves replace an EMPTY folder occupant (rename()
	 * semantics). Unset when nothing occupies the destination (accept is then a plain move), when
	 * the occupant has this user's own pending move (it vacates first), and for other kind mixes.
	 * Editable-file replaces use `replaceSourcePath` instead.
	 */
	replacesName: string | undefined;
	/** True when the proposal created the file (write_file/cp onto a new path): shown as Added. */
	isAddedFile: boolean;
	/**
	 * Source path of an `mv -f` content replace: accepting puts that file's content on this row's
	 * file (as a new version) and archives the source. Shown as a "source → target" label.
	 */
	replaceSourcePath: string | undefined;
};

/**
 * Pair each pending update with its file path and sort by path (the list query returns pending
 * update docs in creation order). Rows whose file node is missing from `list_tree` keep a
 * fallback label so the user can still discard them. The row `kind` is derived from field
 * presence: `pendingMove` marks a move (plus content when the Yjs fields are set), `copiedFrom`
 * marks a copy.
 */
function build_pending_rows(
	pendingUpdates: readonly app_convex_Doc<"files_pending_updates">[],
	nodesById: Map<app_convex_Id<"files_nodes">, app_convex_Doc<"files_nodes">>,
): FileEditorSidebarPendingRow[] {
	// Active nodes keyed by path, to spot the occupant a pending move's accept would replace.
	const activeNodesByPath = new Map(
		Array.from(nodesById.values())
			.filter((node) => node.archiveOperationId === undefined)
			.map((node) => [node.path, node] as const),
	);
	// Files this user's own pending move will vacate: accept forces their move first,
	// so they are never left at a destination to replace.
	const movingNodeIds = new Set(
		pendingUpdates.filter((update) => update.pendingMove != null).map((update) => update.fileNodeId),
	);
	// Folders that count as non-empty: a folder occupant is only replaced when it is empty
	// (rename() semantics), so a non-empty one gets no "Replaces" caption. Accept-time
	// validation also counts this user's pending moves INTO the folder as occupancy, so a
	// pending destination parent is non-empty too.
	const parentIdsWithActiveChildren = new Set(
		Array.from(nodesById.values())
			.filter((node) => node.archiveOperationId === undefined)
			.map((node) => node.parentId),
	);
	for (const update of pendingUpdates) {
		if (update.pendingMove) {
			parentIdsWithActiveChildren.add(update.pendingMove.destParentId);
		}
	}

	return pendingUpdates
		.map((pendingUpdate) => {
			const node = nodesById.get(pendingUpdate.fileNodeId);
			const { pendingMove, copiedFrom } = pendingUpdate;

			const kind = pendingMove
				? files_pending_update_has_yjs_content(pendingUpdate)
					? ("content_and_move" as const)
					: ("move" as const)
				: copiedFrom
					? ("copy" as const)
					: ("content" as const);

			let moveDestinationPath: string | undefined;
			let replacesName: string | undefined;
			if (pendingMove) {
				if (pendingMove.destParentId === files_ROOT_ID) {
					moveDestinationPath = `/${pendingMove.destName}`;
				} else {
					const destParent = nodesById.get(pendingMove.destParentId);
					moveDestinationPath = destParent ? `${destParent.path}/${pendingMove.destName}` : `…/${pendingMove.destName}`;
				}

				// Accepting replaces (soft-archives) whichever node occupies the destination path at
				// that moment, so the caption only trusts live path occupancy — a declared `mv -f`
				// target that was renamed or moved away is no longer the one replaced. No occupant,
				// or the node itself, means accept degrades to a plain move: no indicator.
				// Auto-replace is file-onto-file, or folder-onto-EMPTY-folder (rename() semantics);
				// other kind mixes keep the plain caption (accept surfaces the conflict).
				// An occupant with its own pending move vacates before this one applies: no replace.
				const replacedNode = activeNodesByPath.get(moveDestinationPath);
				const replaceKindsMatch =
					node?.kind === "file"
						? replacedNode?.kind === "file"
						: node?.kind === "folder" &&
							replacedNode?.kind === "folder" &&
							!parentIdsWithActiveChildren.has(replacedNode._id);
				if (
					replacedNode &&
					replaceKindsMatch &&
					replacedNode._id !== pendingUpdate.fileNodeId &&
					!movingNodeIds.has(replacedNode._id)
				) {
					replacesName = replacedNode.name;
				}
			}

			return {
				pendingUpdate,
				path: node?.path ?? pendingMove?.fromPath ?? PENDING_MISSING_PATH_LABEL,
				kind,
				nodeKind: node?.kind,
				moveDestinationPath,
				replacesName,
				isAddedFile: pendingUpdate.eagerCreated != null,
				replaceSourcePath: copiedFrom?.archivesSourceOnAccept
					? (nodesById.get(copiedFrom.nodeId)?.path ?? copiedFrom.path)
					: undefined,
			};
		})
		.sort((left, right) => left.path.localeCompare(right.path));
}

const PendingPathText = memo(function PendingPathText(props: { path: string; className?: string }) {
	const { path, className } = props;
	const pathRef = useRef<HTMLSpanElement>(null);
	const [displayPath, setDisplayPath] = useState(path);

	useLayoutEffect(() => {
		const pathElement = pathRef.current;
		const linkElement = pathElement?.closest("a");
		if (!pathElement || !linkElement) {
			setDisplayPath(path);
			return;
		}

		let cancelled = false;

		const updateDisplayPath = (width?: number) => {
			const availableWidth = width ?? linkElement.clientWidth;
			if (availableWidth <= 0) {
				if (!cancelled) {
					setDisplayPath(path);
				}
				return;
			}

			const nextDisplayPath = files_truncate_path_for_width({
				path,
				width: availableWidth,
				font: PENDING_PATH_FONT,
				letterSpacing: PENDING_PATH_LETTER_SPACING,
			});

			if (!cancelled) {
				setDisplayPath(nextDisplayPath);
			}
		};

		updateDisplayPath();

		const resizeObserver =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver((entries) => {
						updateDisplayPath(entries[0]?.contentRect.width);
					});
		resizeObserver?.observe(linkElement);
		void document.fonts?.ready.then(() => updateDisplayPath());

		return () => {
			cancelled = true;
			resizeObserver?.disconnect();
		};
	}, [path]);

	return (
		<span
			ref={pathRef}
			className={cn("FileEditorSidebarPending-item-path-text" satisfies FileEditorSidebarPending_ClassNames, className)}
		>
			{displayPath}
		</span>
	);
});

/** Old path in red strikethrough → new path in green. Shared by move-only and content-plus-move rows. */
const PendingMoveLabel = memo(function PendingMoveLabel(props: { path: string; moveDestinationPath: string }) {
	const { path, moveDestinationPath } = props;
	return (
		<span className={cn("FileEditorSidebarPending-item-move-label" satisfies FileEditorSidebarPending_ClassNames)}>
			<span
				className={cn("FileEditorSidebarPending-item-move-label-from" satisfies FileEditorSidebarPending_ClassNames)}
			>
				{path}
			</span>
			{" → "}
			<span className={cn("FileEditorSidebarPending-item-move-label-to" satisfies FileEditorSidebarPending_ClassNames)}>
				{moveDestinationPath}
			</span>
		</span>
	);
});

function decode_staged_unstaged(pendingUpdate: app_convex_Doc<"files_pending_updates">) {
	if (!files_pending_update_has_yjs_content(pendingUpdate)) {
		return Result({ _nay: { message: "Pending update has no content to decode" } });
	}

	const stagedYjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdate.stagedBranchYjsUpdate);
	const stagedMarkdown = files_yjs_doc_get_markdown({ yjsDoc: stagedYjsDoc });
	if (stagedMarkdown._nay) return stagedMarkdown;

	const unstagedYjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdate.unstagedBranchYjsUpdate);
	const unstagedMarkdown = files_yjs_doc_get_markdown({ yjsDoc: unstagedYjsDoc });
	if (unstagedMarkdown._nay) return unstagedMarkdown;

	return Result({ _yay: { stagedMarkdown: stagedMarkdown._yay, unstagedMarkdown: unstagedMarkdown._yay } });
}

async function files_pending_accept_and_save(
	convex: ReturnType<typeof useConvex>,
	membershipId: app_convex_Id<"organizations_workspaces_users">,
	pendingUpdate: app_convex_Doc<"files_pending_updates">,
) {
	const decoded = decode_staged_unstaged(pendingUpdate);
	if (decoded._nay) return decoded;

	const upserted = await convex.action(app_convex_api.files_pending_updates.upsert_file_pending_update, {
		membershipId,
		nodeId: pendingUpdate.fileNodeId,
		pendingUpdateId: pendingUpdate._id,
		stagedMarkdown: decoded._yay.unstagedMarkdown,
		unstagedMarkdown: decoded._yay.unstagedMarkdown,
	});
	if (upserted._nay) return upserted;

	return await convex.action(app_convex_api.files_pending_updates.save_file_pending_update, {
		membershipId,
		nodeId: pendingUpdate.fileNodeId,
		pendingUpdateId: pendingUpdate._id,
	});
}

async function files_pending_discard(
	convex: ReturnType<typeof useConvex>,
	membershipId: app_convex_Id<"organizations_workspaces_users">,
	pendingUpdate: app_convex_Doc<"files_pending_updates">,
) {
	const decoded = decode_staged_unstaged(pendingUpdate);
	if (decoded._nay) return decoded;

	return await convex.action(app_convex_api.files_pending_updates.upsert_file_pending_update, {
		membershipId,
		nodeId: pendingUpdate.fileNodeId,
		pendingUpdateId: pendingUpdate._id,
		stagedMarkdown: decoded._yay.stagedMarkdown,
		unstagedMarkdown: decoded._yay.stagedMarkdown,
	});
}

/**
 * Accept a pending update doc per its kind: move-only → apply the move; content-only/copy → the
 * existing accept-and-save path; content-plus-move → apply the move first, then accept-and-save
 * the content.
 */
async function files_pending_row_accept(
	convex: ReturnType<typeof useConvex>,
	membershipId: app_convex_Id<"organizations_workspaces_users">,
	pendingUpdate: app_convex_Doc<"files_pending_updates">,
) {
	if (pendingUpdate.pendingMove) {
		const moved = await convex.mutation(app_convex_api.files_pending_updates.apply_file_pending_move, {
			membershipId,
			nodeId: pendingUpdate.fileNodeId,
		});
		// A move `_nay` is a real conflict (missing or settled pending update docs resolve as
		// no-op `_yay`), so a content-plus-move accept stops here instead of saving content
		// onto a failed move.
		if (moved._nay || !files_pending_update_has_yjs_content(pendingUpdate)) return moved;
	}

	return await files_pending_accept_and_save(convex, membershipId, pendingUpdate);
}

/**
 * Discard a pending update doc per its kind: content-only → the existing content-revert upsert;
 * move-only → the structural discard only; copy and eager-created docs → the structural discard
 * directly (it hard-deletes or fully removes the doc, which subsumes the content, and a revert
 * would hit a dead id); content-plus-move → revert the content first, then discard the move.
 * The structural discard is idempotent (missing doc or no structural aspect → `_yay`), so a
 * bulk retry after a partial attempt settles as a no-op; any `_nay` is a real conflict.
 */
async function files_pending_row_discard(
	convex: ReturnType<typeof useConvex>,
	membershipId: app_convex_Id<"organizations_workspaces_users">,
	pendingUpdate: app_convex_Doc<"files_pending_updates">,
) {
	if (!pendingUpdate.pendingMove && !pendingUpdate.copiedFrom && !pendingUpdate.eagerCreated) {
		return await files_pending_discard(convex, membershipId, pendingUpdate);
	}

	if (files_pending_update_has_yjs_content(pendingUpdate) && !pendingUpdate.copiedFrom && !pendingUpdate.eagerCreated) {
		const reverted = await files_pending_discard(convex, membershipId, pendingUpdate);
		if (reverted._nay) return reverted;
	}

	return await convex.mutation(app_convex_api.files_pending_updates.discard_file_pending_structural, {
		membershipId,
		nodeId: pendingUpdate.fileNodeId,
	});
}

/**
 * Run a bulk action over the rows, at most 5 units at a time in FIFO order. Chained moves (a row
 * moving onto the committed path of another pending move) join one unit that runs sequentially,
 * predecessor first, because the server rejects accepting a move whose destination occupant still
 * has its own pending move. The write mutations share per-user rate limits, so a row that gets
 * "Rate limit exceeded" (the literal from `rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE`, not
 * importable here because the module is server-only) waits 5s and retries, up to 6 times, instead
 * of silently staying behind. A thrown mutation (for example a Convex write conflict on the shared
 * rate-limiter table) retries the same way and counts as a failure when retries run out. Returns
 * the number of rows that still failed.
 */
async function files_pending_rows_run_bulk(
	rows: FileEditorSidebarPendingRow[],
	run: (row: FileEditorSidebarPendingRow) => Promise<{ _nay?: { message?: string } | null }>,
) {
	// Group rows into dependency units. `moveDestinationPath` is the committed destination path,
	// so it matches the committed `path` of the row it depends on. Move cycles (swaps) can exist;
	// the chain-membership check stops the walk there, and the cycle lands in one unit — the
	// server accepts a whole swap cycle atomically from its first accepted member.
	const moveRowByPath = new Map(
		rows.filter((row) => row.pendingUpdate.pendingMove != null).map((row) => [row.path, row]),
	);
	const units: FileEditorSidebarPendingRow[][] = [];
	const unitByRow = new Map<FileEditorSidebarPendingRow, FileEditorSidebarPendingRow[]>();
	for (const row of rows) {
		if (unitByRow.has(row)) {
			continue;
		}
		const chain = [row];
		let head = row;
		let attachedUnit: FileEditorSidebarPendingRow[] | undefined;
		while (true) {
			const predecessor =
				head.pendingUpdate.pendingMove != null && head.moveDestinationPath != null
					? moveRowByPath.get(head.moveDestinationPath)
					: undefined;
			if (!predecessor || chain.includes(predecessor)) {
				break;
			}
			attachedUnit = unitByRow.get(predecessor);
			if (attachedUnit) {
				break;
			}
			chain.unshift(predecessor);
			head = predecessor;
		}
		const unit = attachedUnit ?? [];
		if (!attachedUnit) {
			units.push(unit);
		}
		for (const chainRow of chain) {
			unit.push(chainRow);
			unitByRow.set(chainRow, unit);
		}
	}

	const results = await async_all_settled_with_limit(units, 5, async (unit) => {
		const unitResults: Array<{ _nay?: { message?: string } | null }> = [];
		for (const row of unit) {
			// Catch throws into the result shape so the retry loop and the failure count below
			// see them; without this a thrown mutation would skip the retries and lose the row's
			// action.
			const runRow = () =>
				run(row).then(
					(result) => ({ result, threw: false, error: undefined as unknown }),
					(error: unknown) => ({
						result: { _nay: { message: error instanceof Error ? error.message : "Bulk action failed" } },
						threw: true,
						error,
					}),
				);

			let outcome = await runRow();
			for (
				let attempt = 0;
				(outcome.threw || outcome.result._nay?.message === "Rate limit exceeded") && attempt < 6;
				attempt++
			) {
				await delay(5_000);
				outcome = await runRow();
			}
			if (outcome.threw) {
				console.error("[FileEditorSidebarPending] Bulk action kept throwing for a row", {
					error: outcome.error,
					nodeId: row.pendingUpdate.fileNodeId,
				});
			}
			unitResults.push(outcome.result);
		}
		return unitResults;
	});

	let failures = 0;
	for (const [index, result] of results.entries()) {
		if (result.status === "rejected") {
			console.error("[FileEditorSidebarPending] Bulk action failed for a unit of rows", {
				error: result.reason,
			});
			failures += units[index]?.length ?? 0;
		} else {
			for (const rowResult of result.value) {
				// A non-benign `_nay` here is a real conflict: pending update docs that settled or
				// vanished under this bulk run already resolve as no-op `_yay` on the server.
				if (rowResult._nay && !PENDING_BENIGN_NAY_MESSAGES.has(rowResult._nay.message ?? "")) {
					failures += 1;
				}
			}
		}
	}
	return failures;
}

// #region item
type FileEditorSidebarPendingItem_Props = {
	pendingUpdate: app_convex_Doc<"files_pending_updates">;
	path: string;
	kind: FileEditorSidebarPendingRow["kind"];
	moveDestinationPath: string | undefined;
	replacesName: string | undefined;
	isAddedFile: boolean;
	replaceSourcePath: string | undefined;
	disabled?: boolean;
	onActionSuccess: (message: string) => void;
};

const FileEditorSidebarPendingItem = memo(function FileEditorSidebarPendingItem(
	props: FileEditorSidebarPendingItem_Props,
) {
	const {
		pendingUpdate,
		path,
		kind,
		moveDestinationPath,
		replacesName,
		isAddedFile,
		replaceSourcePath,
		disabled,
		onActionSuccess,
	} = props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const convex = useConvex();

	const [isOpen, setIsOpen] = useState(false);
	const [isBusy, setIsBusy] = useState(false);

	// Decode lazily: `files_yjs_doc_get_markdown` spins up a headless Tiptap editor, so only build the
	// diff once the accordion is open. The pending-update prop ref changes only when the doc data changes.
	const diffText = useMemo(() => {
		if (!isOpen) return null;
		const decoded = decode_staged_unstaged(pendingUpdate);
		if (decoded._nay) {
			return null;
		}
		return createPatch(path, decoded._yay.stagedMarkdown, decoded._yay.unstagedMarkdown);
	}, [isOpen, pendingUpdate, path]);

	const handleToggle = useFn((event: { currentTarget: HTMLDetailsElement }) => {
		setIsOpen(event.currentTarget.open);
	});

	// The chevron is a real <button>, so clicking it does not trigger the native <summary> toggle.
	// Drive the controlled `open` state directly (and `preventDefault` so the native toggle can't race it).
	const handleChevronToggle = useFn((event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		setIsOpen((open) => !open);
	});

	// Names the row for the action buttons' aria-labels and the panel's status announcements, so
	// "Accept" reads as for example "Accept move of /a.md to /b.md".
	const actionLabel =
		(kind === "move" || kind === "content_and_move") && moveDestinationPath != null
			? `move of ${path} to ${moveDestinationPath}`
			: `changes to ${path}`;

	// `preventDefault()` stops the native <summary> from toggling when the action buttons are clicked.
	const handleAccept = useFn((event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		if (isBusy) return;
		setIsBusy(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const result = await files_pending_row_accept(convex, membershipId, pendingUpdate);
			if (result._nay) {
				// "Stale save" means the pending update doc changed under this click (another tab,
				// the agent); the reactive query already renders the real state — no error.
				if (result._nay.message !== "Stale save") {
					toast.error(result._nay.message ?? "Failed to accept pending changes");
				}
			} else {
				onActionSuccess(`Accepted ${actionLabel}`);
			}
		})()
			.catch((error) => {
				console.error("[FileEditorSidebarPending] Failed to accept", {
					error,
					nodeId: pendingUpdate.fileNodeId,
				});
				toast.error(error instanceof Error ? error.message : "Failed to accept pending changes");
			})
			.finally(() => {
				setIsBusy(false);
			});
	});

	const handleDiscard = useFn((event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		if (isBusy) return;
		setIsBusy(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const result = await files_pending_row_discard(convex, membershipId, pendingUpdate);
			if (result._nay) {
				// A `_nay` is a real conflict: a pending update doc that settled or vanished under
				// this click (another tab, the agent) already resolves as a no-op `_yay` on the server.
				toast.error(result._nay.message ?? "Failed to discard pending changes");
			} else {
				onActionSuccess(`Discarded ${actionLabel}`);
			}
		})()
			.catch((error) => {
				console.error("[FileEditorSidebarPending] Failed to discard", {
					error,
					nodeId: pendingUpdate.fileNodeId,
				});
				toast.error(error instanceof Error ? error.message : "Failed to discard pending changes");
			})
			.finally(() => {
				setIsBusy(false);
			});
	});

	// Move-only rows have no content to diff: render a plain row (no accordion, no diff link)
	// with the source and destination paths in a single truncatable label.
	if (kind === "move") {
		const moveLabel = moveDestinationPath != null ? `${path} → ${moveDestinationPath}` : path;
		return (
			<li>
				<div
					className={cn(
						"FileEditorSidebarPending-item" satisfies FileEditorSidebarPending_ClassNames,
						"FileEditorSidebarPending-item-move" satisfies FileEditorSidebarPending_ClassNames,
					)}
				>
					<MyLink
						className={cn("FileEditorSidebarPending-item-path" satisfies FileEditorSidebarPending_ClassNames)}
						to="/w/$organizationName/$workspaceName/files"
						params={{ organizationName, workspaceName }}
						search={{ nodeId: pendingUpdate.fileNodeId }}
						aria-label={moveLabel}
						title={moveLabel}
					>
						{moveDestinationPath != null ? (
							<PendingMoveLabel path={path} moveDestinationPath={moveDestinationPath} />
						) : (
							<span
								className={cn("FileEditorSidebarPending-item-move-label" satisfies FileEditorSidebarPending_ClassNames)}
							>
								{path}
							</span>
						)}
						<span className={cn("FileEditorSidebarPending-item-caption" satisfies FileEditorSidebarPending_ClassNames)}>
							{replacesName != null ? `Replaces ${replacesName}` : "Moved"}
						</span>
					</MyLink>
					<span className={cn("FileEditorSidebarPending-item-actions" satisfies FileEditorSidebarPending_ClassNames)}>
						<MyButton
							variant="ghost"
							className={cn("FileEditorSidebarPending-accept" satisfies FileEditorSidebarPending_ClassNames)}
							aria-label={`Accept ${actionLabel}`}
							aria-busy={isBusy}
							disabled={isBusy || disabled}
							onClick={handleAccept}
						>
							Accept
						</MyButton>
						<MyButton
							variant="ghost_destructive"
							aria-label={`Discard ${actionLabel}`}
							aria-busy={isBusy}
							disabled={isBusy || disabled}
							onClick={handleDiscard}
						>
							Discard
						</MyButton>
					</span>
				</div>
			</li>
		);
	}

	// Short neutral helper describing what accepting does, always visible. The replace indicator
	// wins the slot: a move onto an occupied destination archives that file, so name it live.
	// Replace-moves and non-eager-created copies replace the target's content (a replace-move also
	// archives the source). Plain edits show Modified.
	const caption =
		replacesName != null
			? `Replaces ${replacesName}`
			: isAddedFile
				? "Added"
				: kind === "content_and_move"
					? "Moved"
					: kind === "copy"
						? "Replaced"
						: "Modified";

	// Content-plus-move rows show the same red → green move label as move-only rows; the link
	// still opens the diff. Replace-move rows (`mv -f`) show "source → target": the source
	// disappears (red) and its content lands on the target (green).
	const rowLabel =
		kind === "content_and_move" && moveDestinationPath != null
			? `${path} → ${moveDestinationPath}`
			: replaceSourcePath != null
				? `${replaceSourcePath} → ${path}`
				: path;

	return (
		<li>
			<details
				className={cn("FileEditorSidebarPending-item" satisfies FileEditorSidebarPending_ClassNames)}
				open={isOpen}
				onToggle={handleToggle}
			>
				<summary className={cn("FileEditorSidebarPending-item-summary" satisfies FileEditorSidebarPending_ClassNames)}>
					<MyIconButton aria-hidden tabIndex={-1} variant="ghost-highlightable" onClick={handleChevronToggle}>
						<MyIconButtonIcon>{isOpen ? <ChevronDown /> : <ChevronRight />}</MyIconButtonIcon>
					</MyIconButton>
					<MyLink
						className={cn("FileEditorSidebarPending-item-path" satisfies FileEditorSidebarPending_ClassNames)}
						to="/w/$organizationName/$workspaceName/files"
						params={{ organizationName, workspaceName }}
						search={{ nodeId: pendingUpdate.fileNodeId, view: "diff_editor" }}
						aria-label={rowLabel}
						title={rowLabel}
					>
						{kind === "content_and_move" && moveDestinationPath != null ? (
							<PendingMoveLabel path={path} moveDestinationPath={moveDestinationPath} />
						) : replaceSourcePath != null ? (
							<PendingMoveLabel path={replaceSourcePath} moveDestinationPath={path} />
						) : (
							<PendingPathText
								path={path}
								className={cn(
									isAddedFile &&
										("FileEditorSidebarPending-item-path-text-added" satisfies FileEditorSidebarPending_ClassNames),
								)}
							/>
						)}
						<span className={cn("FileEditorSidebarPending-item-caption" satisfies FileEditorSidebarPending_ClassNames)}>
							{caption}
						</span>
					</MyLink>
					<span className={cn("FileEditorSidebarPending-item-actions" satisfies FileEditorSidebarPending_ClassNames)}>
						<MyButton
							variant="ghost"
							className={cn("FileEditorSidebarPending-accept" satisfies FileEditorSidebarPending_ClassNames)}
							aria-label={`Accept ${actionLabel}`}
							aria-busy={isBusy}
							disabled={isBusy || disabled}
							onClick={handleAccept}
						>
							Accept
						</MyButton>
						<MyButton
							variant="ghost_destructive"
							aria-label={`Discard ${actionLabel}`}
							aria-busy={isBusy}
							disabled={isBusy || disabled}
							onClick={handleDiscard}
						>
							Discard
						</MyButton>
					</span>
				</summary>
				{isOpen && diffText != null ? (
					<DiffMonospaceBlock
						className={cn("FileEditorSidebarPending-item-diff" satisfies FileEditorSidebarPending_ClassNames)}
						diffText={diffText}
						maxHeight="16lh"
					/>
				) : null}
			</details>
		</li>
	);
});
// #endregion item

// #region root
export type FileEditorSidebarPending_ClassNames =
	| "FileEditorSidebarPending"
	| "FileEditorSidebarPending-empty"
	| "FileEditorSidebarPending-status"
	| "FileEditorSidebarPending-header"
	| "FileEditorSidebarPending-header-button"
	| "FileEditorSidebarPending-header-icon"
	| "FileEditorSidebarPending-accept"
	| "FileEditorSidebarPending-list"
	| "FileEditorSidebarPending-item"
	| "FileEditorSidebarPending-item-summary"
	| "FileEditorSidebarPending-item-path"
	| "FileEditorSidebarPending-item-path-text"
	| "FileEditorSidebarPending-item-actions"
	| "FileEditorSidebarPending-item-diff"
	| "FileEditorSidebarPending-item-move"
	| "FileEditorSidebarPending-item-move-label"
	| "FileEditorSidebarPending-item-move-label-from"
	| "FileEditorSidebarPending-item-move-label-to"
	| "FileEditorSidebarPending-item-caption"
	| "FileEditorSidebarPending-item-path-text-added";

export const FileEditorSidebarPending = memo(function FileEditorSidebarPending() {
	const { membershipId } = AppTenantProvider.useContext();
	const convex = useConvex();

	const [isBulkBusy, setIsBulkBusy] = useState(false);

	// Settled signal for screen readers and automation: successful actions write into this
	// `role="status"` live region imperatively, so no React re-render is needed to announce.
	// Failures already announce through the sonner toasts.
	const statusRef = useRef<HTMLSpanElement>(null);

	const announceActionSuccess = useFn((message: string) => {
		const statusElement = statusRef.current;
		if (statusElement) {
			statusElement.textContent = message;
		}
	});

	const pendingUpdates = useQuery(app_convex_api.files_pending_updates.list_files_pending_updates, { membershipId });
	const fileNodesList = useStableQuery(app_convex_api.files_nodes.list_tree, { membershipId });

	const rows = ((/* iife */) => {
		const nodesById = new Map((fileNodesList ?? []).map((node) => [node._id, node] as const));
		return build_pending_rows(pendingUpdates ?? [], nodesById);
	})();

	const handleAcceptAll = useFn(() => {
		if (isBulkBusy) return;
		setIsBulkBusy(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const failures = await files_pending_rows_run_bulk(rows, (row) =>
				files_pending_row_accept(convex, membershipId, row.pendingUpdate),
			);
			if (failures > 0) {
				toast.error(`Failed to accept ${failures} of ${rows.length} pending changes`);
			} else {
				announceActionSuccess(`Accepted ${rows.length} pending changes`);
			}
		})()
			.catch((error) => {
				console.error("[FileEditorSidebarPending] Failed to accept all", { error });
				toast.error(error instanceof Error ? error.message : "Failed to accept pending changes");
			})
			.finally(() => {
				setIsBulkBusy(false);
			});
	});

	const handleDiscardAll = useFn(() => {
		if (isBulkBusy) return;
		setIsBulkBusy(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const failures = await files_pending_rows_run_bulk(rows, (row) =>
				files_pending_row_discard(convex, membershipId, row.pendingUpdate),
			);
			if (failures > 0) {
				toast.error(`Failed to discard ${failures} of ${rows.length} pending changes`);
			} else {
				announceActionSuccess(`Discarded ${rows.length} pending changes`);
			}
		})()
			.catch((error) => {
				console.error("[FileEditorSidebarPending] Failed to discard all", { error });
				toast.error(error instanceof Error ? error.message : "Failed to discard pending changes");
			})
			.finally(() => {
				setIsBulkBusy(false);
			});
	});

	// The status span stays first in both branches so React keeps the same DOM node (and its
	// pending announcement) when accepting the last row switches the panel to the empty state.
	const statusElement = (
		<span
			ref={statusRef}
			role="status"
			className={cn("FileEditorSidebarPending-status" satisfies FileEditorSidebarPending_ClassNames, "sr-only")}
		/>
	);

	if (rows.length === 0) {
		return (
			<>
				{statusElement}
				<div className={cn("FileEditorSidebarPending-empty" satisfies FileEditorSidebarPending_ClassNames)}>
					No pending changes
				</div>
			</>
		);
	}

	return (
		<>
			{statusElement}
			<div
				className={cn("FileEditorSidebarPending" satisfies FileEditorSidebarPending_ClassNames)}
				role="region"
				aria-label="Pending changes"
			>
				<div className={cn("FileEditorSidebarPending-header" satisfies FileEditorSidebarPending_ClassNames)}>
					<MyButton
						variant="ghost"
						className={cn(
							"FileEditorSidebarPending-header-button" satisfies FileEditorSidebarPending_ClassNames,
							"FileEditorSidebarPending-accept" satisfies FileEditorSidebarPending_ClassNames,
						)}
						aria-label="Accept all pending changes"
						aria-busy={isBulkBusy}
						disabled={isBulkBusy}
						onClick={handleAcceptAll}
					>
						<MyButtonIcon
							className={cn("FileEditorSidebarPending-header-icon" satisfies FileEditorSidebarPending_ClassNames)}
						>
							<CheckCheck />
						</MyButtonIcon>
						Accept all
					</MyButton>
					<MyButton
						variant="ghost_destructive"
						className={cn("FileEditorSidebarPending-header-button" satisfies FileEditorSidebarPending_ClassNames)}
						aria-label="Discard all pending changes"
						aria-busy={isBulkBusy}
						disabled={isBulkBusy}
						onClick={handleDiscardAll}
					>
						<MyButtonIcon
							className={cn("FileEditorSidebarPending-header-icon" satisfies FileEditorSidebarPending_ClassNames)}
						>
							<Trash2 />
						</MyButtonIcon>
						Discard all
					</MyButton>
				</div>
				<ul className={cn("FileEditorSidebarPending-list" satisfies FileEditorSidebarPending_ClassNames)}>
					{rows.map((row) => (
						<FileEditorSidebarPendingItem
							key={row.pendingUpdate._id}
							pendingUpdate={row.pendingUpdate}
							path={row.path}
							kind={row.kind}
							moveDestinationPath={row.moveDestinationPath}
							replacesName={row.replacesName}
							isAddedFile={row.isAddedFile}
							replaceSourcePath={row.replaceSourcePath}
							disabled={isBulkBusy}
							onActionSuccess={announceActionSuccess}
						/>
					))}
				</ul>
			</div>
		</>
	);
});
// #endregion root

// The NODE_ENV check comes first so client builds erase this block; `import.meta.vitest` is
// only defined when vitest runs this file.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	const makePendingUpdate = (args: {
		id: string;
		fileNodeId: string;
		staged?: string;
		unstaged?: string;
		pendingMove?: { destParentId: string; destName: string; fromPath: string; replacesNodeId?: string };
		copiedFrom?: { nodeId: string; path: string; archivesSourceOnAccept?: boolean };
		eagerCreated?: { committedSequence: number };
	}) =>
		({
			_id: args.id,
			fileNodeId: args.fileNodeId,
			// Move-only docs leave all 4 Yjs fields unset, like the server does.
			...(args.staged != null && args.unstaged != null
				? {
						baseYjsSequence: 0,
						baseYjsUpdate: "",
						stagedBranchYjsUpdate: args.staged,
						unstagedBranchYjsUpdate: args.unstaged,
					}
				: {}),
			...(args.pendingMove ? { pendingMove: args.pendingMove } : {}),
			...(args.copiedFrom ? { copiedFrom: args.copiedFrom } : {}),
			...(args.eagerCreated ? { eagerCreated: args.eagerCreated } : {}),
		}) as unknown as app_convex_Doc<"files_pending_updates">;

	const makeNode = (args: { id: string; path: string; kind?: "file" | "folder"; parentId?: string }) =>
		({
			_id: args.id,
			path: args.path,
			name: args.path.split("/").pop() ?? args.path,
			kind: args.kind ?? "file",
			parentId: args.parentId ?? "root",
		}) as unknown as app_convex_Doc<"files_nodes">;

	const makeNodesById = (nodes: app_convex_Doc<"files_nodes">[]) =>
		new Map(nodes.map((node) => [node._id, node] as const));

	describe("build_pending_rows", () => {
		test("sorts rows by path regardless of input order", () => {
			const updates = [
				makePendingUpdate({ id: "pu_z", fileNodeId: "node_z", staged: "s", unstaged: "u" }),
				makePendingUpdate({ id: "pu_a", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
				makePendingUpdate({ id: "pu_m", fileNodeId: "node_m", staged: "s", unstaged: "u" }),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_z", path: "zebra/notes.md" }),
				makeNode({ id: "node_a", path: "alpha/intro.md" }),
				makeNode({ id: "node_m", path: "mid/readme.md" }),
			]);

			const rows = build_pending_rows(updates, nodesById);

			expect(rows.map((row) => row.path)).toEqual(["alpha/intro.md", "mid/readme.md", "zebra/notes.md"]);
		});

		test("keeps a fallback label when the file node is missing", () => {
			const updates = [makePendingUpdate({ id: "pu_x", fileNodeId: "node_missing", staged: "s", unstaged: "u" })];
			const rows = build_pending_rows(updates, new Map());

			expect(rows).toHaveLength(1);
			expect(rows[0]?.path).toBe("(unknown file)");
		});

		test("derives row kinds from field presence", () => {
			const pendingMove = { destParentId: files_ROOT_ID, destName: "dest.md", fromPath: "/from.md" };
			const updates = [
				makePendingUpdate({ id: "pu_content", fileNodeId: "node_a", staged: "s", unstaged: "u" }),
				makePendingUpdate({ id: "pu_move", fileNodeId: "node_b", pendingMove }),
				makePendingUpdate({
					id: "pu_copy",
					fileNodeId: "node_c",
					staged: "s",
					unstaged: "u",
					copiedFrom: { nodeId: "node_src", path: "/source.md" },
				}),
				makePendingUpdate({ id: "pu_mixed", fileNodeId: "node_d", staged: "s", unstaged: "u", pendingMove }),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_a", path: "/a.md" }),
				makeNode({ id: "node_b", path: "/b.md" }),
				makeNode({ id: "node_c", path: "/c.md" }),
				makeNode({ id: "node_d", path: "/d.md" }),
			]);

			const rows = build_pending_rows(updates, nodesById);

			expect(rows.map((row) => row.kind)).toEqual(["content", "move", "copy", "content_and_move"]);
		});

		test("resolves the move destination path from the tree", () => {
			const updates = [
				makePendingUpdate({
					id: "pu_root",
					fileNodeId: "node_a",
					pendingMove: { destParentId: files_ROOT_ID, destName: "a.md", fromPath: "/from/a.md" },
				}),
				makePendingUpdate({
					id: "pu_nested",
					fileNodeId: "node_b",
					pendingMove: { destParentId: "node_docs", destName: "b.md", fromPath: "/from/b.md" },
				}),
				makePendingUpdate({
					id: "pu_missing",
					fileNodeId: "node_c",
					pendingMove: { destParentId: "node_gone", destName: "c.md", fromPath: "/from/c.md" },
				}),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_a", path: "/from/a.md" }),
				makeNode({ id: "node_b", path: "/from/b.md" }),
				makeNode({ id: "node_c", path: "/from/c.md" }),
				makeNode({ id: "node_docs", path: "/docs", kind: "folder" }),
			]);

			const rows = build_pending_rows(updates, nodesById);

			expect(rows.map((row) => row.moveDestinationPath)).toEqual(["/a.md", "/docs/b.md", "…/c.md"]);
		});

		test("keeps the node kind and falls back to fromPath when the source node is missing", () => {
			const updates = [
				makePendingUpdate({
					id: "pu_folder",
					fileNodeId: "node_folder",
					pendingMove: { destParentId: files_ROOT_ID, destName: "archive", fromPath: "/old-archive" },
				}),
				makePendingUpdate({
					id: "pu_gone",
					fileNodeId: "node_gone",
					pendingMove: { destParentId: files_ROOT_ID, destName: "gone.md", fromPath: "/from/gone.md" },
				}),
			];
			const nodesById = makeNodesById([makeNode({ id: "node_folder", path: "/old-archive", kind: "folder" })]);

			const rows = build_pending_rows(updates, nodesById);

			expect(rows[0]?.path).toBe("/from/gone.md");
			expect(rows[0]?.nodeKind).toBeUndefined();
			expect(rows[1]?.path).toBe("/old-archive");
			expect(rows[1]?.nodeKind).toBe("folder");
		});

		test("derives the replaced occupant name for move rows from live path occupancy only", () => {
			const updates = [
				// Destination occupied by another file → its name.
				makePendingUpdate({
					id: "pu_occupied",
					fileNodeId: "node_m1",
					pendingMove: { destParentId: files_ROOT_ID, destName: "taken.md", fromPath: "/m1.md" },
				}),
				// Free destination → no indicator.
				makePendingUpdate({
					id: "pu_free",
					fileNodeId: "node_m2",
					pendingMove: { destParentId: files_ROOT_ID, destName: "free.md", fromPath: "/m2.md" },
				}),
				// Destination resolves to the node itself → no indicator.
				makePendingUpdate({
					id: "pu_self",
					fileNodeId: "node_m3",
					pendingMove: { destParentId: files_ROOT_ID, destName: "m3.md", fromPath: "/old-m3.md" },
				}),
				// Declared replace target left the destination path and nothing else occupies it →
				// accept archives nothing, so no indicator.
				makePendingUpdate({
					id: "pu_declared",
					fileNodeId: "node_m4",
					pendingMove: {
						destParentId: files_ROOT_ID,
						destName: "somewhere.md",
						fromPath: "/m4.md",
						replacesNodeId: "node_declared",
					},
				}),
				// Declared target gone and the destination free → degrades to a plain move.
				makePendingUpdate({
					id: "pu_declared_gone",
					fileNodeId: "node_m5",
					pendingMove: {
						destParentId: files_ROOT_ID,
						destName: "vacant.md",
						fromPath: "/m5.md",
						replacesNodeId: "node_gone",
					},
				}),
				// Empty folder occupant: folder-onto-EMPTY-folder follows rename() semantics → its name.
				makePendingUpdate({
					id: "pu_folder_move",
					fileNodeId: "node_m6",
					pendingMove: { destParentId: files_ROOT_ID, destName: "taken-folder", fromPath: "/m6" },
				}),
				// Non-empty folder occupant: never replaced → no indicator.
				makePendingUpdate({
					id: "pu_folder_move_full",
					fileNodeId: "node_m8",
					pendingMove: { destParentId: files_ROOT_ID, destName: "full-folder", fromPath: "/m8" },
				}),
				// Folder occupant with no committed children but another pending move targeting
				// INTO it: accept-time validation counts that as occupancy → no indicator.
				makePendingUpdate({
					id: "pu_folder_move_claimed",
					fileNodeId: "node_m9",
					pendingMove: { destParentId: files_ROOT_ID, destName: "claimed-folder", fromPath: "/m9" },
				}),
				makePendingUpdate({
					id: "pu_into_claimed",
					fileNodeId: "node_incoming",
					pendingMove: { destParentId: "node_claimed_folder", destName: "incoming.md", fromPath: "/incoming.md" },
				}),
				// Occupant with its own pending move by the same user: accept forces that move
				// first, so nothing is left at the destination to replace → no indicator.
				makePendingUpdate({
					id: "pu_chained",
					fileNodeId: "node_m7",
					pendingMove: { destParentId: files_ROOT_ID, destName: "vacating.md", fromPath: "/m7.md" },
				}),
				makePendingUpdate({
					id: "pu_vacating",
					fileNodeId: "node_vacating",
					pendingMove: { destParentId: files_ROOT_ID, destName: "elsewhere.md", fromPath: "/vacating.md" },
				}),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_m1", path: "/m1.md" }),
				makeNode({ id: "node_m2", path: "/m2.md" }),
				makeNode({ id: "node_m3", path: "/m3.md" }),
				makeNode({ id: "node_m4", path: "/m4.md" }),
				makeNode({ id: "node_m5", path: "/m5.md" }),
				makeNode({ id: "node_m6", path: "/m6", kind: "folder" }),
				makeNode({ id: "node_m7", path: "/m7.md" }),
				makeNode({ id: "node_m8", path: "/m8", kind: "folder" }),
				makeNode({ id: "node_m9", path: "/m9", kind: "folder" }),
				makeNode({ id: "node_incoming", path: "/incoming.md" }),
				makeNode({ id: "node_claimed_folder", path: "/claimed-folder", kind: "folder" }),
				makeNode({ id: "node_vacating", path: "/vacating.md" }),
				makeNode({ id: "node_taken", path: "/taken.md" }),
				makeNode({ id: "node_declared", path: "/renamed-target.md" }),
				makeNode({ id: "node_taken_folder", path: "/taken-folder", kind: "folder" }),
				makeNode({ id: "node_full_folder", path: "/full-folder", kind: "folder" }),
				makeNode({ id: "node_full_child", path: "/full-folder/keep.md", parentId: "node_full_folder" }),
			]);

			const rows = build_pending_rows(updates, nodesById);

			expect(rows.map((row) => [row.path, row.replacesName])).toEqual([
				["/incoming.md", undefined],
				["/m1.md", "taken.md"],
				["/m2.md", undefined],
				["/m3.md", undefined],
				["/m4.md", undefined],
				["/m5.md", undefined],
				["/m6", "taken-folder"],
				["/m7.md", undefined],
				["/m8", undefined],
				["/m9", undefined],
				["/vacating.md", undefined],
			]);
		});

		test("marks rows whose proposal created the file as added", () => {
			const updates = [
				makePendingUpdate({
					id: "pu_added",
					fileNodeId: "node_a",
					staged: "s",
					unstaged: "u",
					eagerCreated: { committedSequence: 0 },
				}),
				makePendingUpdate({ id: "pu_edit", fileNodeId: "node_b", staged: "s", unstaged: "u" }),
			];
			const nodesById = makeNodesById([
				makeNode({ id: "node_a", path: "/a.md" }),
				makeNode({ id: "node_b", path: "/b.md" }),
			]);

			const rows = build_pending_rows(updates, nodesById);

			expect(rows.map((row) => row.isAddedFile)).toEqual([true, false]);
		});
	});
}
