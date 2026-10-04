import "./channels-upload.css";
import { memo, useEffect, useId, useState } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { MyButton } from "@/components/my-button.tsx";
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import { MyRadioButton, MyRadioButtonLabel } from "@/components/my-radio-button.tsx";
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
import { FilesTreeProvider } from "@/lib/files-tree-context.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import {
	files_is_inline_media_content_type,
	files_normalize_upload_file_name,
	files_ROOT_ID,
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
	const [parentId, setParentId] = useState<app_convex_Id<"files_nodes"> | typeof files_ROOT_ID>(files_ROOT_ID);
	const [folderFilter, setFolderFilter] = useState("");
	const [folderPage, setFolderPage] = useState(0);
	const groupName = useId();
	const files = FilesTreeProvider.useFullList(open);
	const folders = files?.filter(
		(file) =>
			file.kind === "folder" &&
			file.archiveOperationId === null &&
			file.canWrite &&
			file.path.toLowerCase().includes(folderFilter.toLowerCase()),
	);
	const rootWrite = useQuery(
		app_convex_api.files_nodes.get_current_user_file_write_permission,
		open ? { membershipId, nodeId: files_ROOT_ID } : "skip",
	);
	const canSave =
		parentId === files_ROOT_ID
			? rootWrite === true
			: files?.some((file) => file._id === parentId && file.canWrite && file.archiveOperationId === null);

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
	const save = useFn(async () => {
		if (busy || !canSave) return;
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
								<MyInputControl
									type="search"
									aria-label="Find folder"
									placeholder="Folder name or path…"
									value={folderFilter}
									onChange={(event) => {
										setFolderFilter(event.target.value);
										setFolderPage(0);
									}}
								/>
							</MyInputArea>
							<MyInputBox />
						</MyInput>
						<div
							className={"ChannelsUpload-folders" satisfies ChannelsUpload_ClassNames}
							role="group"
							aria-label="Destination folder"
						>
							<MyRadioButton
								name={groupName}
								checked={parentId === files_ROOT_ID}
								disabled={busy || rootWrite !== true}
								onChange={() => setParentId(files_ROOT_ID)}
							>
								<MyRadioButtonLabel>Workspace root /</MyRadioButtonLabel>
							</MyRadioButton>
							{folders?.slice(folderPage * 50, (folderPage + 1) * 50).map((folder) => (
								<MyRadioButton
									key={folder._id}
									name={groupName}
									checked={parentId === folder._id}
									disabled={busy}
									onChange={() => setParentId(folder._id)}
								>
									<MyRadioButtonLabel>{folder.path}</MyRadioButtonLabel>
								</MyRadioButton>
							))}
						</div>
						{files === undefined && <p>Loading folders…</p>}
						{folderPage > 0 && (
							<MyButton disabled={busy} onClick={() => setFolderPage((page) => page - 1)}>
								Previous folders
							</MyButton>
						)}
						{folders && folders.length > (folderPage + 1) * 50 && (
							<MyButton disabled={busy} onClick={() => setFolderPage((page) => page + 1)}>
								Next folders
							</MyButton>
						)}
						{error && <p role="alert">{error}</p>}
					</MyModalScrollableArea>
					<MyModalFooter>
						<MyButton disabled={busy} onClick={() => setOpen(false)}>
							Cancel
						</MyButton>
						<MyButton disabled={busy || !canSave} onClick={() => void save()}>
							{busy ? "Saving…" : "Save file"}
						</MyButton>
					</MyModalFooter>
				</MyModalPopover>
			</MyModal>
		</div>
	);
});
