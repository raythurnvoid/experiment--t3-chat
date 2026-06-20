import "./file-editor-sidebar-pending.css";
import { ChevronRight } from "lucide-react";
import { memo, useMemo, useState, type MouseEvent } from "react";
import { createPatch } from "diff";
import { useConvex, useQuery } from "convex/react";
import { toast } from "sonner";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api, type app_convex_Doc } from "@/lib/app-convex-client.ts";
import { useStableQuery } from "@/hooks/convex-hooks.ts";
import { useFn } from "@/hooks/utils-hooks.ts";
import { MyButton } from "@/components/my-button.tsx";
import { MyLink } from "@/components/my-link.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { DiffMonospaceBlock } from "@/components/monospace-block/monospace-block-diff.tsx";
import { files_yjs_doc_create_from_array_buffer_update, files_yjs_doc_get_markdown } from "@/lib/files.ts";
import { Result } from "@/lib/errors-as-values-utils.ts";
import { cn } from "@/lib/utils.ts";
import { files_pending_changes_build_rows } from "./file-editor-sidebar-pending-rows.ts";

function decode_staged_unstaged(pendingUpdate: app_convex_Doc<"files_pending_updates">) {
	const stagedYjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdate.stagedBranchYjsUpdate);
	const stagedMarkdown = files_yjs_doc_get_markdown({ yjsDoc: stagedYjsDoc });
	if (stagedMarkdown._nay) return stagedMarkdown;

	const unstagedYjsDoc = files_yjs_doc_create_from_array_buffer_update(pendingUpdate.unstagedBranchYjsUpdate);
	const unstagedMarkdown = files_yjs_doc_get_markdown({ yjsDoc: unstagedYjsDoc });
	if (unstagedMarkdown._nay) return unstagedMarkdown;

	return Result({ _yay: { stagedMarkdown: stagedMarkdown._yay, unstagedMarkdown: unstagedMarkdown._yay } });
}

// #region item
type FileEditorSidebarPendingItem_Props = {
	pendingUpdate: app_convex_Doc<"files_pending_updates">;
	path: string;
};

const FileEditorSidebarPendingItem = memo(function FileEditorSidebarPendingItem(
	props: FileEditorSidebarPendingItem_Props,
) {
	const { pendingUpdate, path } = props;
	const { membershipId, workspaceName, projectName } = AppTenantProvider.useContext();
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

	// `preventDefault()` stops the native <summary> from toggling when the action buttons are clicked.
	const handleAcceptAndSave = useFn((event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		if (isBusy) return;
		setIsBusy(true);

		// Use an async IIFE because the React compiler has problems with try catch finally blocks
		(async (/* iife */) => {
			const decoded = decode_staged_unstaged(pendingUpdate);
			if (decoded._nay) {
				toast.error(decoded._nay.message ?? "Failed to read pending changes");
				return;
			}

			const upserted = await convex.action(app_convex_api.files_pending_updates.upsert_file_pending_update, {
				membershipId,
				nodeId: pendingUpdate.fileNodeId,
				pendingUpdateId: pendingUpdate._id,
				stagedMarkdown: decoded._yay.unstagedMarkdown,
				unstagedMarkdown: decoded._yay.unstagedMarkdown,
			});
			if (upserted._nay) {
				toast.error(upserted._nay.message ?? "Failed to accept pending changes");
				return;
			}

			const saved = await convex.action(app_convex_api.files_pending_updates.save_file_pending_update, {
				membershipId,
				nodeId: pendingUpdate.fileNodeId,
				pendingUpdateId: pendingUpdate._id,
			});
			if (saved._nay) {
				toast.error(saved._nay.message ?? "Failed to save pending changes");
			}
		})()
			.catch((error) => {
				console.error("[FileEditorSidebarPending] Failed to accept and save", {
					error,
					nodeId: pendingUpdate.fileNodeId,
				});
				toast.error(error instanceof Error ? error.message : "Failed to save pending changes");
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
			const decoded = decode_staged_unstaged(pendingUpdate);
			if (decoded._nay) {
				toast.error(decoded._nay.message ?? "Failed to read pending changes");
				return;
			}

			const upserted = await convex.action(app_convex_api.files_pending_updates.upsert_file_pending_update, {
				membershipId,
				nodeId: pendingUpdate.fileNodeId,
				pendingUpdateId: pendingUpdate._id,
				stagedMarkdown: decoded._yay.stagedMarkdown,
				unstagedMarkdown: decoded._yay.stagedMarkdown,
			});
			if (upserted._nay) {
				toast.error(upserted._nay.message ?? "Failed to discard pending changes");
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

	return (
		<li>
			<details
				className={cn("FileEditorSidebarPending-item" satisfies FileEditorSidebarPending_ClassNames)}
				open={isOpen}
				onToggle={handleToggle}
			>
				<summary className={cn("FileEditorSidebarPending-item-summary" satisfies FileEditorSidebarPending_ClassNames)}>
					<MyIcon
						aria-hidden
						className={cn("FileEditorSidebarPending-item-chevron" satisfies FileEditorSidebarPending_ClassNames)}
					>
						<ChevronRight />
					</MyIcon>
					<MyLink
						className={cn("FileEditorSidebarPending-item-path" satisfies FileEditorSidebarPending_ClassNames)}
						to="/w/$workspaceName/$projectName/files"
						params={{ workspaceName, projectName }}
						search={{ nodeId: pendingUpdate.fileNodeId, view: "diff_editor" }}
					>
						{path}
					</MyLink>
					<span className={cn("FileEditorSidebarPending-item-actions" satisfies FileEditorSidebarPending_ClassNames)}>
						<MyButton variant="ghost" aria-busy={isBusy} disabled={isBusy} onClick={handleAcceptAndSave}>
							Accept &amp; save
						</MyButton>
						<MyButton variant="ghost_destructive" aria-busy={isBusy} disabled={isBusy} onClick={handleDiscard}>
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
	| "FileEditorSidebarPending-list"
	| "FileEditorSidebarPending-item"
	| "FileEditorSidebarPending-item-summary"
	| "FileEditorSidebarPending-item-chevron"
	| "FileEditorSidebarPending-item-path"
	| "FileEditorSidebarPending-item-actions"
	| "FileEditorSidebarPending-item-diff";

export const FileEditorSidebarPending = memo(function FileEditorSidebarPending() {
	const { membershipId } = AppTenantProvider.useContext();

	const pendingUpdates = useQuery(app_convex_api.files_pending_updates.list_files_pending_updates, { membershipId });
	const fileNodesList = useStableQuery(app_convex_api.files_nodes.list_tree, { membershipId });

	const rows = useMemo(() => {
		const nodesById = new Map((fileNodesList ?? []).map((node) => [node._id, node] as const));
		return files_pending_changes_build_rows(pendingUpdates ?? [], nodesById);
	}, [pendingUpdates, fileNodesList]);

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
			<ul className={cn("FileEditorSidebarPending-list" satisfies FileEditorSidebarPending_ClassNames)}>
				{rows.map((row) => (
					<FileEditorSidebarPendingItem
						key={row.pendingUpdate._id}
						pendingUpdate={row.pendingUpdate}
						path={row.path}
					/>
				))}
			</ul>
		</div>
	);
});
// #endregion root
