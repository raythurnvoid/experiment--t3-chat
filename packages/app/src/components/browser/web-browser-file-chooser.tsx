import "./web-browser-file-chooser.css";

import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
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
import {
	MySearchSelect,
	MySearchSelectItem,
	MySearchSelectList,
	MySearchSelectPopover,
	MySearchSelectPopoverContent,
	MySearchSelectPopoverScrollableArea,
	MySearchSelectSearch,
	MySearchSelectTrigger,
	type MySearchSelect_Props,
} from "@/components/my-search-select.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import type { files_browser_StreamWebMessage } from "@/lib/files-browser-stream.ts";
import { FilesTreeProvider } from "@/lib/files-tree-context.tsx";
import { useConvex } from "convex/react";
import { FolderOpen, Upload } from "lucide-react";
import { memo, useRef, useState, type ChangeEvent } from "react";

// The Convex door and the runner take at most 10 files in one fill.
const WEB_BROWSER_FILE_CHOOSER_MAX_FILES = 10;

// The runner takes at most 20 MiB in one fill. Check a computer file before it is sent.
const WEB_BROWSER_FILE_CHOOSER_MAX_BYTES = 20 * 1024 * 1024;

const WEB_BROWSER_FILE_CHOOSER_ERRORS: Record<string, string> = {
	chooser_gone: "The page no longer asks for a file.",
	not_human:
		"You no longer have control, so the page stopped waiting for this file. Take control and open the file dialog again.",
	too_large: "The page takes at most 20 MB at once.",
	too_many_files: "This page takes one file.",
	fetch_failed: "A file could not be read. Try again.",
	grant_invalid: "The upload expired. Try again.",
	// The runner could not read the computer file, for example a slow or broken upload.
	upload_failed: "The file could not be sent to the page. Try again.",
	disabled: "The web browser is not available right now.",
};

/**
 * Plain text for a refused fill. The runner codes come in `_nay.name` from Convex and in `code`
 * from the upload reply. Other refusals keep their own message.
 */
function web_browser_file_chooser_error(code: string | undefined, fallback: string) {
	if (code !== undefined && Object.hasOwn(WEB_BROWSER_FILE_CHOOSER_ERRORS, code)) {
		return WEB_BROWSER_FILE_CHOOSER_ERRORS[code];
	}
	// The Files signer answers "Not found" for a file the user cannot read, or that is gone.
	return fallback === "Not found" ? "A chosen file is not available." : fallback;
}

/**
 * The host name of the frame that asked. An opaque origin ("null") has no host.
 */
function web_browser_file_chooser_host(origin: string) {
	return (URL.canParse(origin) && new URL(origin).host) || "This page";
}

type WebBrowserFileChooser_ClassNames =
	| "WebBrowserFileChooser"
	| "WebBrowserFileChooser-content"
	| "WebBrowserFileChooser-text"
	| "WebBrowserFileChooser-actions"
	| "WebBrowserFileChooser-list"
	| "WebBrowserFileChooser-row"
	| "WebBrowserFileChooser-picker"
	| "WebBrowserFileChooser-picker-empty"
	| "WebBrowserFileChooser-picker-item"
	| "WebBrowserFileChooser-picker-item-name"
	| "WebBrowserFileChooser-picker-item-path"
	| "WebBrowserFileChooser-error";

type WebBrowserFileChooser_Props = {
	sessionId: app_convex_Id<"files_browser_sessions">;
	chooser: Omit<Extract<files_browser_StreamWebMessage, { t: "file-chooser" }>, "t">;
	/**
	 * The control generation this viewer knows now. The runner refuses a fill for an older one.
	 */
	controlGen: number;
	/**
	 * Only the viewer with human control can give the page a file.
	 */
	hasControl: boolean;
	/**
	 * The user closed the dialog without a file.
	 */
	onCancel: () => void;
	/**
	 * The page got the files. The runner closes the chooser after one fill.
	 */
	onGiven: () => void;
	/**
	 * The page did not get the files. `text` is the refusal this dialog also shows inline. The runner
	 * can close the chooser before it answers, and that closes this dialog, so the host shows the text
	 * when the dialog is gone.
	 */
	onFailed: (chooserId: string, text: string) => void;
};

