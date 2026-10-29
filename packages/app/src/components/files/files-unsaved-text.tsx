import "./files-unsaved-text.css";

import { memo, useState } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { AppAuthProvider } from "@/components/app-auth.tsx";
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
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { files_download_blob } from "@/lib/files.ts";
import { files_unsaved_text_discard, useFilesUnsavedText, type files_UnsavedText } from "@/lib/files-unsaved-text.ts";

type FilesUnsavedText_ClassNames =
	| "FilesUnsavedText"
	| "FilesUnsavedText-trigger"
	| "FilesUnsavedText-item"
	| "FilesUnsavedText-actions";

const FilesUnsavedTextItem = memo(function FilesUnsavedTextItem(props: { capture: files_UnsavedText }) {
	const { capture } = props;
	const node = useQuery(
		app_convex_api.files_tree.get_file_node_for_membership,
		capture.target.kind === "saved" ? { membershipId: capture.membershipId, fileNodeId: capture.target.id } : "skip",
	);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	// Names come from current access, never from the saved capture.
	const label = node?.name ?? (capture.target.kind === "private" ? "Proposed file" : "Unavailable file");
	const download = () => {
		files_download_blob({
			blob: new Blob([capture.text], { type: "text/plain;charset=utf-8" }),
			filename: capture.rootKind === "rich_text" ? "unsaved-text.md" : "unsaved-text.txt",
		});
	};

	return (
		<section className={"FilesUnsavedText-item" satisfies FilesUnsavedText_ClassNames}>
			<h3>
				{label} — {new Date(capture.capturedAt).toLocaleString()}
			</h3>
			<p>
				{capture.reason === "read_only"
					? "This file became Read-only. This is the text kept from your editor."
					: capture.reason === "permission"
						? "You can no longer edit this file. This is the text kept from your editor."
						: capture.reason === "changed"
							? "This file changed while you were editing. This is the text kept from your editor."
							: "This editor closed with unsaved text."}
			</p>
			<textarea aria-label={`Unsaved text for ${label}`} readOnly value={capture.text} />
			<div className={"FilesUnsavedText-actions" satisfies FilesUnsavedText_ClassNames}>
				<MyButton
					variant="outline"
					onClick={() => {
						void navigator.clipboard.writeText(capture.text).then(
							() => toast.success("Text copied"),
							() => toast.error("Copy failed. Select the text or download it."),
						);
					}}
				>
					Copy text
				</MyButton>
				<MyButton variant="outline" onClick={download}>
					Download text
				</MyButton>
				<MyButton variant="ghost_destructive" onClick={() => setConfirmDiscard(true)}>
					Discard
				</MyButton>
			</div>
			{confirmDiscard ? (
				<div role="group" aria-label="Discard this unsaved text?">
					<p>Discard this text? This cannot be undone.</p>
					<MyButton variant="ghost" autoFocus onClick={() => setConfirmDiscard(false)}>
						Keep text
					</MyButton>
					<MyButton variant="destructive" onClick={() => files_unsaved_text_discard(capture.id)}>
						Discard text
					</MyButton>
				</div>
			) : null}
		</section>
	);
});

export const FilesUnsavedText = memo(function FilesUnsavedText() {
	const { userId } = AppAuthProvider.useAuth();
	const [open, setOpen] = useState(false);
	const allCaptures = useFilesUnsavedText();
	// Workspace access can end before the user has copied their local text.
	const captures = allCaptures.filter((capture) => capture.userId === userId);
	if (captures.length === 0) return null;
	return (
		<>
			<MyButton
				className={"FilesUnsavedText-trigger" satisfies FilesUnsavedText_ClassNames}
				variant="ghost"
				onClick={() => setOpen(true)}
			>
				Unsaved text ({captures.length})
			</MyButton>
			<MyModal open={open} setOpen={setOpen}>
				<MyModalPopover className={"FilesUnsavedText" satisfies FilesUnsavedText_ClassNames}>
					<MyModalHeader>
						<MyModalHeading>Unsaved text</MyModalHeading>
						<MyModalDescription>
							This text is kept only in this browser tab. Reloading or closing the tab will lose it. Copy or download it
							before leaving.
						</MyModalDescription>
					</MyModalHeader>
					<MyModalScrollableArea>
						{captures.map((capture) => (
							<FilesUnsavedTextItem key={capture.id} capture={capture} />
						))}
					</MyModalScrollableArea>
					<MyModalFooter>
						<MyButton variant="ghost" onClick={() => setOpen(false)}>
							Close
						</MyButton>
					</MyModalFooter>
					<MyModalCloseTrigger />
				</MyModalPopover>
			</MyModal>
		</>
	);
});
