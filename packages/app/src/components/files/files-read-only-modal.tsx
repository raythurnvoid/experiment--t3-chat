import "./files-read-only-modal.css";

import { useQuery } from "convex/react";
import { LockKeyhole } from "lucide-react";
import { memo, useRef, useState, type RefObject } from "react";

import { MyButton } from "@/components/my-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
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

type FilesReadOnlyModal_ClassNames =
	| "FilesReadOnlyModal"
	| "FilesReadOnlyModal-body"
	| "FilesReadOnlyModal-status"
	| "FilesReadOnlyModal-status-icon"
	| "FilesReadOnlyModal-status-copy"
	| "FilesReadOnlyModal-error"
	| "FilesReadOnlyModal-footer-spacer";

export type FilesReadOnlyModal_Props = {
	nodeId: app_convex_Id<"files_nodes"> | null;
	nodeName: string;
	nodeKind: "file" | "folder";
	hasVisibleReadOnlyDescendant: boolean;
	returnFocusRef?: RefObject<HTMLElement | null>;
	onNavigateNode?: (nodeId: app_convex_Id<"files_nodes">) => void;
	onClose: () => void;
};

export const FilesReadOnlyModal = memo(function FilesReadOnlyModal(props: FilesReadOnlyModal_Props) {
	const { nodeId, nodeName, nodeKind, hasVisibleReadOnlyDescendant, returnFocusRef, onNavigateNode, onClose } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const dialogRef = useRef<HTMLDivElement>(null);
	const [isRunning, setIsRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const managementState = useQuery(
		app_convex_api.files_nodes.get_node_read_only_management_state,
		nodeId ? { membershipId, nodeId } : "skip",
	);

	const isLoading = nodeId !== null && managementState === undefined;
	// The server hides the source path when the user cannot read that folder.
	const sourceLabel = managementState?.source?.path ?? "a protected folder";
	const isDirectUnderOuterLock = managementState?.readOnlyState === "self" && managementState.hasInheritedParentLock;
	// A direct lock keeps an inherited node locked after the outer lock is removed.
	const action =
		managementState?.readOnlyState === "writable" || managementState?.readOnlyState === "inherited" ? "lock" : "unlock";
	const actionLabel =
		managementState?.readOnlyState === "writable"
			? "Make read-only"
			: managementState?.readOnlyState === "self"
				? isDirectUnderOuterLock
					? "Remove direct lock"
					: "Make writable"
				: "Add direct lock";

	const handleClose = useFn(() => {
		if (isRunning) {
			return;
		}

		setError(null);
		onClose();
		queueMicrotask(() => returnFocusRef?.current?.focus());
	});

	const handleWrite = useFn(() => {
		if (!nodeId || isRunning) {
			return;
		}

		setError(null);
		setIsRunning(true);

		const mutation =
			action === "lock"
				? app_convex_api.files_nodes.set_node_read_only
				: app_convex_api.files_nodes.set_node_writable;
		void Promise.try(() => app_convex.mutation(mutation, { membershipId, nodeId }))
			.then((result) => {
				setIsRunning(false);

				if (result._nay) {
					setError(result._nay.message);
					dialogRef.current?.focus();
					return;
				}

				onClose();
				queueMicrotask(() => returnFocusRef?.current?.focus());
			})
			.catch((caughtError) => {
				console.error("[FilesReadOnlyModal.handleWrite] Failed to change read-only state", caughtError);
				setError("Failed to change read-only state");
				setIsRunning(false);
				dialogRef.current?.focus();
			});
	});

	const handleManageSource = useFn(() => {
		if (!managementState?.source || !onNavigateNode) {
			return;
		}

		onNavigateNode(managementState.source.nodeId);
		handleClose();
	});

	const handleOpenChange = useFn((open: boolean) => {
		if (!open) {
			handleClose();
		}
	});

	return (
		<MyModal open={nodeId !== null} setOpen={handleOpenChange}>
			<MyModalPopover
				ref={dialogRef}
				className={"FilesReadOnlyModal" satisfies FilesReadOnlyModal_ClassNames}
				hideOnEscape={!isRunning}
				data-files-read-only-modal=""
			>
				<MyModalHeader>
					<MyModalHeading>Read-only settings for {nodeName}</MyModalHeading>
					<MyModalDescription>Control whether this {nodeKind} may be changed.</MyModalDescription>
				</MyModalHeader>

				<MyModalScrollableArea>
					<div className={"FilesReadOnlyModal-body" satisfies FilesReadOnlyModal_ClassNames}>
						<div className={"FilesReadOnlyModal-status" satisfies FilesReadOnlyModal_ClassNames}>
							<MyIcon className={"FilesReadOnlyModal-status-icon" satisfies FilesReadOnlyModal_ClassNames}>
								<LockKeyhole aria-hidden />
							</MyIcon>
							<div className={"FilesReadOnlyModal-status-copy" satisfies FilesReadOnlyModal_ClassNames}>
								{isLoading ? (
									<p>Loading read-only settings…</p>
								) : managementState?.readOnlyState === "writable" ? (
									<p>This {nodeKind} is writable.</p>
								) : managementState?.readOnlyState === "self" ? (
									isDirectUnderOuterLock ? (
										<p>
											This {nodeKind} has a direct lock and will remain read-only from {sourceLabel} after it is
											removed.
										</p>
									) : (
										<p>This {nodeKind} has a direct read-only lock.</p>
									)
								) : (
									<p>
										This {nodeKind} is read-only from {sourceLabel}.
									</p>
								)}
								{managementState?.readOnlyState === "inherited" && managementState.canManage ? (
									<p>
										A direct lock changes nothing now, but keeps this {nodeKind} read-only if the outer lock is removed.
									</p>
								) : null}
								{nodeKind === "folder" && managementState?.readOnlyState === "writable" ? (
									<p>Making this folder read-only also protects everything inside it.</p>
								) : null}
								{hasVisibleReadOnlyDescendant ? (
									<p>This folder contains read-only items, so it cannot be renamed, moved, or archived.</p>
								) : null}
							</div>
						</div>
						{error ? (
							<p className={"FilesReadOnlyModal-error" satisfies FilesReadOnlyModal_ClassNames} role="alert">
								{error}
							</p>
						) : null}
					</div>
				</MyModalScrollableArea>

				<MyModalFooter>
					{managementState?.readOnlyState === "inherited" && managementState.source && onNavigateNode ? (
						<MyButton variant="outline" disabled={isRunning} onClick={handleManageSource}>
							Manage {managementState.source.path}
						</MyButton>
					) : null}
					<div className={"FilesReadOnlyModal-footer-spacer" satisfies FilesReadOnlyModal_ClassNames} />
					<MyButton variant="ghost" disabled={isRunning} onClick={handleClose}>
						Cancel
					</MyButton>
					{managementState?.canManage ? (
						<MyButton
							variant={action === "unlock" ? "outline" : "default"}
							disabled={isRunning}
							aria-busy={isRunning || undefined}
							onClick={handleWrite}
						>
							{isRunning ? "Saving…" : actionLabel}
						</MyButton>
					) : null}
				</MyModalFooter>
				<MyModalCloseTrigger disabled={isRunning} />
			</MyModalPopover>
		</MyModal>
	);
});