/**
 * The dialog shown when the page in the web browser opens a file dialog. The user gives the page
 * files from Files or one file from this computer. The host mounts it per chooser, so a new
 * chooser starts fresh.
 */
export const WebBrowserFileChooser = memo(function WebBrowserFileChooser(props: WebBrowserFileChooser_Props) {
	const { sessionId, chooser, controlGen, hasControl, onCancel, onGiven, onFailed } = props;
	const { membershipId } = AppTenantProvider.useContext();
	const convex = useConvex();
	const computerInputRef = useRef<HTMLInputElement>(null);
	// Every button turns disabled while a fill runs, and a disabled button drops keyboard focus to the
	// page body. The heading gets the focus instead, so keyboard users stay in the dialog.
	const headingRef = useRef<HTMLHeadingElement>(null);

	const [pickerOpen, setPickerOpen] = useState(false);
	const [searchText, setSearchText] = useState("");
	const [chosen, setChosen] = useState<Array<{ _id: app_convex_Id<"files_nodes">; name: string; path: string }>>([]);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The runner closes a chooser on any control change. The closed message can go missing with a
	// dropped socket, so a new control generation alone means this chooser is gone for good.
	const [openedControlGen] = useState(controlGen);

	// Load the whole workspace list only while the picker is open.
	const treeNodes = FilesTreeProvider.useFullList(pickerOpen);
	const fileNodes = (treeNodes ?? []).filter((node) => node.kind === "file" && node.archiveOperationId === null);
	const normalizedSearchText = searchText.trim().toLowerCase();
	const shownNodes = normalizedSearchText
		? fileNodes.filter((node) => node.path.toLowerCase().includes(normalizedSearchText))
		: fileNodes;

	const host = web_browser_file_chooser_host(chooser.origin);
	const acceptTypes = chooser.accept
		.split(",")
		.map((type) => type.trim())
		.filter((type) => type !== "");
	const full = chooser.multiple && chosen.length >= WEB_BROWSER_FILE_CHOOSER_MAX_FILES;
	const lost = !hasControl || controlGen !== openedControlGen;
	const blocked = lost || pending;

	const handleOpenChange = useFn((open: boolean) => {
		// A running fill owns the chooser, so the dialog stays until it answers.
		if (!open && !pending) {
			onCancel();
		}
	});

	const handlePickerOpenChange = useFn<NonNullable<MySearchSelect_Props["setOpen"]>>((open) => {
		setPickerOpen(open);
		if (!open) {
			setSearchText("");
		}
	});

	const handlePick = useFn<NonNullable<MySearchSelect_Props["setValue"]>>((value) => {
		const node = fileNodes.find((fileNode) => fileNode._id === value);
		if (!node) {
			return;
		}
		const picked = { _id: node._id, name: node.name, path: node.path };
		// A page that takes one file gets the last pick. A page that takes several keeps each new pick.
		setChosen((current) =>
			!chooser.multiple
				? [picked]
				: current.some((item) => item._id === picked._id) || current.length >= WEB_BROWSER_FILE_CHOOSER_MAX_FILES
					? current
					: [...current, picked],
		);
		setError(null);
	});

	const fail = (text: string) => {
		setError(text);
		onFailed(chooser.chooserId, text);
	};

	const handleGiveFromFiles = useFn(() => {
		headingRef.current?.focus();
		setPending(true);
		setError(null);
		convex
			.action(app_convex_api.files_browser.fill_browser_chooser_from_files, {
				membershipId,
				sessionId,
				chooserId: chooser.chooserId,
				controlGen,
				nodeIds: chosen.map((item) => item._id),
			})
			.then((result) => {
				if (result._nay) {
					fail(web_browser_file_chooser_error(result._nay.name, result._nay.message));
					return;
				}
				onGiven();
			})
			.catch((error: unknown) => {
				fail("The files could not be given to the page. Try again.");
				console.error("[WebBrowserFileChooser.giveFromFiles] Unexpected fill error", { error });
			})
			.finally(() => {
				setPending(false);
			});
	});

	const handleGiveFromComputer = useFn((event: ChangeEvent<HTMLInputElement>) => {
		const file = event.currentTarget.files?.[0];
		// Clear the input, so picking the same file again fires a change too.
		event.currentTarget.value = "";
		if (!file) {
			return;
		}
		if (file.size > WEB_BROWSER_FILE_CHOOSER_MAX_BYTES) {
			setError(web_browser_file_chooser_error("too_large", ""));
			return;
		}

		headingRef.current?.focus();
		setPending(true);
		setError(null);
		(async (/* iife */) => {
			const granted = await convex.action(app_convex_api.files_browser.grant_browser_upload, {
				membershipId,
				sessionId,
				chooserId: chooser.chooserId,
				controlGen,
			});
			if (granted._nay) {
				fail(web_browser_file_chooser_error(granted._nay.name, granted._nay.message));
				return;
			}

			// The grant is the secret of this single-use URL. The runner gives the page this one file.
			const response = await fetch(`${granted._yay.url}&name=${encodeURIComponent(file.name)}`, {
				method: "PUT",
				body: file,
				headers: { "Content-Type": file.type || "application/octet-stream" },
			});
			const reply: unknown = await response.json().catch(() => null);
			const replyRecord = reply !== null && typeof reply === "object" ? (reply as Record<string, unknown>) : null;
			if (!response.ok || replyRecord?.ok !== true) {
				fail(
					web_browser_file_chooser_error(
						typeof replyRecord?.code === "string" ? replyRecord.code : undefined,
						"The file could not be given to the page. Try again.",
					),
				);
				return;
			}
			onGiven();
		})()
			.catch((error: unknown) => {
				fail("The file could not be given to the page. Try again.");
				console.error("[WebBrowserFileChooser.giveFromComputer] Unexpected upload error", { error });
			})
			.finally(() => {
				setPending(false);
			});
	});

	return (
		<MyModal open setOpen={handleOpenChange}>
			<MyModalPopover className={"WebBrowserFileChooser" satisfies WebBrowserFileChooser_ClassNames}>
				<MyModalHeader>
					<MyModalHeading ref={headingRef} tabIndex={-1}>
						<strong>{host}</strong> {chooser.multiple ? "wants files" : "wants a file"}
					</MyModalHeading>
					<MyModalDescription>
						{acceptTypes.length > 0 ? `Accepted types: ${acceptTypes.join(", ")}.` : "Any type of file."}
					</MyModalDescription>
				</MyModalHeader>
				<MyModalScrollableArea>
					<div className={"WebBrowserFileChooser-content" satisfies WebBrowserFileChooser_ClassNames}>
						{/* The runner ties a chooser to one control generation and closes it when control
						    changes. Taking control again starts a new generation, so this chooser can never
						    take a file again. Say so, and point to Close instead of Take control. */}
						{lost && (
							<p className={"WebBrowserFileChooser-text" satisfies WebBrowserFileChooser_ClassNames}>
								Control of the browser changed, so the page no longer waits for this file. Close this dialog, take
								control, and open the file dialog on the page again.
							</p>
						)}
						<div className={"WebBrowserFileChooser-actions" satisfies WebBrowserFileChooser_ClassNames}>
							{/* The value stays "" because Ariakit adopts the first item's value on mount when no
							    value is given, and that would pick a file nobody chose. */}
							<MySearchSelect open={pickerOpen} setOpen={handlePickerOpenChange} value="" setValue={handlePick}>
								<MySearchSelectTrigger aria-label="Choose from Files" disabled={blocked || full}>
									<MyButton type="button" variant="outline">
										<MyButtonIcon>
											<FolderOpen aria-hidden />
										</MyButtonIcon>
										Choose from Files
									</MyButton>
								</MySearchSelectTrigger>
								<MySearchSelectPopover
									className={"WebBrowserFileChooser-picker" satisfies WebBrowserFileChooser_ClassNames}
									aria-label="Choose a file from Files"
								>
									<MySearchSelectPopoverScrollableArea>
										<MySearchSelectPopoverContent>
											<MySearchSelectSearch
												placeholder="Search files..."
												aria-label="Search files"
												onChange={(event) => setSearchText(event.currentTarget.value)}
											/>
											{shownNodes.length === 0 ? (
												<div
													className={"WebBrowserFileChooser-picker-empty" satisfies WebBrowserFileChooser_ClassNames}
												>
													{treeNodes === undefined
														? "Loading files…"
														: fileNodes.length === 0
															? "No files in this workspace"
															: "No results"}
												</div>
											) : (
												<MySearchSelectList>
													{shownNodes.map((node) => (
														<MySearchSelectItem
															key={node._id}
															value={node._id}
															className={"WebBrowserFileChooser-picker-item" satisfies WebBrowserFileChooser_ClassNames}
														>
															<span
																className={
																	"WebBrowserFileChooser-picker-item-name" satisfies WebBrowserFileChooser_ClassNames
																}
															>
																{node.name}
															</span>
															<span
																className={
																	"WebBrowserFileChooser-picker-item-path" satisfies WebBrowserFileChooser_ClassNames
																}
															>
																{node.path}
															</span>
														</MySearchSelectItem>
													))}
												</MySearchSelectList>
											)}
										</MySearchSelectPopoverContent>
									</MySearchSelectPopoverScrollableArea>
								</MySearchSelectPopover>
							</MySearchSelect>
							<MyButton
								variant="outline"
								disabled={blocked}
								aria-busy={pending}
								onClick={() => computerInputRef.current?.click()}
							>
								<MyButtonIcon>
									<Upload aria-hidden />
								</MyButtonIcon>
								From your computer
							</MyButton>
							<input
								ref={computerInputRef}
								type="file"
								hidden
								accept={chooser.accept || undefined}
								aria-label="File from your computer"
								onChange={handleGiveFromComputer}
							/>
						</div>
						{chooser.multiple && (
							<p className={"WebBrowserFileChooser-text" satisfies WebBrowserFileChooser_ClassNames}>
								One file at a time from your computer.
							</p>
						)}
						{chosen.length > 0 && (
							<>
								<ul
									className={"WebBrowserFileChooser-list" satisfies WebBrowserFileChooser_ClassNames}
									aria-label="Chosen files"
								>
									{chosen.map((item) => (
										<li
											key={item._id}
											className={"WebBrowserFileChooser-row" satisfies WebBrowserFileChooser_ClassNames}
										>
											<span>{item.path}</span>
											<MyButton
												variant="ghost"
												aria-label={`Remove ${item.name}`}
												disabled={pending}
												onClick={() => setChosen((current) => current.filter((other) => other._id !== item._id))}
											>
												Remove
											</MyButton>
										</li>
									))}
								</ul>
								<MyButton variant="default" disabled={blocked} aria-busy={pending} onClick={handleGiveFromFiles}>
									{chosen.length > 1 ? `Give ${chosen.length} files to the page` : "Give to the page"}
								</MyButton>
							</>
						)}
						{error && (
							<p className={"WebBrowserFileChooser-error" satisfies WebBrowserFileChooser_ClassNames} role="alert">
								{error}
							</p>
						)}
					</div>
				</MyModalScrollableArea>
				<MyModalFooter>
					{/* The keys make Close a new button, so `autoFocus` runs when control is lost. The
					    focused source turns disabled then, and the focus would fall to the page body. */}
					{lost ? (
						<MyButton key="close" variant="default" autoFocus disabled={pending} onClick={onCancel}>
							Close
						</MyButton>
					) : (
						<MyButton key="cancel" variant="ghost" disabled={pending} onClick={onCancel}>
							Cancel
						</MyButton>
					)}
				</MyModalFooter>
				<MyModalCloseTrigger disabled={pending} />
			</MyModalPopover>
		</MyModal>
	);
});
