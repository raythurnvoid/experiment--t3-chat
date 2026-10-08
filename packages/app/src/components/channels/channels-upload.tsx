import "./channels-upload.css";
import { memo, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MyButton } from "@/components/my-button.tsx";
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import { FilesNodePicker, type FilesNodePicker_Ref } from "@/components/files/files-node-picker.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	files_is_inline_media_content_type,
	files_normalize_upload_file_name,
	type files_ROOT_ID,
} from "../../../shared/files.ts";
import type { ChannelsMessage } from "./channels-message-window.ts";

type ChannelsUpload_ClassNames =
	| "ChannelsUpload"
	| "ChannelsUpload-name"
	| "ChannelsUpload-preview"
	| "ChannelsUpload-tools"
	| "ChannelsUpload-status"
	| "ChannelsUpload-folders";
type ChannelsUpload_CustomAttributes = { "data-upload-id": string };

export const ChannelsUpload = memo(function ChannelsUpload(props: {
	upload: Extract<ChannelsMessage["attachments"][number], { kind: "upload" }>;
}) {
	const { upload } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const preview = upload.size <= 20 * 1024 * 1024 && files_is_inline_media_content_type(upload.contentType);
	const [src, setSrc] = useState<string | null>(null);
	const [previewError, setPreviewError] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [open, setOpen] = useState(false);
	const [folderFilter, setFolderFilter] = useState("");
	const [folderInput, setFolderInput] = useState<HTMLInputElement | null>(null);
	const pickerRef = useRef<FilesNodePicker_Ref>(null);

	useEffect(() => {
		let cancelled = false;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		setSrc(null);
		setPreviewError(false);
		if (!preview) return;
		const refresh = async () => {
			try {
				const signed = await app_convex.action(app_convex_api.channels_uploads.get_upload_url, {
					membershipId,
					uploadId: upload.uploadId,
				});
				if (cancelled) return;
				if (signed._nay) {
					setSrc(null);
					setPreviewError(true);
					return;
				}
				setSrc(signed._yay.url);
				setPreviewError(false);
				refreshTimer = setTimeout(() => void refresh(), Math.max(1000, signed._yay.expiresAt - Date.now() - 60 * 1000));
			} catch {
				if (cancelled) return;
				setSrc(null);
				setPreviewError(true);
			}
		};
		void refresh();
		return () => {
			cancelled = true;
			clearTimeout(refreshTimer);
		};
	}, [membershipId, upload.uploadId, preview]);

	const download = useFn(async () => {
		setBusy(true);
		setError("");
		await (async () => {
			const signed = await app_convex.action(app_convex_api.channels_uploads.get_upload_url, {
				membershipId,
				uploadId: upload.uploadId,
				download: true,
			});
			if (signed._nay) throw new Error(signed._nay.message);
			const anchor = document.createElement("a");
			anchor.href = signed._yay.url;
			anchor.download = upload.name;
			document.body.append(anchor);
			anchor.click();
			anchor.remove();
		})()
			.catch((caught: unknown) => {
				setError(caught instanceof Error ? caught.message : "Could not download this file");
			})
			.finally(() => setBusy(false));
	});
	const save = useFn(async (parentId: app_convex_Id<"files_nodes"> | typeof files_ROOT_ID) => {
		if (busy) return;
		setBusy(true);
		setError("");
		await (async () => {
			const signed = await app_convex.action(app_convex_api.channels_uploads.get_upload_url, {
				membershipId,
				uploadId: upload.uploadId,
				download: true,
			});
			if (signed._nay) throw new Error(signed._nay.message);
			const response = await fetch(signed._yay.url);
			if (!response.ok) throw new Error("Could not read this upload");
			const blob = await response.blob();
			const created = await app_convex.mutation(app_convex_api.files_nodes.create_upload_node, {
				membershipId,
				parentId,
				filename: files_normalize_upload_file_name(upload.name),
				contentType: upload.contentType,
				size: blob.size,
				onConflict: "fail",
			});
			if (created._nay) throw new Error(created._nay.message);
			const uploaded = await fetch(created._yay.url, { method: "PUT", headers: created._yay.headers, body: blob });
			if (!uploaded.ok && uploaded.status !== 412) throw new Error("Could not save this file. Try again.");
			setOpen(false);
			toast.success("File uploaded. Processing…");
		})()
			.catch((caught: unknown) => {
				setError(caught instanceof Error ? caught.message : "Could not save this file");
			})
			.finally(() => setBusy(false));
	});

	return (
		<div
			className={"ChannelsUpload" satisfies ChannelsUpload_ClassNames}
			{...({ "data-upload-id": upload.uploadId } satisfies ChannelsUpload_CustomAttributes)}
		>
			<strong className={"ChannelsUpload-name" satisfies ChannelsUpload_ClassNames}>{upload.name}</strong>
			{preview &&
				src &&
				!previewError &&
				(upload.contentType.startsWith("video/") ? (
					<video
						className={"ChannelsUpload-preview" satisfies ChannelsUpload_ClassNames}
						src={src}
						controls
						preload="metadata"
						aria-label={upload.name}
						onError={() => setPreviewError(true)}
					/>
				) : (
					<img
						className={"ChannelsUpload-preview" satisfies ChannelsUpload_ClassNames}
						src={src}
						alt={upload.name}
						loading="lazy"
						onError={() => setPreviewError(true)}
					/>
				))}
			{preview && !src && !previewError && (
				<span className={"ChannelsUpload-status" satisfies ChannelsUpload_ClassNames}>Loading preview…</span>
			)}
			{previewError && (
				<span className={"ChannelsUpload-status" satisfies ChannelsUpload_ClassNames}>Preview unavailable</span>
			)}
			<div className={"ChannelsUpload-tools" satisfies ChannelsUpload_ClassNames}>
				<MyButton disabled={busy} onClick={() => void download()}>
					Download
				</MyButton>
				<MyButton
					disabled={busy}
					onClick={() => {
						setError("");
						setOpen(true);
					}}
				>
					Save to Files
				</MyButton>
			</div>
			{error && !open && <p role="alert">{error}</p>}
			<MyModal
				open={open}
				setOpen={(next) => {
					if (!busy) setOpen(next);
				}}
			>
				<MyModalPopover aria-label="Save to Files">
					<MyModalHeader>
						<MyModalHeading>Save to Files</MyModalHeading>
						<MyModalCloseTrigger disabled={busy} />
					</MyModalHeader>
					<MyModalScrollableArea>
						<p>{upload.name}</p>
						<MyInput>
							<MyInputBackground />
							<MyInputArea>
								{/* A combobox: focus stays here, and the picker sets aria-controls and aria-activedescendant. */}
								<MyInputControl
									ref={setFolderInput}
									type="search"
									role="combobox"
									aria-label="Find folder"
									aria-autocomplete="list"
									aria-expanded={open}
									placeholder="Folder name or path…"
									value={folderFilter}
									onChange={(event) => setFolderFilter(event.target.value)}
									onKeyDown={(event) => {
										if (pickerRef.current?.onKeyDown(event.nativeEvent)) event.preventDefault();
									}}
								/>
							</MyInputArea>
							<MyInputBox />
						</MyInput>
						{/* The closed dialog stays mounted, so mount the picker only while it is open. */}
						{open && folderInput && (
							<div className={"ChannelsUpload-folders" satisfies ChannelsUpload_ClassNames}>
								<FilesNodePicker
									ref={pickerRef}
									variant="listbox"
									aria-label="Folders"
									ownerElement={folderInput}
									query={folderFilter}
									select="folder"
									folderRow={{ label: "Save here", onPick: (folder) => void save(folder.nodeId) }}
									clearQuery={() => setFolderFilter("")}
								/>
							</div>
						)}
						{/* Keep the live region mounted, so a new text in it is read out. */}
						<p role="status">{busy ? "Saving…" : ""}</p>
						{error && <p role="alert">{error}</p>}
					</MyModalScrollableArea>
					<MyModalFooter>
						<MyButton disabled={busy} onClick={() => setOpen(false)}>
							Cancel
						</MyButton>
					</MyModalFooter>
				</MyModalPopover>
			</MyModal>
		</div>
	);
});
