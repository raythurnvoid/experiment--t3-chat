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

type FileEditorSidebarPendingRow = {
	pendingUpdate: app_convex_Doc<"files_pending_updates">;
	path: string;
	kind: "content" | "move" | "copy" | "content_and_move";
	nodeKind: app_convex_Doc<"files_nodes">["kind"] | undefined;
	moveDestinationPath: string | undefined;
	/**
	 * True for structural `mv -f` replaces (non-editable target): accepting archives the file at
	 * the destination path. Editable-file replaces use `replaceSourcePath` instead.
	 */
	moveReplacesExistingFile: boolean;
	/** True when the proposal created the file (write_file/cp onto a new path): shown as Added. */
	isAddedFile: boolean;
	/**
	 * Source path of an `mv -f` content replace: accepting puts that file's content on this row's
	 * file (as a new version) and archives the source. Shown as a "source → target" label.
	 */
	replaceSourcePath: string | undefined;
};

/**
 * Pair each pending update with its file path and sort by path (the list query returns rows in
 * creation order). Rows whose file node is missing from `list_tree` keep a fallback label so the
 * user can still discard them. The row `kind` is derived from field presence: `pendingMove`
 * marks a move (plus content when the Yjs fields are set), `copiedFrom` marks a copy.
 */
function build_pending_rows(
	pendingUpdates: readonly app_convex_Doc<"files_pending_updates">[],
	nodesById: Map<app_convex_Id<"files_nodes">, app_convex_Doc<"files_nodes">>,
): FileEditorSidebarPendingRow[] {
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
			if (pendingMove) {
				if (pendingMove.destParentId === files_ROOT_ID) {
					moveDestinationPath = `/${pendingMove.destName}`;
				} else {
					const destParent = nodesById.get(pendingMove.destParentId);
					moveDestinationPath = destParent ? `${destParent.path}/${pendingMove.destName}` : `…/${pendingMove.destName}`;
				}
			}

			return {
				pendingUpdate,
				path: node?.path ?? pendingMove?.fromPath ?? PENDING_MISSING_PATH_LABEL,
				kind,
				nodeKind: node?.kind,
				moveDestinationPath,
				moveReplacesExistingFile: pendingMove?.replacesNodeId != null,
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

		const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
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

/** Old path in red strikethrough → new path in green. Shared by pure move and mixed rows. */
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
 * Accept a pending row per its kind: pure move → apply the move; content/copy → the existing
 * accept-and-save path; content + move → apply the move first, then accept-and-save the content.
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
			pendingUpdateId: pendingUpdate._id,
		});
		if (moved._nay || !files_pending_update_has_yjs_content(pendingUpdate)) return moved;
	}

	return await files_pending_accept_and_save(convex, membershipId, pendingUpdate);
}

/**
 * Discard a pending row per its kind: plain content → the existing content-revert upsert; pure
 * move, copy, or eagerly-created file → the structural discard (an eager discard hard-deletes the
 * eagerly-created destination node, so the content-revert upsert must never run for it);
 * content + move → revert the content first (the server degrades the row to a pure move), then
 * discard the move.
 */
async function files_pending_row_discard(
	convex: ReturnType<typeof useConvex>,
	membershipId: app_convex_Id<"organizations_workspaces_users">,
	pendingUpdate: app_convex_Doc<"files_pending_updates">,
) {
	if (pendingUpdate.pendingMove && files_pending_update_has_yjs_content(pendingUpdate)) {
		const reverted = await files_pending_discard(convex, membershipId, pendingUpdate);
		if (reverted._nay) return reverted;
	} else if (!pendingUpdate.pendingMove && !pendingUpdate.copiedFrom && !pendingUpdate.eagerCreated) {
		return await files_pending_discard(convex, membershipId, pendingUpdate);
	}

	return await convex.mutation(app_convex_api.files_pending_updates.discard_file_pending_structural, {
		membershipId,
		nodeId: pendingUpdate.fileNodeId,
		pendingUpdateId: pendingUpdate._id,
	});
}

/**
 * Run a bulk action over the rows, at most 5 at a time in FIFO order. The write mutations share
 * per-user rate limits, so a row that gets "Rate limit exceeded" (the literal from
 * `rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE`, not importable here because the module is
 * server-only) waits 5s and retries, up to 6 times, instead of silently staying behind. Returns
 * the number of rows that still failed.
 */
