import "./files-archive-modal.css";

import { memo, useState, type RefObject } from "react";

import { MyButton } from "@/components/my-button.tsx";
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
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { files_VisibleTreeNode } from "@/lib/files.ts";

type FilesArchiveModal_ClassNames =
	"FilesArchiveModal" | "FilesArchiveModal-content" | "FilesArchiveModal-list" | "FilesArchiveModal-error";

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
	/** The archive succeeded for every id. The host clears its state and reacts. */
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
