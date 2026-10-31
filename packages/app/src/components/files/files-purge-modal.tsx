import "./files-purge-modal.css";

import { memo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

import { TextMonospaceBlock } from "@/components/monospace-block/monospace-block-text.tsx";
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
import type { FilesArchiveModal_Node } from "@/components/files/files-archive-modal.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { AppActivitiesProvider } from "@/lib/app-activities-context.tsx";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";

type FilesPurgeModal_ClassNames =
	| "FilesPurgeModal"
	| "FilesPurgeModal-content"
	| "FilesPurgeModal-list-toggle"
	| "FilesPurgeModal-error";

/**
 * What to delete forever: archived items the person picked, or every item archived in one area of
 * the Archived view before now (Empty archive).
 */
export type FilesPurgeModal_Request =
	| { kind: "items"; nodes: FilesArchiveModal_Node[] }
	| {
			kind: "empty_archive";
			/**
			 * The open part of the workspace (null) or one restricted folder.
			 */
			area: app_convex_Id<"files_nodes"> | null;
			areaLabel: string;
	  };

export type FilesPurgeModal_Props = {
	/** `null` keeps the dialog closed. */
	request: FilesPurgeModal_Request | null;
	/** Focused again when the dialog closes without deleting. */
	returnFocusRef: RefObject<HTMLElement | null>;
	/** The user closed it: Cancel, Escape, the backdrop or the close button. Nothing was deleted. */
	onClose: () => void;
	/**
	 * The server took the request. It either deleted everything already, or goes on as a background job
	 * with a toast. The host clears its state.
	 */
	onDeleted: () => void;
};

/**
 * The confirmation for Delete permanently and Empty archive. It owns the request and shows a refusal
 * inline. A small delete ends inside the request. A bigger one goes on as a background job, and a
 * toast follows it.
 */
export const FilesPurgeModal = memo(function FilesPurgeModal(props: FilesPurgeModal_Props) {
	const { request, returnFocusRef, onClose, onDeleted } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const { watchArchiveRun } = AppActivitiesProvider.useContext();

	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);
	// Tie Show more to the request it was clicked for, so the next dialog opens small again.
	const [expandedRequest, setExpandedRequest] = useState<FilesPurgeModal_Request | null>(null);
	const isListExpanded = request !== null && expandedRequest === request;

	const nodes = request?.kind === "items" ? request.nodes : [];
	// One item is named in the heading, so it gets no list.
	const hasList = nodes.length > 1;
	const heading =
		request?.kind === "empty_archive"
			? "Empty archive?"
			: hasList
				? `Delete ${nodes.length} items permanently?`
				: `Delete “${nodes[0]?.name ?? ""}” permanently?`;
	const description =
		request?.kind === "empty_archive"
			? `Every item archived in ${request.areaLabel} before now will be deleted forever, with everything inside it. You can't undo this.`
			: nodes.some((node) => node.kind === "folder")
				? "Deleted items are gone forever, with everything inside them. You can't undo this."
				: "Deleted items are gone forever. You can't undo this.";

	const handleClose = useFn(() => {
		// Clear the refusal here and in `handleConfirm`, so a second open does not start with old text.
		setError(null);
		onClose();
		queueMicrotask(() => returnFocusRef.current?.focus());
	});

	const handleOpenChange = useFn((open: boolean) => {
		// Escape and the backdrop cannot close the dialog while the request is being sent.
		if (!open && !pending) {
			handleClose();
		}
	});

	const handleConfirm = useFn(() => {
		if (!request) return;
		setPending(true);
		setError(null);

		const isEmptyArchive = request.kind === "empty_archive";
		const verbs = isEmptyArchive
			? (["empty", "Emptying", "Emptied"] as const)
			: (["delete", "Deleting", "Deleted"] as const);
		const subject = isEmptyArchive
			? "the archive"
			: request.nodes.length === 1
				? `“${request.nodes[0]!.name}”`
				: `${request.nodes.length} items`;
		(isEmptyArchive
			? app_convex.mutation(app_convex_api.files_nodes.empty_archive, { membershipId, area: request.area })
			: app_convex.mutation(app_convex_api.files_nodes.purge_nodes, {
					membershipId,
					nodeIds: request.nodes.map((node) => node._id),
				})
		)
			.then((result) => {
				if (result._nay) {
					console.error("[FilesPurgeModal.handleConfirm] Failed to delete permanently", { result, request });
					setError(
						result._nay.message === "Permission denied"
							? "You need Can manage access to delete these items permanently."
							: result._nay.message,
					);
					return;
				}

				const { runId, itemCount, deletedCount } = result._yay;
				// A job keeps going in the background. Its toast says how it ends.
				if (runId !== null) {
					watchArchiveRun({ runId, verbs, subject });
				} else if (itemCount === 0) {
					toast.info("Nothing archived here to delete.");
				} else {
					toast.success(
						`${verbs[2]} ${isEmptyArchive ? `${deletedCount} ${deletedCount === 1 ? "item" : "items"}` : subject}.`,
					);
				}
				setError(null);
				onDeleted();
			})
			.catch((error: unknown) => {
				console.error("[FilesPurgeModal.handleConfirm] Unexpected async error", { error, request });
				setError("Failed to delete. Try again.");
			})
			.finally(() => setPending(false));
	});

	return (
		<MyModal open={request !== null} setOpen={handleOpenChange}>
			{/* Start on Cancel, the safe choice. */}
			<MyModalPopover
				className={"FilesPurgeModal" satisfies FilesPurgeModal_ClassNames}
				initialFocus={cancelRef}
				unmountOnHide
			>
				<MyModalHeader>
					<MyModalHeading>{heading}</MyModalHeading>
					<MyModalDescription>{description}</MyModalDescription>
				</MyModalHeader>
				{/* Leave out the empty body when there is no list and no refusal to show. */}
				{hasList || error ? (
					<MyModalScrollableArea>
						<div className={"FilesPurgeModal-content" satisfies FilesPurgeModal_ClassNames}>
							{/* One path per line in a read-only text block, so Ctrl+A selects only the paths. */}
							{hasList ? (
								<TextMonospaceBlock
									aria-label="Items to delete"
									text={nodes.map((node) => node.path).join("\n")}
									maxHeight={isListExpanded ? "16lh" : "6lh"}
								/>
							) : null}
							{nodes.length > 6 ? (
								<MyButton
									className={"FilesPurgeModal-list-toggle" satisfies FilesPurgeModal_ClassNames}
									variant="ghost"
									aria-expanded={isListExpanded}
									onClick={() => setExpandedRequest(isListExpanded ? null : request)}
								>
									{isListExpanded ? "Show less" : "Show more"}
								</MyButton>
							) : null}
							{error ? (
								<p role="alert" className={"FilesPurgeModal-error" satisfies FilesPurgeModal_ClassNames}>
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
						{pending ? "Deleting…" : request?.kind === "empty_archive" ? "Empty archive" : "Delete permanently"}
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger disabled={pending} />
			</MyModalPopover>
		</MyModal>
	);
});
