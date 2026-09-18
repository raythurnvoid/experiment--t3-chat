import "./file-node-view-folder-create-node-modal.css";

import { memo, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { MyButton } from "@/components/my-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputHelperText,
	MyInputLabel,
} from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
} from "@/components/my-modal.tsx";
import { useFn, useRenderPromise } from "@/hooks/utils-hooks.ts";
import { type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { cn } from "@/lib/utils.ts";
import {
	files_clear_node_path_cached_validation_messages,
	files_find_file_stem_end_index,
	files_get_default_node_name,
	files_get_node_path_validation,
	files_get_normalized_node_path_segments,
	type files_VisibleTreeNode,
} from "@/lib/files.ts";

type FileNodeViewFolderCreateNodeModal_ClassNames =
	| "FileNodeViewFolderCreateNodeModal"
	| "FileNodeViewFolderCreateNodeModal-form"
	| "FileNodeViewFolderCreateNodeModal-field"
	| "FileNodeViewFolderCreateNodeModal-validation";

export type FileNodeViewFolderCreateNodeModal_Ref = {
	open: (kind: app_convex_Doc<"files_nodes">["kind"]) => void;
};

type FileNodeViewFolderCreateNodeModal_Props = {
	ref: React.Ref<FileNodeViewFolderCreateNodeModal_Ref>;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	folderItemId: app_convex_Doc<"files_nodes">["parentId"];
	fileNodesList: files_VisibleTreeNode[] | undefined;
	siblingNames: Iterable<string>;
	canWrite: boolean;
	unavailableMessage: string | null;
	isCreatingNode: boolean;
	onCreateNode: (args: { kind: app_convex_Doc<"files_nodes">["kind"]; path: string }) => Promise<string | null>;
};

const FileNodeViewFolderCreateNodeModal = memo(function FileNodeViewFolderCreateNodeModal(
	props: FileNodeViewFolderCreateNodeModal_Props,
) {
	const {
		ref,
		membershipId,
		folderItemId,
		fileNodesList,
		siblingNames,
		canWrite,
		unavailableMessage,
		isCreatingNode,
		onCreateNode,
	} = props;

	const [kind, setKind] = useState<app_convex_Doc<"files_nodes">["kind"] | null>(null);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
	const submitButtonRef = useRef<HTMLButtonElement | null>(null);
	const wasWritableRef = useRef(canWrite);
	const helperId = `FileNodeViewFolderCreateNodeModal-${useId()}-helper`;
	const renderPromise = useRenderPromise();

	const kindLabel = kind === "folder" ? "folder" : "file";
	const nodePathValidation = files_get_node_path_validation({
		scopeId: membershipId,
		parentId: folderItemId,
		fileNodesList,
		kind,
		nameOrPath: name,
	});
	const displayedValidationMessage = error ?? nodePathValidation.validationMessage;
	const displayedHelperMessage = unavailableMessage ?? displayedValidationMessage;
	const isSubmitBlocked = Boolean(nodePathValidation.validationMessage);

	const closeModal = useFn(() => {
		files_clear_node_path_cached_validation_messages();
		setKind(null);
		setName("");
		setError(null);
	});

	const handleNameChange = useFn<React.ComponentProps<typeof MyInputControl>["onChange"]>((event) => {
		setName(event.currentTarget.value);
		setError(null);
	});

	const handleOpenChange = useFn((open: boolean) => {
		if (open || isCreatingNode) {
			return;
		}

		closeModal();
	});

	const handleSubmit = useFn<React.ComponentProps<"form">["onSubmit"]>((event) => {
		event.preventDefault();
		if (!kind || !canWrite) {
			return;
		}

		const trimmedName = name.trim();
		if (!trimmedName) {
			setError(`Enter a ${kind} name.`);
			return;
		}
		if (nodePathValidation.validationMessage) {
			nodePathValidation.cacheValidationMessage(nodePathValidation.validationMessage);
			setError(nodePathValidation.validationMessage);
			return;
		}
		const normalizedPath = files_get_normalized_node_path_segments({ kind, nameOrPath: trimmedName });
		if (!normalizedPath || "validationMessage" in normalizedPath) {
			setError(normalizedPath?.validationMessage ?? `Enter a ${kind} name.`);
			return;
		}

		setError(null);
		onCreateNode({ kind, path: normalizedPath.normalizedPathSegments.join("/") })
			.then((serverErrorMessage) => {
				if (!serverErrorMessage) {
					closeModal();
					return;
				}

				nodePathValidation.cacheValidationMessage(serverErrorMessage);
				setError(serverErrorMessage);
			})
			.catch((caughtError) => {
				setError(`Failed to create ${kind}.`);
				console.error("[FileNodeViewFolderCreateNodeModal.handleSubmit] Error creating node", {
					error: caughtError,
					folderItemId,
					kind,
				});
			});
	});

	useImperativeHandle(
		ref,
		() => ({
			open: (kind) => {
				const defaultName = files_get_default_node_name({
					kind: kind,
					siblingNames,
				});
				const selectionEnd =
					kind === "file" ? files_find_file_stem_end_index({ fileName: defaultName }) : defaultName.length;
				setKind(kind);
				setName(defaultName);
				setError(null);
				renderPromise
					.wait()
					.then((result) => {
						if (result._nay) {
							return;
						}

						const input = inputRef.current;
						if (!input) {
							return;
						}

						input.focus();
						input.setSelectionRange(0, selectionEnd);
					})
					.catch((error) => {
						console.error("[FileNodeViewFolderCreateNodeModal.open] Error selecting default node name", { error });
					});
			},
		}),
		[ref, renderPromise, siblingNames],
	);

	// Keep client-side path conflicts in the shared cache so repeated values fail immediately.
	useEffect(() => {
		if (!nodePathValidation.validationMessage) {
			return;
		}

		nodePathValidation.cacheValidationMessage(nodePathValidation.validationMessage);
	}, [nodePathValidation.validationCacheKey, nodePathValidation.validationMessage]);

	// Keep native validity and the explicit visible-invalid class in sync with the app helper.
	useLayoutEffect(() => {
		const input = inputRef.current;
		if (!input) {
			return;
		}

		input.setCustomValidity(kind ? (displayedValidationMessage ?? "") : "");
		return () => {
			input.setCustomValidity("");
		};
	}, [displayedValidationMessage, inputRef, kind]);

	useLayoutEffect(() => {
		const becameUnavailable = wasWritableRef.current && !canWrite;
		wasWritableRef.current = canWrite;
		if (!kind || !becameUnavailable || isCreatingNode) {
			return;
		}

		// If the focused field becomes disabled, move focus to the enabled Cancel button.
		if (document.activeElement === inputRef.current || document.activeElement === submitButtonRef.current) {
			cancelButtonRef.current?.focus();
		}
	}, [canWrite, isCreatingNode, kind]);

	return (
		<MyModal open={kind !== null} setOpen={handleOpenChange}>
			<MyModalPopover
				className={"FileNodeViewFolderCreateNodeModal" satisfies FileNodeViewFolderCreateNodeModal_ClassNames}
			>
				<form
					className={"FileNodeViewFolderCreateNodeModal-form" satisfies FileNodeViewFolderCreateNodeModal_ClassNames}
					onSubmit={handleSubmit}
				>
					<MyModalHeader>
						<MyModalHeading>New {kindLabel}</MyModalHeading>
					</MyModalHeader>
					<div
						className={"FileNodeViewFolderCreateNodeModal-field" satisfies FileNodeViewFolderCreateNodeModal_ClassNames}
					>
						<MyInput layout="stacked" className={cn(displayedValidationMessage && "userInvalid")}>
							<MyInputLabel>Name</MyInputLabel>
							<MyInputBackground />
							<MyInputArea>
								<MyInputControl
									ref={inputRef}
									autoFocus
									required
									value={name}
									disabled={!canWrite || isCreatingNode}
									aria-describedby={displayedHelperMessage ? helperId : undefined}
									onChange={handleNameChange}
								/>
							</MyInputArea>
							<MyInputBox />
							<MyInputHelperText
								className={
									"FileNodeViewFolderCreateNodeModal-validation" satisfies FileNodeViewFolderCreateNodeModal_ClassNames
								}
								aria-live="polite"
							>
								<span id={helperId}>{displayedHelperMessage}</span>
							</MyInputHelperText>
						</MyInput>
					</div>
					<MyModalFooter>
						{/* Do not wrap Cancel in MyModalCloseTrigger — that class is absolute top-right for the X. */}
						<MyButton
							ref={cancelButtonRef}
							type="button"
							variant="ghost"
							disabled={isCreatingNode}
							onClick={closeModal}
						>
							Cancel
						</MyButton>
						<MyButton
							ref={submitButtonRef}
							type="submit"
							disabled={!canWrite || !name.trim() || isSubmitBlocked || isCreatingNode}
							aria-busy={isCreatingNode}
						>
							{isCreatingNode ? `Creating ${kindLabel}...` : `Create ${kindLabel}`}
						</MyButton>
					</MyModalFooter>
				</form>
				<MyModalCloseTrigger disabled={isCreatingNode} />
			</MyModalPopover>
		</MyModal>
	);
});

export { FileNodeViewFolderCreateNodeModal };
