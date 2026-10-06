import "./channels-composer-attachments.css";
import { memo, useEffect, useImperativeHandle, useRef, useState, type Ref, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { toast } from "sonner";
import { Paperclip } from "lucide-react";
import { MyIconButton } from "@/components/my-icon-button.tsx";
import { MyMenu, MyMenuItem, MyMenuPopover, MyMenuTrigger } from "@/components/my-menu.tsx";
import { MyButton } from "@/components/my-button.tsx";
import { MyCheckboxButton } from "@/components/my-checkbox-button.tsx";
import { MyInput, MyInputArea, MyInputBackground, MyInputBox, MyInputControl } from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import {
	app_convex,
	app_convex_api,
	type app_convex_FunctionArgs,
	type app_convex_FunctionReturnType,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { FilesTreeProvider } from "@/lib/files-tree-context.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";

export type ChannelsComposerAttachmentTarget = app_convex_FunctionArgs<
	typeof app_convex_api.channels_uploads.create_upload_target
>["target"];

export interface ChannelsComposerAttachments_Ref {
	getAttachments: () => app_convex_FunctionArgs<typeof app_convex_api.channels_messages.send_message>["attachments"];
	hasAttachments: () => boolean;
	hasPendingUploads: () => boolean;
	resetUploads: () => void;
	addFiles: (files: readonly File[]) => void;
	clear: () => void;
}

type Attachment =
	| { kind: "file"; fileNodeId: app_convex_Id<"files_nodes"> }
	| {
			kind: "upload";
			id: string;
			file: File;
			state: "uploading" | "ready" | "failed";
			progress: number;
			error: string;
			target:
				| (NonNullable<
						app_convex_FunctionReturnType<typeof app_convex_api.channels_uploads.create_upload_target>["_yay"]
				  > & { createdAt: number })
				| null;
	  };

type ChannelsComposerAttachments_ClassNames =
	| "ChannelsComposerAttachments"
	| "ChannelsComposerAttachments-items"
	| "ChannelsComposerAttachments-item"
	| "ChannelsComposerAttachments-name"
	| "ChannelsComposerAttachments-status"
	| "ChannelsComposerAttachments-tools";
type ChannelsComposerAttachments_CustomAttributes = { "data-upload-state": "uploading" | "ready" | "failed" };

export const ChannelsComposerAttachments = memo(function ChannelsComposerAttachments(props: {
	ref: Ref<ChannelsComposerAttachments_Ref>;
	target: ChannelsComposerAttachmentTarget;
	disabled: boolean;
	onChange: () => void;
	children?: ReactNode;
}) {
	const { ref, target, disabled, onChange, children } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const [items, setItems] = useState<Attachment[]>([]);
	const itemsRef = useRef<Attachment[]>([]);
	const requests = useRef(new Map<string, XMLHttpRequest>());
	const input = useRef<HTMLInputElement>(null);
	const [picker, setPicker] = useState(false);
	const [fileFilter, setFileFilter] = useState("");
	const [filePage, setFilePage] = useState(0);
	const files = FilesTreeProvider.useFullList(picker || items.some((item) => item.kind === "file"));
	const matchingFiles = files?.filter(
		(file) =>
			file.kind === "file" &&
			file.archiveOperationId === null &&
			file.path.toLowerCase().includes(fileFilter.toLowerCase()),
	);
	const fileChoices = matchingFiles?.slice(filePage * 50, (filePage + 1) * 50);
	const attachableFiles = useQuery(
		app_convex_api.channels_messages.get_attachable_files,
		picker && fileChoices ? { membershipId, fileNodeIds: fileChoices.map((file) => file._id) } : "skip",
	);
	const change = useFn((next: Attachment[]) => {
		itemsRef.current = next;
		setItems(next);
		onChange();
	});
	const update = useFn((id: string, values: Partial<Extract<Attachment, { kind: "upload" }>>) => {
		if (!itemsRef.current.some((item) => item.kind === "upload" && item.id === id)) return;
		change(itemsRef.current.map((item) => (item.kind === "upload" && item.id === id ? { ...item, ...values } : item)));
	});
	const upload = useFn(async (id: string) => {
		const item = itemsRef.current.find((value) => value.kind === "upload" && value.id === id);
		if (!item || item.kind !== "upload") return;
		update(id, { state: "uploading", error: "", progress: 0 });
		await (async () => {
			let prepared = item.target;
			// A lost response can follow a successful PUT. Settle the same attempt before retrying it.
			if (prepared) {
				const settled = await app_convex.action(app_convex_api.channels_uploads.settle_upload, {
					membershipId,
					uploadId: prepared.uploadId,
				});
				if (!settled._nay) {
					update(id, { state: "ready", progress: 100 });
					return;
				}
				if (settled._nay.message !== "The upload is not ready yet") throw new Error(settled._nay.message);
				if (prepared.createdAt + 15 * 60 * 1000 <= Date.now()) prepared = null;
			}
			if (!prepared) {
				const created = await app_convex.mutation(app_convex_api.channels_uploads.create_upload_target, {
					membershipId,
					target,
					name: item.file.name,
					contentType: item.file.type || undefined,
					size: item.file.size,
				});
				if (created._nay) throw new Error(created._nay.message);
				prepared = { ...created._yay, createdAt: Date.now() };
				update(id, { target: prepared });
			}
			if (!itemsRef.current.some((value) => value.kind === "upload" && value.id === id)) return;
			const uploadTarget = prepared;
			await new Promise<void>((resolve, reject) => {
				const request = new XMLHttpRequest();
				requests.current.set(id, request);
				request.open("PUT", uploadTarget.url);
				for (const [name, value] of Object.entries(uploadTarget.headers)) request.setRequestHeader(name, value);
				request.upload.onprogress = (event) => {
					if (event.lengthComputable) update(id, { progress: Math.round((event.loaded / event.total) * 100) });
				};
				request.onload = () =>
					(request.status >= 200 && request.status < 300) || request.status === 412
						? resolve()
						: reject(new Error("Upload failed. Try again."));
				request.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
				request.onabort = () => reject(new Error("Upload stopped"));
				request.send(item.file);
			});
			const settled = await app_convex.action(app_convex_api.channels_uploads.settle_upload, {
				membershipId,
				uploadId: prepared.uploadId,
			});
			if (settled._nay) throw new Error(settled._nay.message);
			update(id, { state: "ready", progress: 100 });
		})()
			.catch((error: unknown) => {
				update(id, { state: "failed", error: error instanceof Error ? error.message : "Upload failed. Try again." });
			})
			.finally(() => requests.current.delete(id));
	});
	const addFiles = useFn((addedFiles: readonly File[]) => {
		if (disabled) return;
		const available = 20 - itemsRef.current.length;
		if (addedFiles.length > available) toast.error("A message can have up to 20 attachments.");
		const added: Attachment[] = addedFiles.slice(0, available).map((file) => ({
			kind: "upload",
			id: crypto.randomUUID(),
			file,
			state: "uploading",
			progress: 0,
			error: "",
			target: null,
		}));
		change([...itemsRef.current, ...added]);
		for (const item of added) if (item.kind === "upload") void upload(item.id);
	});
	const clear = useFn(() => {
		for (const request of requests.current.values()) request.abort();
		change([]);
	});
	useImperativeHandle(ref, () => ({
		getAttachments: () =>
			itemsRef.current.flatMap<
				app_convex_FunctionArgs<typeof app_convex_api.channels_messages.send_message>["attachments"][number]
			>((item) =>
				item.kind === "file"
					? [{ kind: "file", fileNodeId: item.fileNodeId }]
					: item.state === "ready" && item.target
						? [{ kind: "upload", uploadId: item.target.uploadId }]
						: [],
			),
		hasAttachments: () => itemsRef.current.length > 0,
		hasPendingUploads: () => itemsRef.current.some((item) => item.kind === "upload" && item.state !== "ready"),
		resetUploads: () =>
			change(
				itemsRef.current.map((item) =>
					item.kind === "upload"
						? { ...item, state: "failed", target: null, error: "The comment was not saved. Upload this file again." }
						: item,
				),
			),
		addFiles,
		clear,
	}));
	useEffect(
		() => () => {
			itemsRef.current = [];
			for (const request of requests.current.values()) request.abort();
		},
		[],
	);

	return (
		<div className={"ChannelsComposerAttachments" satisfies ChannelsComposerAttachments_ClassNames}>
			{items.length > 0 && (
				<div className={"ChannelsComposerAttachments-items" satisfies ChannelsComposerAttachments_ClassNames}>
					{items.map((item) => (
						<div
							key={item.kind === "file" ? item.fileNodeId : item.id}
							className={"ChannelsComposerAttachments-item" satisfies ChannelsComposerAttachments_ClassNames}
							{...(item.kind === "upload"
								? ({ "data-upload-state": item.state } satisfies ChannelsComposerAttachments_CustomAttributes)
								: {})}
						>
							<span className={"ChannelsComposerAttachments-name" satisfies ChannelsComposerAttachments_ClassNames}>
								{item.kind === "file"
									? (files?.find((file) => file._id === item.fileNodeId)?.name ?? "File unavailable")
									: item.file.name}
							</span>
							{item.kind === "upload" && (
								<span className={"ChannelsComposerAttachments-status" satisfies ChannelsComposerAttachments_ClassNames}>
									{item.state === "uploading"
										? `Uploading ${item.progress}%`
										: item.state === "ready"
											? "Ready"
											: item.error}
								</span>
							)}
							{item.kind === "upload" && item.state === "failed" && (
								<MyButton
									disabled={disabled}
									aria-label={`Retry ${item.file.name}`}
									onClick={() => void upload(item.id)}
								>
									Retry
								</MyButton>
							)}
							<MyButton
								disabled={disabled}
								aria-label={`Remove ${item.kind === "file" ? (files?.find((file) => file._id === item.fileNodeId)?.name ?? "file") : item.file.name}`}
								onClick={() => {
									if (item.kind === "upload") requests.current.get(item.id)?.abort();
									change(
										itemsRef.current.filter((value) =>
											item.kind === "file"
												? value.kind !== "file" || value.fileNodeId !== item.fileNodeId
												: value.kind !== "upload" || value.id !== item.id,
										),
									);
								}}
							>
								Remove
							</MyButton>
						</div>
					))}
				</div>
			)}
			<div className={"ChannelsComposerAttachments-tools" satisfies ChannelsComposerAttachments_ClassNames}>
				<MyMenu>
					<MyMenuTrigger>
						<MyIconButton tooltip="Attach files" disabled={disabled || items.length >= 20}>
							<Paperclip />
						</MyIconButton>
					</MyMenuTrigger>
					<MyMenuPopover aria-label="Attach files">
						<MyMenuItem onClick={() => input.current?.click()}>Upload from computer</MyMenuItem>
						<MyMenuItem onClick={() => requestAnimationFrame(() => setPicker(true))}>Attach from workspace</MyMenuItem>
					</MyMenuPopover>
				</MyMenu>
				{children}
				<input
					ref={input}
					type="file"
					multiple
					hidden
					aria-label="Choose files to upload"
					disabled={disabled}
					onChange={(event) => {
						addFiles(Array.from(event.currentTarget.files ?? []));
						event.currentTarget.value = "";
					}}
				/>
			</div>
			<MyModal open={picker} setOpen={setPicker}>
				<MyModalPopover aria-label="Attach a file">
					<MyModalHeader>
						<MyModalHeading>Attach a file</MyModalHeading>
						<MyModalCloseTrigger />
					</MyModalHeader>
					<MyModalScrollableArea>
						<MyInput>
							<MyInputBackground />
							<MyInputArea>
								<MyInputControl
									type="search"
									aria-label="Find file"
									value={fileFilter}
									placeholder="File name or path…"
									onChange={(event) => {
										setFileFilter(event.target.value);
										setFilePage(0);
									}}
								/>
							</MyInputArea>
							<MyInputBox />
						</MyInput>
						{fileChoices === undefined || attachableFiles === undefined ? (
							<p>Loading files…</p>
						) : (
							fileChoices
								.filter((file) => attachableFiles.includes(file._id))
								.map((file) => {
									const checked = items.some((item) => item.kind === "file" && item.fileNodeId === file._id);
									return (
										<MyCheckboxButton
											key={file._id}
											variant="outline"
											checked={checked}
											disabled={disabled || (!checked && items.length >= 20)}
											onCheckedChange={(selected) =>
												change(
													selected
														? [...itemsRef.current, { kind: "file", fileNodeId: file._id }]
														: itemsRef.current.filter((item) => item.kind !== "file" || item.fileNodeId !== file._id),
												)
											}
										>
											{file.path}
										</MyCheckboxButton>
									);
								})
						)}
						{fileChoices?.length === 0 && <p>No files found</p>}
						{filePage > 0 && <MyButton onClick={() => setFilePage((page) => page - 1)}>Previous files</MyButton>}
						{matchingFiles && matchingFiles.length > (filePage + 1) * 50 && (
							<MyButton onClick={() => setFilePage((page) => page + 1)}>Next files</MyButton>
						)}
					</MyModalScrollableArea>
					<MyModalFooter>
						<MyButton onClick={() => setPicker(false)}>Done</MyButton>
					</MyModalFooter>
				</MyModalPopover>
			</MyModal>
		</div>
	);
});