async function files_pending_rows_run_bulk(
	rows: FileEditorSidebarPendingRow[],
	run: (pendingUpdate: app_convex_Doc<"files_pending_updates">) => Promise<{ _nay?: { message?: string } | null }>,
) {
	const results = await async_all_settled_with_limit(rows, 5, async (row) => {
		let result = await run(row.pendingUpdate);
		for (let attempt = 0; result._nay?.message === "Rate limit exceeded" && attempt < 6; attempt++) {
			await delay(5_000);
			result = await run(row.pendingUpdate);
		}
		return result;
	});

	let failures = 0;
	for (const [index, result] of results.entries()) {
		if (result.status === "rejected") {
			console.error("[FileEditorSidebarPending] Bulk action failed for a row", {
				error: result.reason,
				nodeId: rows[index]?.pendingUpdate.fileNodeId,
			});
			failures += 1;
		} else if (result.value._nay) {
			failures += 1;
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
	moveReplacesExistingFile: boolean;
	isAddedFile: boolean;
	replaceSourcePath: string | undefined;
	disabled?: boolean;
};

const FileEditorSidebarPendingItem = memo(function FileEditorSidebarPendingItem(
	props: FileEditorSidebarPendingItem_Props,
) {
	const { pendingUpdate, path, kind, moveDestinationPath, moveReplacesExistingFile, isAddedFile, replaceSourcePath, disabled } =
		props;
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();
	const convex = useConvex();

	const [isOpen, setIsOpen] = useState(false);
	const [isBusy, setIsBusy] = useState(false);

	// Decode lazily: `files_yjs_doc_get_markdown` spins up a headless Tiptap editor, so only build the
	// diff once the accordion is open. The pending-update prop ref changes only when the row data changes.
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

	// `preventDefault()` stops the native <summary> from toggling when the action buttons are clicked.
	const handleAccept = useFn((event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		if (isBusy) return;
		setIsBusy(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const result = await files_pending_row_accept(convex, membershipId, pendingUpdate);
			if (result._nay) {
				toast.error(result._nay.message ?? "Failed to accept pending changes");
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
				toast.error(result._nay.message ?? "Failed to discard pending changes");
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

	// Pure move rows have no content to diff: render a plain row (no accordion, no diff link)
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
							{moveReplacesExistingFile ? "Replaced" : "Moved"}
						</span>
					</MyLink>
					<span className={cn("FileEditorSidebarPending-item-actions" satisfies FileEditorSidebarPending_ClassNames)}>
						<MyButton
							variant="ghost"
							className={cn("FileEditorSidebarPending-accept" satisfies FileEditorSidebarPending_ClassNames)}
							aria-busy={isBusy}
							disabled={isBusy || disabled}
							onClick={handleAccept}
						>
							Accept
						</MyButton>
						<MyButton
							variant="ghost_destructive"
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

	// One-word neutral helper describing what accepting does, always visible. Replace wins the
	// slot: structural mv -f archives the destination; replace-moves and non-eager copies replace
	// the target's content (a replace-move also archives the source). Plain edits show Modified.
	const caption = moveReplacesExistingFile
		? "Replaced"
		: isAddedFile
			? "Added"
			: kind === "content_and_move"
				? "Moved"
				: kind === "copy"
					? "Replaced"
					: "Modified";

	// Mixed rows show the same red → green move label as pure move rows; the link still opens the
	// diff. Replace-move rows (`mv -f`) show "source → target": the source disappears (red) and
	// its content lands on the target (green).
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
							aria-busy={isBusy}
							disabled={isBusy || disabled}
							onClick={handleAccept}
						>
							Accept
						</MyButton>
						<MyButton
							variant="ghost_destructive"
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
			const failures = await files_pending_rows_run_bulk(rows, (pendingUpdate) =>
				files_pending_row_accept(convex, membershipId, pendingUpdate),
			);
			if (failures > 0) {
				toast.error(`Failed to accept ${failures} of ${rows.length} pending changes`);
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
			const failures = await files_pending_rows_run_bulk(rows, (pendingUpdate) =>
				files_pending_row_discard(convex, membershipId, pendingUpdate),
			);
			if (failures > 0) {
				toast.error(`Failed to discard ${failures} of ${rows.length} pending changes`);
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

	if (rows.length === 0) {
		return (
			<div className={cn("FileEditorSidebarPending-empty" satisfies FileEditorSidebarPending_ClassNames)}>
				No pending changes
			</div>
		);
	}

	return (
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
						moveReplacesExistingFile={row.moveReplacesExistingFile}
						isAddedFile={row.isAddedFile}
						replaceSourcePath={row.replaceSourcePath}
						disabled={isBulkBusy}
					/>
				))}
			</ul>
		</div>
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
			// Structural-only rows leave all 4 Yjs fields unset, like the server does.
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

	const makeNode = (args: { id: string; path: string; kind?: "file" | "folder" }) =>
		({
			_id: args.id,
			path: args.path,
			kind: args.kind ?? "file",
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
			const nodesById = makeNodesById([makeNode({ id: "node_a", path: "/a.md" }), makeNode({ id: "node_b", path: "/b.md" })]);

			const rows = build_pending_rows(updates, nodesById);

			expect(rows.map((row) => row.isAddedFile)).toEqual([true, false]);
		});
	});
}
