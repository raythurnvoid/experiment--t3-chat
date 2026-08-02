import "./files-sidebar.css";
import React, {
	memo,
	useDeferredValue,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ComponentProps,
} from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { fromEvent, type FileWithPath } from "file-selector";
import {
	Archive,
	ArchiveRestore,
	ChevronDown,
	ChevronRight,
	Copy,
	EllipsisVertical,
	Edit2,
	FilePlus,
	FileText,
	FileUser,
	Folder,
	FolderPlus,
	FolderUp,
	Hash,
	Link2,
	Search,
	Upload,
	UserRound,
	Users,
	X,
	CopyMinus,
	CopyPlus,
} from "lucide-react";
import { useConvex, useQueries, useQuery, type ConvexReactClient } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
	dragAndDropFeature,
	expandAllFeature,
	hotkeysCoreFeature,
	propMemoizationFeature,
	renamingFeature,
	selectionFeature,
	syncDataLoaderFeature,
	type FeatureImplementation,
	type DragTarget,
	type SelectionDataRef,
	type TreeConfig,
	type TreeInstance,
} from "@headless-tree/core";
import { AssistiveTreeDescription } from "@headless-tree/react";
import { useTree } from "@headless-tree/react/react-compiler";
import { useNavigate } from "@tanstack/react-router";
import { MainAppSidebarToggle } from "@/components/main-app-sidebar-toggle.tsx";
import { FilesNameInputControl } from "./files-name-input.tsx";
import { FilesShareModal } from "./files-share-modal.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputHelperText,
	MyInputIcon,
} from "@/components/my-input.tsx";
import { MyIconButton, MyIconButtonIcon, type MyIconButton_Props } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyLink } from "@/components/my-link.tsx";
import { MySidebarHeader, MySidebarTitle } from "@/components/my-sidebar.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { MyPrimaryAction } from "@/components/my-action.tsx";
import { MyButton } from "@/components/my-button.tsx";
import {
	MyMenu,
	MyMenuCheckboxItem,
	MyMenuCheckboxItemControl,
	MyMenuItem,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	MyMenuItemsGroup,
	MyMenuPopover,
	MyMenuPopoverContent,
	MyMenuPopoverScrollableArea,
	MyMenuTrigger,
	type MyMenuItem_Props,
	type MyMenuPopover_ClassNames,
} from "@/components/my-menu.tsx";
import {
	MyContextMenu,
	MyContextMenuButtonTrigger,
	MyContextMenuPopover,
	MyContextMenuTrigger,
	type MyContextMenuTrigger_Props,
} from "@/components/my-context-menu.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
} from "@/components/my-modal.tsx";
import { useFileNodeActivities } from "@/lib/activities.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { cn, copy_to_clipboard, forward_ref, should_never_happen, sx } from "@/lib/utils.ts";
import { path_extract_segments_from, path_is_path_like } from "@/lib/paths.ts";
import {
	app_convex_api,
	app_convex_is_id_like,
	type app_convex_Doc,
	type app_convex_Id,
} from "@/lib/app-convex-client.ts";
import { url_parse_file_link, url_path_file_by_node_id } from "@/lib/urls.ts";
import { dom_clear_text_selection, type AppElementId } from "@/lib/dom-utils.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { useGlobalEventList } from "@/lib/global-event.tsx";
import { useDebounce, useFn, useVal } from "@/hooks/utils-hooks.ts";
import {
	files_ROOT_ID,
	files_SYNTHETIC_ROOT_FOLDER,
	files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE,
	files_clear_node_path_cached_validation_messages,
	files_create_tree_items_list_from_nodes,
	files_get_default_node_name,
	files_get_node_path_validation,
	files_IMPORT_MAX_ITEMS_PER_CALL,
	files_is_node,
	files_MAX_UPLOADS_BYTES,
	files_name_input_select_stem,
	files_normalize_name,
	files_normalize_markdown_name,
	files_normalize_upload_file_name,
	type files_ContentType,
	type files_EditorView,
	type files_TreeItem,
	type files_VisibleTreeNode,
} from "@/lib/files.ts";
import { format_relative_time } from "@/lib/date.ts";
import { async_all_settled_with_limit } from "@/lib/async.ts";

type FilesSidebarTree_Shared = () => TreeInstance<files_TreeItem>;
type FilesSidebarTreeItem_Instance = ReturnType<TreeInstance<files_TreeItem>["getItemInstance"]>;

type DropZone =
	| { kind: "root" }
	| {
			kind: "folder";
			top: string;
			height: string;
	  };

type DropZoneRow = {
	id: string;
	parentId: string;
	kind: files_TreeItem["kind"];
	depth: number;
	hasPlaceholderRow: boolean;
};

const ROW_HEIGHT_PX = 45;
const FILES_SIDEBAR_SELECTION_CONTEXT_EVENTS: Array<"pointerdown" | "focusin"> = ["pointerdown", "focusin"];
const IMAGE_UPLOAD_COMPRESSION_MAX_DIMENSION_PX = 2048;
const IMAGE_UPLOAD_COMPRESSION_QUALITY = 0.82;

type CustomAttributes = {
	"data-files-sidebar-tree-context": "";
};

type FilesSidebarTreeItem_CustomAttributes = {
	"data-file-id": string;
};

type FilesSidebarTreeItemRestrictedIcon_CustomAttributes = {
	/**
	 * `"self"` because the sidebar only marks the node that carries the restriction. The file header
	 * uses the same attribute and also emits `"inherited"` for something inside a restricted folder, so
	 * a browser test reads one value and knows which of the two it found.
	 */
	"data-file-restricted": "self";
};

type TreeItems = {
	list: files_TreeItem[] | undefined;
	itemsIds: Set<string>;
	itemsIdsByParentId: Map<string, Set<string>>;
	sortedItemsIdsByParentId: Map<string, string[]>;
	itemById: Map<string, files_TreeItem>;
};

function has_file_drop(dataTransfer: DataTransfer) {
	return Array.from(dataTransfer.types).includes("Files");
}

function upload_filename_has_real_extension(filename: string) {
	const extensionSeparatorIndex = filename.lastIndexOf(".");
	return extensionSeparatorIndex > 0 && extensionSeparatorIndex < filename.length - 1;
}

function image_upload_compression_mime_type(file: File) {
	switch (file.type) {
		case "image/jpeg":
		case "image/png":
		case "image/webp":
			return file.type;
		default:
			// Keep animated GIFs and unsupported formats untouched; the image
			// description pipeline can still process them without losing animation.
			return null;
	}
}

async function canvas_to_blob(canvas: HTMLCanvasElement, type: string) {
	return await new Promise<Blob | null>((resolve) => {
		canvas.toBlob(resolve, type, IMAGE_UPLOAD_COMPRESSION_QUALITY);
	});
}

async function prepare_image_upload_file(file: File) {
	const outputType = image_upload_compression_mime_type(file);
	if (!outputType) {
		return file;
	}

	let imageBitmap: ImageBitmap | null = null;
	try {
		// Use browser-native decoding/resampling so uploads get smaller before the
		// signed R2 PUT without adding a client-side encoder dependency.
		imageBitmap = await createImageBitmap(file);
		const scale = Math.min(
			1,
			IMAGE_UPLOAD_COMPRESSION_MAX_DIMENSION_PX / Math.max(imageBitmap.width, imageBitmap.height),
		);
		if (scale === 1 && outputType === "image/png") {
			// Keep small PNGs original; re-encoding them usually increases size or
			// degrades sharp UI screenshots without reducing transfer cost.
			return file;
		}

		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(imageBitmap.width * scale));
		canvas.height = Math.max(1, Math.round(imageBitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) {
			return file;
		}

		context.drawImage(imageBitmap, 0, 0, canvas.width, canvas.height);
		const compressedBlob = await canvas_to_blob(canvas, outputType);
		if (!compressedBlob || compressedBlob.size >= file.size) {
			// Keep the original whenever compression is not a strict win.
			return file;
		}

		return new File([compressedBlob], file.name, {
			type: compressedBlob.type || file.type,
			lastModified: file.lastModified,
		});
	} catch (error) {
		console.warn("[FilesSidebar.prepareImageUploadFile] Failed to compress image upload", { error });
		return file;
	} finally {
		imageBitmap?.close();
	}
}

// #region folder import
const FILES_IMPORT_MAX_FILES = 1000;
const FILES_IMPORT_MAX_CHUNK_BYTES = 1024 * 1024 * 1024;
const FILES_IMPORT_MAX_PATH_DEPTH = 32;
const FILES_IMPORT_MAX_PATH_LENGTH = 1024;
const FILES_IMPORT_PREPARE_CONCURRENCY = 4;
const FILES_IMPORT_PUT_CONCURRENCY = 4;
const FILES_IMPORT_PROGRESS_TOAST_ID = "files-sidebar-import-progress";

// `fromEvent` filters these junk files for drops but not for folder picker files, so the shared
// entry builder filters both entry points the same way.
const FILES_IMPORT_JUNK_FILE_NAMES = new Set([".DS_Store", "Thumbs.db"]);

type FilesImportSkipReason =
	| "invalid_name"
	| "missing_extension"
	| "too_large"
	| "too_deep"
	| "duplicate_after_normalization"
	| "conflict"
	| "path_blocked";

type FilesImportConflict = {
	relativePath: string;
	kind: files_TreeItem["kind"];
};

type FilesImportStoreState = {
	phase: "idle" | "preparing" | "confirming" | "uploading";
	/**
	 * The membership the import started under. A workspace switch mid-import requests a cancel.
	 */
	membershipId: app_convex_Id<"organizations_workspaces_users"> | null;
	/** How many files entered the upload phase. */
	total: number;
	/** How many files finished uploading. */
	done: number;
	/** Client-side and server-side skips, merged for the final report. */
	skipped: Array<{ relativePath: string; reason: FilesImportSkipReason }>;
	failed: Array<{ relativePath: string }>;
	/**
	 * Non-empty exactly while the confirm modal is open.
	 */
	conflicts: FilesImportConflict[];
	cancelRequested: boolean;
	confirmResolver: ((choice: "replace" | "skip" | "cancel") => void) | null;
};

const FILES_IMPORT_INITIAL_STATE: FilesImportStoreState = {
	phase: "idle",
	membershipId: null,
	total: 0,
	done: 0,
	skipped: [],
	failed: [],
	conflicts: [],
	cancelRequested: false,
	confirmResolver: null,
};

// Module-level so a sidebar unmount/remount re-attaches to a running import instead of losing it.
const useFilesImportStore = create<FilesImportStoreState>(() => ({ ...FILES_IMPORT_INITIAL_STATE }));

type FilesImportEntry = {
	file: FileWithPath;
	/** Raw browser path relative to the dropped or picked folder, before normalization. */
	relativePath: string;
};

/**
 * Build the folder-relative path for each dropped or picked file. Drops carry `path` like
 * `/folder/file.txt`, the folder picker carries `webkitRelativePath` like `folder/file.txt`,
 * and a bare file carries `./file.txt`. All three shapes become `folder/file.txt` or
 * `file.txt` here, so both entry points behave the same.
 */
function get_import_file_entries(files: FileWithPath[]) {
	const entries: FilesImportEntry[] = [];
	for (const file of files) {
		const rawPath = file.path ?? file.relativePath ?? file.name;
		const segments = rawPath.split("/").filter((segment) => segment !== "" && segment !== ".");
		if (segments.length === 0) {
			continue;
		}
		if (FILES_IMPORT_JUNK_FILE_NAMES.has(segments[segments.length - 1]!)) {
			continue;
		}

		entries.push({ file, relativePath: segments.join("/") });
	}
	return entries;
}

type FilesImportPlanItem = {
	file: File;
	/** Original browser path, used in skip and failure reports. */
	relativePath: string;
	/** Fully normalized path sent to the server, which requires already-normalized segments. */
	normalizedPath: string;
	contentType: string | undefined;
};

/**
 * Normalize every path, pre-filter the files the server would reject, and dedupe target paths.
 * The server treats a non-normalized path as a caller bug and fails the whole call, so this
 * step is what turns messy real folder names into an importable batch.
 */
function build_import_plan(entries: FilesImportEntry[]) {
	const items: FilesImportPlanItem[] = [];
	const skipped: Array<{ relativePath: string; reason: FilesImportSkipReason }> = [];
	const seenPaths = new Set<string>();

	for (const entry of entries) {
		const segments = entry.relativePath.split("/");
		const contentType = entry.file.type || undefined;
		const isMarkdown = contentType?.startsWith("text/markdown" satisfies files_ContentType) ?? false;

		const normalizedSegments: string[] = [];
		let skipReason: FilesImportSkipReason | null = null;
		for (const [index, segment] of segments.entries()) {
			if (index < segments.length - 1) {
				const normalizedFolder = files_normalize_name("folder", segment);
				if (normalizedFolder._nay) {
					skipReason = "invalid_name";
					break;
				}
				normalizedSegments.push(normalizedFolder._yay);
				continue;
			}

			// Markdown tooling also saves `.markdown`, but only `.md` is storable as an editable file.
			const leafInput = isMarkdown ? segment.replace(/\.markdown$/i, ".md") : segment;
			if (isMarkdown) {
				const normalizedLeaf = files_normalize_markdown_name(leafInput);
				if (normalizedLeaf._nay) {
					skipReason = "invalid_name";
					break;
				}
				normalizedSegments.push(normalizedLeaf._yay);
			} else {
				const normalizedLeaf = files_normalize_upload_file_name(leafInput);
				if (!upload_filename_has_real_extension(normalizedLeaf)) {
					skipReason = "missing_extension";
					break;
				}
				normalizedSegments.push(normalizedLeaf);
			}
		}
		if (skipReason) {
			skipped.push({ relativePath: entry.relativePath, reason: skipReason });
			continue;
		}

		const normalizedPath = normalizedSegments.join("/");
		if (normalizedSegments.length > FILES_IMPORT_MAX_PATH_DEPTH || normalizedPath.length > FILES_IMPORT_MAX_PATH_LENGTH) {
			skipped.push({ relativePath: entry.relativePath, reason: "too_deep" });
			continue;
		}

		// Different browser names can normalize to one app path ("My File.PNG" and "my-file.png").
		// The first file in traversal order wins; without this dedupe a later chunk would see the
		// earlier chunk's node as a conflict and, in replace mode, archive a file imported seconds
		// before.
		if (seenPaths.has(normalizedPath)) {
			skipped.push({ relativePath: entry.relativePath, reason: "duplicate_after_normalization" });
			continue;
		}
		seenPaths.add(normalizedPath);

		items.push({ file: entry.file, relativePath: entry.relativePath, normalizedPath, contentType });
	}

	return { items, skipped };
}

function chunk_array<T>(items: T[], size: number) {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

/**
 * Chunk by item count and by declared bytes. Presigned URLs are minted per chunk right before
 * their PUTs, so a byte-bounded chunk keeps a URL from sitting longer than one chunk's upload.
 */
function chunk_import_items(items: FilesImportPlanItem[]) {
	const chunks: FilesImportPlanItem[][] = [];
	let currentChunk: FilesImportPlanItem[] = [];
	let currentChunkBytes = 0;
	for (const item of items) {
		if (
			currentChunk.length >= files_IMPORT_MAX_ITEMS_PER_CALL ||
			(currentChunk.length > 0 && currentChunkBytes + item.file.size > FILES_IMPORT_MAX_CHUNK_BYTES)
		) {
			chunks.push(currentChunk);
			currentChunk = [];
			currentChunkBytes = 0;
		}
		currentChunk.push(item);
		currentChunkBytes += item.file.size;
	}
	if (currentChunk.length > 0) {
		chunks.push(currentChunk);
	}
	return chunks;
}

function show_import_progress_toast() {
	const state = useFilesImportStore.getState();
	const message =
		state.phase === "preparing"
			? "Preparing files to import..."
			: state.phase === "confirming"
				? "Waiting for a choice about existing files..."
				: `Uploading ${Math.min(state.done + 1, state.total)} of ${state.total} files...`;

	toast(message, {
		id: FILES_IMPORT_PROGRESS_TOAST_ID,
		duration: Infinity,
		action: {
			label: "Cancel",
			onClick: (event) => {
				// Keep the toast visible; the import loop dismisses it when the run really stops.
				event.preventDefault();
				useFilesImportStore.setState({ cancelRequested: true });
			},
		},
	});
}

function finish_import_run() {
	const state = useFilesImportStore.getState();
	toast.dismiss(FILES_IMPORT_PROGRESS_TOAST_ID);

	if (state.skipped.length > 0) {
		console.info("[FilesSidebar.runFolderImport] Skipped files", { skipped: state.skipped });
	}
	if (state.failed.length > 0) {
		console.error("[FilesSidebar.runFolderImport] Failed uploads", { failed: state.failed });
	}

	const summaryParts = [`${state.done} imported`];
	if (state.skipped.length > 0) {
		summaryParts.push(`${state.skipped.length} skipped`);
	}
	if (state.failed.length > 0) {
		summaryParts.push(`${state.failed.length} failed`);
	}
	const summary = summaryParts.join(", ");

	if (state.cancelRequested) {
		toast.info(`Import cancelled: ${summary}.`);
	} else if (state.failed.length > 0) {
		toast.error(`Import finished: ${summary}.`);
	} else {
		toast.success(`Import finished: ${summary}.`);
	}

	useFilesImportStore.setState({ ...FILES_IMPORT_INITIAL_STATE });
}

type FilesImportCreatedItem = {
	relativePath: string;
	nodeId: app_convex_Id<"files_nodes">;
	url: string;
	headers: Record<string, string>;
};

/**
 * Run one whole folder import: normalize and pre-filter the files, ask about conflicts once,
 * then create nodes and upload bytes chunk by chunk. Progress, cancellation, and the confirm
 * modal all go through `useFilesImportStore`.
 *
 * Module-level on purpose: the run must survive a sidebar remount, and outside a component the
 * React Compiler's try/catch constraints do not apply.
 */
async function run_folder_import(args: {
	convex: ConvexReactClient;
	membershipId: app_convex_Id<"organizations_workspaces_users">;
	parentId: app_convex_Id<"files_nodes"> | typeof files_ROOT_ID;
	entries: FilesImportEntry[];
}) {
	const plan = build_import_plan(args.entries);
	useFilesImportStore.setState({
		...FILES_IMPORT_INITIAL_STATE,
		phase: "preparing",
		membershipId: args.membershipId,
		skipped: plan.skipped,
	});
	show_import_progress_toast();

	try {
		// Compress images first so the declared sizes match the bytes that actually upload.
		// `prepare_image_upload_file` returns the original file on any decode error, so a
		// rejected slot here is unexpected; fall back to the original file for it too.
		const preparedResults = await async_all_settled_with_limit(plan.items, FILES_IMPORT_PREPARE_CONCURRENCY, (item) =>
			prepare_image_upload_file(item.file),
		);

		const uploadItems: FilesImportPlanItem[] = [];
		for (const [index, item] of plan.items.entries()) {
			const preparedResult = preparedResults[index]!;
			const preparedFile = preparedResult.status === "fulfilled" ? preparedResult.value : item.file;
			if (preparedFile.size > files_MAX_UPLOADS_BYTES) {
				useFilesImportStore.setState((state) => ({
					skipped: [...state.skipped, { relativePath: item.relativePath, reason: "too_large" as const }],
				}));
				continue;
			}
			uploadItems.push({ ...item, file: preparedFile });
		}

		if (uploadItems.length === 0 || useFilesImportStore.getState().cancelRequested) {
			finish_import_run();
			return;
		}

		// Ask once which target paths already exist, so the user decides before any write.
		const conflicts: FilesImportConflict[] = [];
		for (const itemChunk of chunk_array(uploadItems, files_IMPORT_MAX_ITEMS_PER_CALL)) {
			const chunkConflicts = await args.convex.query(app_convex_api.files_nodes.get_upload_conflicts, {
				membershipId: args.membershipId,
				parentId: args.parentId,
				relativePaths: itemChunk.map((item) => item.normalizedPath),
			});
			conflicts.push(...chunkConflicts);
		}

		let onConflict: "replace" | "skip" = "skip";
		if (conflicts.length > 0) {
			const choice = await new Promise<"replace" | "skip" | "cancel">((resolve) => {
				useFilesImportStore.setState({ phase: "confirming", conflicts, confirmResolver: resolve });
			});
			useFilesImportStore.setState({ conflicts: [], confirmResolver: null });
			if (choice === "cancel") {
				useFilesImportStore.setState({ cancelRequested: true });
				finish_import_run();
				return;
			}
			onConflict = choice;
		}

		useFilesImportStore.setState({ phase: "uploading", total: uploadItems.length });
		show_import_progress_toast();

		const discard_unuploaded_node = async (
			created: Pick<FilesImportCreatedItem, "nodeId" | "relativePath">,
			opts: { reportFailed: boolean },
		) => {
			// The discard charges the same bulk bucket as the create calls, which a cancel right
			// after a chunk has just drained. Wait the bucket out like `process_chunk` does, or the
			// node this discard should remove would stay in the tree as a phantom row forever.
			let discarded: FunctionReturnType<typeof app_convex_api.files_nodes.discard_failed_upload_node> | null = null;
			while (discarded === null) {
				discarded = await args.convex
					.mutation(app_convex_api.files_nodes.discard_failed_upload_node, {
						membershipId: args.membershipId,
						nodeId: created.nodeId,
					})
					.catch((error: unknown) => {
						console.error("[FilesSidebar.runFolderImport] Unexpected discard error", { error, nodeId: created.nodeId });
						return null;
					});
				if (discarded === null) {
					break;
				}
				// "Rate limit exceeded" is the literal from `rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE`.
				if (discarded._nay && discarded._nay.message === "Rate limit exceeded") {
					const retryAfterMs = discarded._nay.data?.retryAfterMs ?? 5000;
					await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
					discarded = null;
				}
			}

			// `removed: false` means the R2 event recorded the object first, so the upload landed
			// after all and the file must count as imported.
			if (discarded && !discarded._nay && !discarded._yay.removed) {
				useFilesImportStore.setState((state) => ({ done: state.done + 1 }));
				return;
			}

			if (discarded?._nay) {
				console.error("[FilesSidebar.runFolderImport] Failed to discard upload node", {
					error: discarded._nay,
					nodeId: created.nodeId,
				});
			}
			if (opts.reportFailed) {
				useFilesImportStore.setState((state) => ({
					failed: [...state.failed, { relativePath: created.relativePath }],
				}));
			}
		};

		const process_chunk = async (chunk: FilesImportPlanItem[]): Promise<"continue" | "stop"> => {
			// Create the chunk's nodes, waiting out rate limits instead of failing the run. The
			// bulk bucket refills at a fixed rate, so big imports pause between chunks by design.
			let createdItems: FilesImportCreatedItem[] | null = null;
			while (createdItems === null) {
				if (useFilesImportStore.getState().cancelRequested) {
					return "stop";
				}

				const result = await args.convex.mutation(app_convex_api.files_nodes.create_upload_nodes, {
					membershipId: args.membershipId,
					parentId: args.parentId,
					onConflict,
					items: chunk.map((item) => ({
						relativePath: item.normalizedPath,
						contentType: item.contentType,
						size: item.file.size,
					})),
				});
				if (result._nay) {
					// "Rate limit exceeded" is the literal from `rate_limiter_RATE_LIMIT_EXCEEDED_MESSAGE`.
					if (result._nay.message === "Rate limit exceeded") {
						const retryAfterMs = result._nay.data?.retryAfterMs ?? 5000;
						await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
						continue;
					}

					console.error("[FilesSidebar.runFolderImport] Failed to create upload nodes", { error: result._nay });
					useFilesImportStore.setState((state) => ({
						failed: [...state.failed, ...chunk.map((item) => ({ relativePath: item.relativePath }))],
					}));
					return "stop";
				}

				useFilesImportStore.setState((state) => ({ skipped: [...state.skipped, ...result._yay.skipped] }));
				createdItems = result._yay.created;
			}

			const itemByPath = new Map(chunk.map((item) => [item.normalizedPath, item]));
			// Each task reports its own failure and never rejects, so the settled results are unused.
			await async_all_settled_with_limit(createdItems, FILES_IMPORT_PUT_CONCURRENCY, async (created) => {
				const item = itemByPath.get(created.relativePath);
				if (!item) {
					console.error(
						should_never_happen("[FilesSidebar.runFolderImport] created item without a matching plan item", {
							relativePath: created.relativePath,
						}),
					);
					return;
				}

				// Cancelling removes the nodes whose bytes were never sent, so no "waiting for
				// upload" phantom rows stay in the tree.
				if (useFilesImportStore.getState().cancelRequested) {
					await discard_unuploaded_node(created, { reportFailed: false });
					return;
				}

				try {
					const response = await fetch(created.url, { method: "PUT", headers: created.headers, body: item.file });
					if (!response.ok) {
						throw new Error(`R2 upload failed with status ${response.status}`);
					}
					useFilesImportStore.setState((state) => ({ done: state.done + 1 }));
					show_import_progress_toast();
				} catch (error) {
					// A non-ok response and a rejected fetch (a file changed on disk mid-read)
					// both end here: report the file and remove its placeholder node.
					console.error("[FilesSidebar.runFolderImport] Failed to upload file", {
						error,
						relativePath: created.relativePath,
					});
					await discard_unuploaded_node(created, { reportFailed: true });
				}
			});

			return "continue";
		};

		const chunks = chunk_import_items(uploadItems);
		for (const [chunkIndex, chunk] of chunks.entries()) {
			if (useFilesImportStore.getState().cancelRequested) {
				break;
			}
			if ((await process_chunk(chunk)) === "stop") {
				// The chunks after a failed call were never attempted; report their files too, so
				// the summary accounts for every file. A cancel is not a failure.
				const remainingItems = chunks.slice(chunkIndex + 1).flat();
				if (remainingItems.length > 0 && !useFilesImportStore.getState().cancelRequested) {
					useFilesImportStore.setState((state) => ({
						failed: [...state.failed, ...remainingItems.map((item) => ({ relativePath: item.relativePath }))],
					}));
				}
				break;
			}
		}

		finish_import_run();
	} catch (error) {
		console.error("[FilesSidebar.runFolderImport] Unexpected import error", { error });
		toast.dismiss(FILES_IMPORT_PROGRESS_TOAST_ID);
		toast.error("Import failed.");
		useFilesImportStore.setState({ ...FILES_IMPORT_INITIAL_STATE });
	}
}
// #endregion folder import

// #region tree item icon
type FilesSidebarTreeItemIcon_ClassNames =
	| "FilesSidebarTreeItemIcon"
	| "FilesSidebarTreeItemIcon-restricted-folder"
	| "FilesSidebarTreeItemIcon-restricted-folder-person";

type FilesSidebarTreeItemIcon_Props = {
	kind: files_TreeItem["kind"];
	isRestricted?: boolean;
};

/**
 * The row's leading icon, which also says whether the node is restricted.
 *
 * The mark lives here and nowhere else. On the name line it would land at the right edge next to the
 * hover buttons and read as a third, broken one; on the meta line it needs a word to be understood,
 * and a word is what the design rejected. The leading slot is the one people scan first, it costs no
 * width in a narrow sidebar, and it cannot collide with anything.
 *
 * People, not a padlock: whoever sees this row is somebody the restriction lets in, and a lock reads
 * as "you are shut out" to exactly the people who are not.
 *
 * Files get lucide's own `FileUser`. Folders have no such icon in the set, so one is composed from
 * `Folder` and `UserRound` instead of hand-drawing an SVG we would then have to keep in step with
 * lucide. Both halves inherit `currentColor`, so the mark keeps the row's contrast in every state
 * and stays visible under forced colors.
 */
const FilesSidebarTreeItemIcon = memo(function FilesSidebarTreeItemIcon(props: FilesSidebarTreeItemIcon_Props) {
	const { kind, isRestricted } = props;

	// Decoration only. The row's accessible name already ends in "restricted" and its tooltip spells
	// out what that means, so announcing it here would say the same thing twice.
	const restrictedAttributes = isRestricted
		? ({ "data-file-restricted": "self" } satisfies FilesSidebarTreeItemRestrictedIcon_CustomAttributes)
		: null;

	if (kind === "folder" && isRestricted) {
		return (
			<MyIcon
				className={cn(
					"FilesSidebarTreeItemIcon" satisfies FilesSidebarTreeItemIcon_ClassNames,
					"FilesSidebarTreeItemIcon-restricted-folder" satisfies FilesSidebarTreeItemIcon_ClassNames,
				)}
				aria-hidden="true"
				{...restrictedAttributes}
			>
				<Folder />
				<UserRound
					className={"FilesSidebarTreeItemIcon-restricted-folder-person" satisfies FilesSidebarTreeItemIcon_ClassNames}
				/>
			</MyIcon>
		);
	}

	return (
		<MyIcon
			className={"FilesSidebarTreeItemIcon" satisfies FilesSidebarTreeItemIcon_ClassNames}
			aria-hidden="true"
			{...restrictedAttributes}
		>
			{kind === "folder" ? <Folder /> : isRestricted ? <FileUser /> : <FileText />}
		</MyIcon>
	);
});
// #endregion tree item icon

// #region tree item secondary action
type FilesSidebarTreeItemSecondaryAction_ClassNames = "FilesSidebarTreeItemSecondaryAction";

type FilesSidebarTreeItemSecondaryAction_Props = {
	className: string;
	children: React.ReactNode;
	tooltip: string;
	isActive: boolean;
	disabled: boolean;
	ariaLabel: string;
	onClick: () => void;
};

const FilesSidebarTreeItemSecondaryAction = memo(function FilesSidebarTreeItemSecondaryAction(
	props: FilesSidebarTreeItemSecondaryAction_Props,
) {
	const { className, children, tooltip, isActive, disabled, ariaLabel, onClick } = props;

	const handleClick = useFn<MyIconButton_Props["onClick"]>(() => {
		onClick();
	});

	return (
		<MyIconButton
			variant="ghost-highlightable"
			className={cn(
				"FilesSidebarTreeItemSecondaryAction" satisfies FilesSidebarTreeItemSecondaryAction_ClassNames,
				className,
			)}
			tooltip={tooltip}
			tooltipSide="bottom"
			tabIndex={isActive ? 0 : -1}
			disabled={disabled}
			aria-label={ariaLabel}
			onClick={handleClick}
		>
			<MyIconButtonIcon>{children}</MyIconButtonIcon>
		</MyIconButton>
	);
});
// #endregion tree item secondary action

// #region tree item secondary action create file
type FilesSidebarTreeItemSecondaryActionCreateFile_ClassNames = "FilesSidebarTreeItemSecondaryActionCreateFile";

type FilesSidebarTreeItemSecondaryActionCreateFile_Props = {
	kind: files_TreeItem["kind"];
	label: string;
	isActive: boolean;
	disabled: boolean;
	onClick: () => void;
};

const FilesSidebarTreeItemSecondaryActionCreateFile = memo(function FilesSidebarTreeItemSecondaryActionCreateFile(
	props: FilesSidebarTreeItemSecondaryActionCreateFile_Props,
) {
	const { kind, label, isActive, disabled, onClick } = props;
	const actionLabel = kind === "folder" ? "Add folder" : "Add file";

	return (
		<FilesSidebarTreeItemSecondaryAction
			className={cn(
				"FilesSidebarTreeItemSecondaryActionCreateFile" satisfies FilesSidebarTreeItemSecondaryActionCreateFile_ClassNames,
			)}
			tooltip={actionLabel}
			isActive={isActive}
			disabled={disabled}
			ariaLabel={`${actionLabel} to ${label}`}
			onClick={onClick}
		>
			{kind === "folder" ? <FolderPlus /> : <FilePlus />}
		</FilesSidebarTreeItemSecondaryAction>
	);
});
// #endregion tree item secondary action create file

// #region tree item more action
type FilesSidebarTreeItemMoreAction_ClassNames = "FilesSidebarTreeItemMoreAction";

type FilesSidebarTreeItemMoreAction_Props = {
	label: string;
	isPending: boolean;
	isFocused: boolean;
};

const FilesSidebarTreeItemMoreAction = memo(function FilesSidebarTreeItemMoreAction(
	props: FilesSidebarTreeItemMoreAction_Props,
) {
	const { label, isPending, isFocused } = props;

	return (
		<MyContextMenuButtonTrigger tabIndex={isFocused ? 0 : -1}>
			<MyIconButton
				className={cn("FilesSidebarTreeItemMoreAction" satisfies FilesSidebarTreeItemMoreAction_ClassNames)}
				variant="ghost-highlightable"
				tooltip={"More actions"}
				disabled={isPending}
				aria-label={`More actions for ${label}`}
			>
				<MyIconButtonIcon>
					<EllipsisVertical />
				</MyIconButtonIcon>
			</MyIconButton>
		</MyContextMenuButtonTrigger>
	);
});
// #endregion tree item more action

// #region tree item menu popover
type FilesSidebarTreeItemMenuPopover_ClassNames =
	| "FilesSidebarTreeItemMenuPopover-create-action"
	| "FilesSidebarTreeItemMenuPopover-create-action-visible";

type FilesSidebarTreeItemMenuPopover_Props = {
	kind: files_TreeItem["kind"];
	label: string;
	archiveOperationId: string | undefined;
	canCreate: boolean;
	canRename: boolean;
	canShare: boolean;
	canArchive: boolean;
	canExpandSubtree: boolean;
	canCollapseSubtree: boolean;
	expandedFolderActionsVisible: boolean;
	onCreateFile: () => void;
	onCreateFolder: () => void;
	onCopy: () => void;
	onCopyLink: () => void;
	onCopyNodeId: () => void;
	onRename: () => void;
	onShare: () => void;
	onExpandSubtree: () => void;
	onCollapseSubtree: () => void;
	onArchive: () => void;
	onUnarchive: () => void;
};

const FilesSidebarTreeItemMenuPopover = memo(function FilesSidebarTreeItemMenuPopover(
	props: FilesSidebarTreeItemMenuPopover_Props,
) {
	const {
		kind,
		label,
		archiveOperationId,
		canCreate,
		canRename,
		canShare,
		canArchive,
		canExpandSubtree,
		canCollapseSubtree,
		expandedFolderActionsVisible,
		onCreateFile,
		onCreateFolder,
		onCopy,
		onCopyLink,
		onCopyNodeId,
		onRename,
		onShare,
		onExpandSubtree,
		onCollapseSubtree,
		onArchive,
		onUnarchive,
	} = props;
	const isArchived = archiveOperationId !== undefined;

	const handleRenameClick = useFn<MyMenuItem_Props["onClick"]>(() => {
		// Let Ariakit finish closing the menu and restoring focus before Headless Tree enters rename mode.
		setTimeout(() => {
			onRename();
		}, 0);
	});

	const handleArchiveUnarchiveClick = useFn<MyMenuItem_Props["onClick"]>(() => {
		if (isArchived) {
			onUnarchive();
		} else {
			onArchive();
		}
	});

	return (
		<MyContextMenuPopover
			{...({
				"data-files-sidebar-tree-context": "",
			} satisfies Partial<CustomAttributes>)}
		>
			<MyMenuPopoverScrollableArea>
				<MyMenuPopoverContent>
					{kind === "folder" ? (
						<MyMenuItemsGroup>
							<MyMenuItem
								className={cn(
									"FilesSidebarTreeItemMenuPopover-create-action" satisfies FilesSidebarTreeItemMenuPopover_ClassNames,
									expandedFolderActionsVisible &&
										("FilesSidebarTreeItemMenuPopover-create-action-visible" satisfies FilesSidebarTreeItemMenuPopover_ClassNames),
								)}
								aria-label={`Add file to ${label}`}
								disabled={!canCreate}
								hideOnClick
								onClick={onCreateFile}
							>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>
										<FilePlus />
									</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>Add file</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
							<MyMenuItem
								className={cn(
									"FilesSidebarTreeItemMenuPopover-create-action" satisfies FilesSidebarTreeItemMenuPopover_ClassNames,
									expandedFolderActionsVisible &&
										("FilesSidebarTreeItemMenuPopover-create-action-visible" satisfies FilesSidebarTreeItemMenuPopover_ClassNames),
								)}
								aria-label={`Add folder to ${label}`}
								disabled={!canCreate}
								hideOnClick
								onClick={onCreateFolder}
							>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>
										<FolderPlus />
									</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>Add folder</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
						</MyMenuItemsGroup>
					) : null}
					<MyMenuItemsGroup separator={kind === "folder" && expandedFolderActionsVisible}>
						<MyMenuItem hideOnClick onClick={onCopy}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<Copy />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>Copy path</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
						<MyMenuItem hideOnClick onClick={onCopyLink}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<Link2 />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>Copy link</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
						<MyMenuItem hideOnClick onClick={onCopyNodeId}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<Hash />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>Copy node id</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
						<MyMenuItem disabled={!canRename} hideOnClick onClick={handleRenameClick}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<Edit2 />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>Rename</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
					</MyMenuItemsGroup>
					{kind === "folder" ? (
						<MyMenuItemsGroup separator>
							<MyMenuItem disabled={!canExpandSubtree} hideOnClick onClick={onExpandSubtree}>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>
										<CopyPlus />
									</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>Expand subtree</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
							<MyMenuItem disabled={!canCollapseSubtree} hideOnClick onClick={onCollapseSubtree}>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>
										<CopyMinus />
									</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>Collapse subtree</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
						</MyMenuItemsGroup>
					) : null}
					<MyMenuItemsGroup separator>
						<MyMenuItem disabled={!canShare} hideOnClick onClick={onShare}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<Users />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>Share</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
					</MyMenuItemsGroup>
					<MyMenuItemsGroup separator>
						<MyMenuItem
							variant={isArchived ? "default" : "destructive"}
							disabled={!canArchive}
							hideOnClick
							onClick={handleArchiveUnarchiveClick}
						>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>{isArchived ? <ArchiveRestore /> : <Archive />}</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>{isArchived ? "Restore" : "Archive"}</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
					</MyMenuItemsGroup>
				</MyMenuPopoverContent>
			</MyMenuPopoverScrollableArea>
		</MyContextMenuPopover>
	);
});
// #endregion tree item menu popover

// #region tree item arrow
type FilesSidebarTreeItemArrow_ClassNames = "FilesSidebarTreeItemArrow" | "FilesSidebarTreeItemArrow-icon-button";

function files_sidebar_tree_item_arrow_dom_id(itemId: string) {
	return `files_sidebar_tree_item_arrow_${itemId}`;
}

type FilesSidebarTreeItemArrow_Props = {
	itemId: string;
	label: string;
	isExpanded: boolean;
	isPending: boolean;
	isFocused: boolean;
	onClick: () => void;
};

const FilesSidebarTreeItemArrow = memo(function FilesSidebarTreeItemArrow(props: FilesSidebarTreeItemArrow_Props) {
	const { itemId, label, isExpanded, isPending, isFocused, onClick } = props;
	const actionLabel = isExpanded ? "Collapse folder" : "Expand folder";

	return (
		<div className={"FilesSidebarTreeItemArrow" satisfies FilesSidebarTreeItemArrow_ClassNames}>
			<MyIconButton
				id={files_sidebar_tree_item_arrow_dom_id(itemId)}
				className={"FilesSidebarTreeItemArrow-icon-button" satisfies FilesSidebarTreeItemArrow_ClassNames}
				tooltip={actionLabel}
				tooltipSide="bottom"
				variant="ghost-highlightable"
				tabIndex={isFocused ? 0 : -1}
				disabled={isPending}
				aria-label={`${actionLabel} ${label}`}
				onClick={onClick}
			>
				<MyIconButtonIcon>{isExpanded ? <ChevronDown /> : <ChevronRight />}</MyIconButtonIcon>
			</MyIconButton>
		</div>
	);
});
// #endregion tree item arrow

// #region tree item title
type FilesSidebarTreeItemTitle_ClassNames = "FilesSidebarTreeItemTitle" | "FilesSidebarTreeItemTitle-input";

type FilesSidebarTreeItemTitle_Props = {
	renameInputProps: ReturnType<FilesSidebarTreeItem_Instance["getRenameInputProps"]>;
	isRenaming: boolean;
	title: string;
	kind: files_TreeItem["kind"];
	renameError: string | undefined;
	onRenameErrorClear: () => void;
};

const FilesSidebarTreeItemTitle = memo(function FilesSidebarTreeItemTitle(props: FilesSidebarTreeItemTitle_Props) {
	const { renameInputProps, isRenaming, title, kind, renameError, onRenameErrorClear } = props;

	const value = isRenaming ? (renameInputProps.value ?? "") : title;
	const renameInputElementRef = useRef<HTMLInputElement | null>(null);

	const handleRenameInputRef = useFn((element: HTMLInputElement | null) => {
		// Keep a local DOM ref for native validity and selection management.
		renameInputElementRef.current = element;
		if (isRenaming) {
			// Forward the same input to Headless Tree only while rename mode owns it.
			forward_ref(element, renameInputProps.ref);
		}
	});

	const clearRenameInputError = useFn((element: HTMLInputElement) => {
		if (!renameError) {
			return;
		}

		// Clear both DOM validity and React tooltip state as soon as the user edits.
		element.setCustomValidity("");
		onRenameErrorClear();
	});

	const handleRenameValueChange = useFn((value: string) => {
		if (!isRenaming) {
			return;
		}

		// Mirror the sanitized value into Headless Tree's controlled renaming state.
		renameInputProps.onChange({ target: { value } });
	});

	const handleRenameInputBlur = useFn<NonNullable<ComponentProps<"input">["onBlur"]>>((event) => {
		if (!isRenaming) {
			return;
		}

		// Remove local invalid state on blur because blur aborts rename instead of submitting the draft.
		event.currentTarget.setCustomValidity("");
		onRenameErrorClear();
		renameInputProps.onBlur();
		dom_clear_text_selection(event.currentTarget);
	});

	useLayoutEffect(() => {
		const inputElement = renameInputElementRef.current;
		if (!inputElement) {
			return;
		}

		// Keep native validity and the explicit visible-invalid class in sync with the app tooltip.
		inputElement.setCustomValidity(isRenaming ? (renameError ?? "") : "");
		return () => {
			inputElement.setCustomValidity("");
		};
	}, [isRenaming, renameError]);

	// Keep the extension outside the initial edit range so ordinary renames preserve the file type.
	useLayoutEffect(() => {
		if (!isRenaming) {
			return;
		}

		const inputElement = renameInputElementRef.current;
		if (!inputElement) {
			return;
		}

		const focusAndSelectInput = () => {
			inputElement.focus();
			files_name_input_select_stem({ element: inputElement, kind });
		};

		focusAndSelectInput();
		// Menus restore focus after closing; refocus once so Rename lands in the input.
		const focusTimeoutId = setTimeout(focusAndSelectInput, 0);
		return () => {
			clearTimeout(focusTimeoutId);
		};
	}, [isRenaming, kind]);

	return (
		<MyTooltip open={isRenaming && Boolean(renameError)} placement="bottom-start">
			{/* Keep the tooltip anchor out of tab order; focus belongs to the treeitem or active rename input. */}
			<MyTooltipTrigger tabIndex={-1}>
				<MyInput
					className={cn(
						"FilesSidebarTreeItemTitle" satisfies FilesSidebarTreeItemTitle_ClassNames,
						isRenaming && renameError && "userInvalid",
					)}
					variant="transparent"
				>
					<MyInputBackground />
					<FilesNameInputControl
						{...(isRenaming ? renameInputProps : null)}
						ref={handleRenameInputRef}
						kind={kind}
						className={"FilesSidebarTreeItemTitle-input" satisfies FilesSidebarTreeItemTitle_ClassNames}
						// Disable the idle input so it cannot receive focus outside rename mode.
						disabled={!isRenaming}
						tabIndex={isRenaming ? undefined : -1}
						value={value}
						// Hide the idle title input; the treeitem owns the accessible row name until rename mode starts.
						{...(isRenaming ? {} : { inert: true })}
						aria-label={isRenaming ? `Rename ${title}` : undefined}
						aria-hidden={isRenaming ? undefined : true}
						onBlur={handleRenameInputBlur}
						onEditStart={clearRenameInputError}
						onValueChange={handleRenameValueChange}
					/>
					<MyInputBox />
				</MyInput>
			</MyTooltipTrigger>
			{renameError ? <MyTooltipContent variant="error">{renameError}</MyTooltipContent> : null}
		</MyTooltip>
	);
});
// #endregion tree item title

// #region tree item primary content
type FilesSidebarTreeItemPrimaryContent_ClassNames = "FilesSidebarTreeItemPrimaryContent";

type FilesSidebarTreeItemPrimaryContent_Props = {
	title: string;
	kind: files_TreeItem["kind"];
	renameInputProps: ReturnType<FilesSidebarTreeItem_Instance["getRenameInputProps"]>;
	isRenaming: boolean;
	isRestricted: boolean;
	renameError: string | undefined;
	onRenameErrorClear: () => void;
};

const FilesSidebarTreeItemPrimaryContent = memo(function FilesSidebarTreeItemPrimaryContent(
	props: FilesSidebarTreeItemPrimaryContent_Props,
) {
	const { title, kind, renameInputProps, isRenaming, isRestricted, renameError, onRenameErrorClear } = props;

	return (
		<div className={"FilesSidebarTreeItemPrimaryContent" satisfies FilesSidebarTreeItemPrimaryContent_ClassNames}>
			<FilesSidebarTreeItemIcon kind={kind} isRestricted={isRestricted} />
			<FilesSidebarTreeItemTitle
				renameInputProps={renameInputProps}
				isRenaming={isRenaming}
				title={title}
				kind={kind}
				renameError={renameError}
				onRenameErrorClear={onRenameErrorClear}
			/>
		</div>
	);
});
// #endregion tree item primary content

// #region tree item primary action
type FilesSidebarTreeItemPrimaryAction_ClassNames =
	| "FilesSidebarTreeItemPrimaryAction"
	| "FilesSidebarTreeItemPrimaryAction-drop-zone-included"
	| "FilesSidebarTreeItemPrimaryAction-surface";

type FilesSidebarTreeItemPrimaryAction_Props = {
	itemProps: ReturnType<FilesSidebarTreeItem_Instance["getProps"]>;
	itemId: string;
	kind: files_TreeItem["kind"];
	updatedAt: files_TreeItem["updatedAt"];
	updatedByDisplayName: string;
	isPending: boolean;
	isSelected: boolean;
	isRestricted: boolean;
	isDropZoneIncluded: boolean;
	isTreeDragging: boolean;
	isFocused: boolean;
	isFallbackTabStop: boolean;
	ariaLabel: string;
};

const FilesSidebarTreeItemPrimaryAction = memo(function FilesSidebarTreeItemPrimaryAction(
	props: FilesSidebarTreeItemPrimaryAction_Props,
) {
	const {
		itemProps,
		itemId,
		kind,
		updatedAt,
		updatedByDisplayName,
		isPending,
		isSelected,
		isRestricted,
		isDropZoneIncluded,
		isTreeDragging,
		isFocused,
		isFallbackTabStop,
		ariaLabel,
	} = props;

	// The sharing mark takes no pointer events, so it cannot host its own tooltip; a restricted row
	// explains itself here instead. The updated-by text stays visible in the row's second line.
	const tooltipContent = isRestricted
		? "Only chosen people and roles can open this"
		: `Updated ${format_relative_time(updatedAt, { prefixForDatesPast7Days: "the " })} by ${updatedByDisplayName}`;

	return (
		<MyPrimaryAction
			{...itemProps}
			// Keep one row Tab-reachable when the focused item is no longer rendered (e.g. archived away).
			{...(isFallbackTabStop ? { tabIndex: 0 } : null)}
			className={cn(
				"FilesSidebarTreeItemPrimaryAction" satisfies FilesSidebarTreeItemPrimaryAction_ClassNames,
				isDropZoneIncluded &&
					("FilesSidebarTreeItemPrimaryAction-drop-zone-included" satisfies FilesSidebarTreeItemPrimaryAction_ClassNames),
			)}
			selected={isSelected}
			disabled={isPending && !isFocused}
			tooltip={tooltipContent}
			tooltipTimeout={2000}
			tooltipDisabled={isTreeDragging}
			data-focused={isFocused || undefined}
			aria-selected={isSelected ? "true" : "false"}
			aria-label={ariaLabel}
			// The expand/collapse button renders as a sibling; own it so it stays associated with this row.
			aria-owns={kind === "folder" ? files_sidebar_tree_item_arrow_dom_id(itemId) : undefined}
			{...({
				"data-file-id": itemId,
			} satisfies Partial<FilesSidebarTreeItem_CustomAttributes>)}
		>
			<span
				className={"FilesSidebarTreeItemPrimaryAction-surface" satisfies FilesSidebarTreeItemPrimaryAction_ClassNames}
				aria-hidden="true"
			/>
		</MyPrimaryAction>
	);
});
// #endregion tree item primary action

// #region tree item secondary content
type FilesSidebarTreeItemSecondaryContent_ClassNames =
	| "FilesSidebarTreeItemSecondaryContent"
	| "FilesSidebarTreeItemSecondaryContent-text"
	| "FilesSidebarTreeItemSecondaryContent-added"
	| "FilesSidebarTreeItemSecondaryContent-processing";

type FilesSidebarTreeItemSecondaryContent_Props = {
	nodeId: app_convex_Id<"files_nodes"> | null;
	secondaryText: string;
	isAddedFile: boolean;
};

const FilesSidebarTreeItemSecondaryContent = memo(function FilesSidebarTreeItemSecondaryContent(
	props: FilesSidebarTreeItemSecondaryContent_Props,
) {
	const { nodeId, secondaryText, isAddedFile } = props;
	const { membershipId } = AppTenantProvider.useContext();

	const activities = useFileNodeActivities({ membershipId, nodeId });
	const isProcessing = activities.some((activity) => activity.status === "running");

	return (
		<div className={"FilesSidebarTreeItemSecondaryContent" satisfies FilesSidebarTreeItemSecondaryContent_ClassNames}>
			<div
				className={
					"FilesSidebarTreeItemSecondaryContent-text" satisfies FilesSidebarTreeItemSecondaryContent_ClassNames
				}
			>
				{secondaryText}
			</div>
			{isAddedFile ? (
				<div
					className={
						"FilesSidebarTreeItemSecondaryContent-added" satisfies FilesSidebarTreeItemSecondaryContent_ClassNames
					}
				>
					Added
				</div>
			) : null}
			{isProcessing ? (
				<div
					className={
						"FilesSidebarTreeItemSecondaryContent-processing" satisfies FilesSidebarTreeItemSecondaryContent_ClassNames
					}
				>
					Processing
				</div>
			) : null}
		</div>
	);
});
// #endregion tree item secondary content

// #region tree item actions
type FilesSidebarTreeItemActions_ClassNames = "FilesSidebarTreeItemActions";

type FilesSidebarTreeItemActions_Props = {
	label: string;
	isPending: boolean;
	isFocused: boolean;
	canCreateChildren: boolean;
	canCreate: boolean;
	onCreateFile: FilesSidebarTreeItemSecondaryAction_Props["onClick"];
	onCreateFolder: FilesSidebarTreeItemSecondaryAction_Props["onClick"];
};

const FilesSidebarTreeItemActions = memo(function FilesSidebarTreeItemActions(
	props: FilesSidebarTreeItemActions_Props,
) {
	const { label, isPending, isFocused, canCreateChildren, canCreate, onCreateFile, onCreateFolder } = props;

	return (
		<div
			className={"FilesSidebarTreeItemActions" satisfies FilesSidebarTreeItemActions_ClassNames}
			role="group"
			aria-label={`Actions for ${label}`}
		>
			{canCreateChildren ? (
				<>
					<FilesSidebarTreeItemSecondaryActionCreateFile
						kind="file"
						label={label}
						isActive={isFocused}
						disabled={isPending || !canCreate}
						onClick={onCreateFile}
					/>
					<FilesSidebarTreeItemSecondaryActionCreateFile
						kind="folder"
						label={label}
						isActive={isFocused}
						disabled={isPending || !canCreate}
						onClick={onCreateFolder}
					/>
				</>
			) : null}
			<FilesSidebarTreeItemMoreAction label={label} isPending={isPending} isFocused={isFocused} />
		</div>
	);
});
// #endregion tree item actions

// #region tree item track
type FilesSidebarTreeItemTrack_ClassNames =
	| "FilesSidebarTreeItemTrack"
	| "FilesSidebarTreeItemTrack-guide"
	| "FilesSidebarTreeItemTrack-guide-depth-zero"
	| "FilesSidebarTreeItemTrack-guide-active"
	| "FilesSidebarTreeItemTrack-guide-terminal"
	| "FilesSidebarTreeItemTrack-guide-hidden";

type FilesSidebarTreeItemTrack_Props = {
	trackFileIds: string[];
	trackActiveFileIds: Set<string>;
	terminalTrackFileId?: string;
	hiddenTrackFileIds?: Set<string>;
};

const FilesSidebarTreeItemTrack = memo(function FilesSidebarTreeItemTrack(props: FilesSidebarTreeItemTrack_Props) {
	const { trackFileIds, trackActiveFileIds, terminalTrackFileId, hiddenTrackFileIds } = props;

	return (
		<div className={"FilesSidebarTreeItemTrack" satisfies FilesSidebarTreeItemTrack_ClassNames} aria-hidden="true">
			{trackFileIds.map((ancestorId, ancestorIndex) => (
				<span
					key={ancestorId}
					className={cn(
						"FilesSidebarTreeItemTrack-guide" satisfies FilesSidebarTreeItemTrack_ClassNames,
						ancestorIndex === 0 &&
							("FilesSidebarTreeItemTrack-guide-depth-zero" satisfies FilesSidebarTreeItemTrack_ClassNames),
						trackActiveFileIds.has(ancestorId) &&
							("FilesSidebarTreeItemTrack-guide-active" satisfies FilesSidebarTreeItemTrack_ClassNames),
						terminalTrackFileId === ancestorId &&
							("FilesSidebarTreeItemTrack-guide-terminal" satisfies FilesSidebarTreeItemTrack_ClassNames),
						hiddenTrackFileIds?.has(ancestorId) &&
							("FilesSidebarTreeItemTrack-guide-hidden" satisfies FilesSidebarTreeItemTrack_ClassNames),
					)}
				/>
			))}
		</div>
	);
});
// #endregion tree item track

// #region tree item placeholder
type FilesSidebarTreeItemPlaceholder_ClassNames = "FilesSidebarTreeItemPlaceholder";

type FilesSidebarTreeItemPlaceholder_CssVars = {
	"--FilesSidebarTreeItemPlaceholder-depth": number;
};

type FilesSidebarTreeItemPlaceholder_Props = {
	itemId: string;
	ancestorIds: string[];
	trackActiveFileIds: Set<string>;
	hiddenTrackFileIds: Set<string>;
	onDragEnter: ComponentProps<"div">["onDragEnter"];
	onDragOver: ComponentProps<"div">["onDragOver"];
	onDragLeave: ComponentProps<"div">["onDragLeave"];
	onDrop: ComponentProps<"div">["onDrop"];
};

const FilesSidebarTreeItemPlaceholder = memo(function FilesSidebarTreeItemPlaceholder(
	props: FilesSidebarTreeItemPlaceholder_Props,
) {
	const { itemId, ancestorIds, trackActiveFileIds, hiddenTrackFileIds, onDragEnter, onDragOver, onDragLeave, onDrop } =
		props;

	const trackFileIds = [...ancestorIds, itemId];
	const placeholderDepth = trackFileIds.length;

	return (
		<div
			className={"FilesSidebarTreeItemPlaceholder" satisfies FilesSidebarTreeItemPlaceholder_ClassNames}
			style={sx({
				"--FilesSidebarTreeItemPlaceholder-depth": placeholderDepth,
			} satisfies Partial<FilesSidebarTreeItemPlaceholder_CssVars>)}
			{...({
				"data-file-id": itemId,
			} satisfies Partial<FilesSidebarTreeItem_CustomAttributes>)}
			onDragEnter={onDragEnter}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			<div
				className={"FilesSidebarTreeItemPrimaryContent" satisfies FilesSidebarTreeItemPrimaryContent_ClassNames}
				aria-hidden="true"
			>
				<FilesSidebarTreeItemIcon kind="folder" />
				<span>No files inside</span>
			</div>
			<FilesSidebarTreeItemTrack
				trackFileIds={trackFileIds}
				trackActiveFileIds={trackActiveFileIds}
				terminalTrackFileId={itemId}
				hiddenTrackFileIds={hiddenTrackFileIds}
			/>
		</div>
	);
});
// #endregion tree item placeholder

// #region tree item
function tree_item_get_hidden_track_file_ids_for_descendants(item?: FilesSidebarTreeItem_Instance) {
	const result = new Set<string>();

	let child = item;
	let parent = child?.getParent();
	while (child && parent && parent.getId() !== files_ROOT_ID) {
		// Hide ancestor guide lines once the branch occupying that depth has already ended.
		if (parent.getChildren().at(-1)?.getId() === child.getId()) {
			result.add(parent.getId());
		}

		child = parent;
		parent = parent.getParent();
	}

	return result;
}

type FilesSidebarTreeItem_ClassNames =
	| "FilesSidebarTreeItem"
	| "FilesSidebarTreeItem-content-navigated"
	| "FilesSidebarTreeItem-content-archived"
	| "FilesSidebarTreeItem-content-renaming"
	| "FilesSidebarTreeItemNavigatedRail";

type FilesSidebar_CssVars = {
	"--FilesSidebarTreeItem-content-depth": number;
};

type FilesSidebarTreeItem_Props = {
	/** Necessary to ensure the item is re-rendered when the tree is updated */
	tree: FilesSidebarTree_Shared;
	item: FilesSidebarTreeItem_Instance;
	displayNameByUserId: Map<string, string>;
	trackActiveFileIds: Set<string>;
	selectedNodeId: string | null;
	isSelected: boolean;
	isSearchActive: boolean;
	isBusy: boolean;
	isDropZoneIncluded: boolean;
	pendingActionNodeIds: Set<string>;
	renameError: string | undefined;
	isTreeDragging: boolean;
	isFallbackTabStop: boolean;
	expandedFolderActionsVisible: boolean;
	onCreateNode: (parentNodeId: string, kind: files_TreeItem["kind"]) => void;
	onStartRename: (itemId: string) => void;
	onRenameErrorClear: (itemId: string) => void;
	onCopy: (nodeId: string) => void;
	onCopyLink: (nodeId: string) => void;
	onCopyNodeId: (nodeId: string) => void;
	onShare: (nodeId: string) => void;
	onArchive: (nodeId: string) => void;
	onUnarchive: (nodeId: string) => void;
};

const FilesSidebarTreeItem = memo(function FilesSidebarTreeItem(props: FilesSidebarTreeItem_Props) {
	const {
		item,
		displayNameByUserId,
		trackActiveFileIds,
		selectedNodeId,
		isSelected,
		isSearchActive,
		isBusy,
		isDropZoneIncluded,
		pendingActionNodeIds,
		renameError,
		isTreeDragging,
		isFallbackTabStop,
		expandedFolderActionsVisible,
		onCreateNode,
		onStartRename,
		onRenameErrorClear,
		onCopy,
		onCopyLink,
		onCopyNodeId,
		onShare,
		onArchive,
		onUnarchive,
	} = props;

	const itemId = useVal(() => item.getId());
	const itemData = useVal(() => item.getItemData());
	const itemProps = useVal(() => item.getProps());

	const renameInputProps = useVal(() => item.getRenameInputProps());
	const isRenaming = useVal(() => item.isRenaming());
	const isArchived = itemData.archiveOperationId !== undefined;
	const isNavigated = selectedNodeId === itemId;
	const isPending = isBusy || pendingActionNodeIds.has(itemId);
	const isFocused = useVal(() => item.isFocused());
	const isExpanded = useVal(() => item.isExpanded());

	const depth = useVal(() => item.getItemMeta().level);

	const hasChildren = useVal(() => item.getChildren().length > 0);

	const canExpandSubtree = useVal(
		() => itemData.kind === "folder" && (!isExpanded || item.getChildren().some((child) => !child.isExpanded())),
	);
	const canCollapseSubtree = useVal(
		() => itemData.kind === "folder" && isExpanded && item.getChildren().some((child) => child.isExpanded()),
	);
	// Only the node that carries the restriction is marked: everything under it would repeat the same
	// thing on every row, and the folder above already says it.
	const isRestricted = files_is_node(itemData) && itemData.restrictedScopeNodeId === itemData._id;

	const ancestorIds = useVal(() => {
		const result: string[] = [];
		let parent = undefined;
		do {
			parent = (parent ?? item).getParent();

			if (parent && parent.getId() !== files_ROOT_ID) {
				result.push(parent.getId());
			}
		} while (parent);

		return result.reverse();
	});
	const terminalTrackFileId = useVal(() => {
		const parent = item.getParent();
		if (!parent || parent.getId() === files_ROOT_ID || parent.getChildren().at(-1)?.getId() !== itemId) {
			return undefined;
		}

		return parent.getId();
	});
	const hiddenTrackFileIds = useVal(() => tree_item_get_hidden_track_file_ids_for_descendants(item.getParent()));

	// While the row menu is open, the row shows as selected so the menu target stays visible.
	const [isMenuOpen, setIsMenuOpen] = useState(false);

	const updatedByDisplayName = displayNameByUserId.get(itemData.updatedBy) ?? "Unknown";
	const metaText = `${format_relative_time(itemData.updatedAt)} · ${updatedByDisplayName}`;
	const shouldRenderPlaceholder = !isSearchActive && itemData.kind === "folder" && !hasChildren && isExpanded;

	// Convex dedupes this subscription across rows; eagerCreated marks files that exist
	// only as this user's pending Added proposal (bash writes, write_file, cp). Computed
	// here so the row's aria label announces the Added state like the archived one.
	const { membershipId } = AppTenantProvider.useContext();
	const pendingUpdates = useQuery(app_convex_api.files_pending_updates.list_files_pending_updates, { membershipId });
	const isAddedFile =
		files_is_node(itemData) &&
		(pendingUpdates ?? []).some(
			(pendingUpdate) => pendingUpdate.fileNodeId === itemId && pendingUpdate.eagerCreated != null,
		);

	// The same server question every write mutation asks first (`authorize_file_write`): may this
	// user write at this node? Anything except `true` keeps the write controls disabled, so nothing
	// here is clickable only to be refused by the backend.
	//
	// Asked in two pieces, because this component is rendered once per visible row and the tree is not
	// virtualized. Args never vary here, so Convex collapses this to a single subscription no matter
	// how large the tree is.
	const workspaceWritePermission = useQuery(app_convex_api.access_control.get_current_user_workspace_permission, {
		membershipId,
		permission: "content.write",
	});
	// Only a node inside a restricted scope needs its own question. Everywhere else the node check
	// answers yes without reading anything (`access_control_db_can_act_on_file_node`) and the workspace
	// answer above is already the whole answer — so asking per row would open one subscription, and
	// about seven document reads, to learn what we just learned once. The synthetic root is the same
	// case: `authorize_file_write` sends it straight to the workspace check.
	//
	// This holds only while nothing writes a `resourceKind: "workspace"` grant. The node check ignores
	// such a grant for a file, the workspace check honours it, so the day one is written this would
	// report writable on unrestricted rows that the server then refuses. No production code writes one
	// today — only a test fixture does — so if you add one, go back to asking per node.
	const restrictedScopeNodeId = files_is_node(itemData) ? itemData.restrictedScopeNodeId : undefined;
	const nodeWritePermission = useQuery(
		app_convex_api.files_nodes.get_current_user_file_write_permission,
		restrictedScopeNodeId ? { membershipId, nodeId: itemId as app_convex_Id<"files_nodes"> } : "skip",
	);
	const canWrite = (restrictedScopeNodeId ? nodeWritePermission : workspaceWritePermission) === true;
	const canRename = files_is_node(itemData) && canWrite;
	// The synthetic root is not a real node, so there is nothing to share it with. Not gated on
	// `canWrite`: `get_node_share_state` answers for anybody who may read the node, on purpose, so a
	// reader can see who else can open it. Gating here would only make this disagree with the header
	// button in `file-node-view.tsx`, which opens the same dialog and asks nothing.
	const canShare = files_is_node(itemData);

	const label = `${itemData.name}${isAddedFile ? " added" : ""}${isRestricted ? " restricted" : ""}${isArchived ? " archived" : ""}`;

	const handleCreateFileClick = useFn<FilesSidebarTreeItemSecondaryAction_Props["onClick"]>(() => {
		onCreateNode(itemId, "file");
	});

	const handleCreateFolderClick = useFn<FilesSidebarTreeItemSecondaryAction_Props["onClick"]>(() => {
		onCreateNode(itemId, "folder");
	});

	const handleCopyClick = useFn<FilesSidebarTreeItemMenuPopover_Props["onCopy"]>(() => {
		onCopy(itemId);
	});

	const handleCopyLinkClick = useFn<FilesSidebarTreeItemMenuPopover_Props["onCopyLink"]>(() => {
		onCopyLink(itemId);
	});

	const handleCopyNodeIdClick = useFn<FilesSidebarTreeItemMenuPopover_Props["onCopyNodeId"]>(() => {
		onCopyNodeId(itemId);
	});

	const handleRenameClick = useFn<FilesSidebarTreeItemMenuPopover_Props["onRename"]>(() => {
		onStartRename(itemId);
	});

	const handleShareClick = useFn<FilesSidebarTreeItemMenuPopover_Props["onShare"]>(() => {
		onShare(itemId);
	});

	const handleRenameErrorClear = useFn(() => {
		onRenameErrorClear(itemId);
	});

	const handleExpandSubtreeClick = useFn<FilesSidebarTreeItemMenuPopover_Props["onExpandSubtree"]>(() => {
		item.expand();
		// Expand only the immediate children of the item
		Promise.try(() => item.getTree().loadChildrenIds(itemId))
			.then(() => {
				for (const child of item.getChildren()) {
					child.expand();
				}
			})
			.catch((error) => {
				console.error("[FilesSidebarTreeItem.handleExpandSubtreeClick] Failed to expand subtree", { error, itemId });
			});
	});

	const handleCollapseSubtreeClick = useFn<FilesSidebarTreeItemMenuPopover_Props["onCollapseSubtree"]>(() => {
		// Collapse only the immediate children of the item
		Promise.try(() => item.getTree().loadChildrenIds(itemId))
			.then(() => {
				for (const child of item.getChildren()) {
					child.collapse();
				}
			})
			.catch((error) => {
				console.error("[FilesSidebarTreeItem.handleCollapseSubtreeClick] Failed to collapse subtree", {
					error,
					itemId,
				});
			});
	});

	const handleArchiveClick = useFn<FilesSidebarTreeItemMenuPopover_Props["onArchive"]>(() => {
		onArchive(itemId);
	});

	const handleUnarchiveClick = useFn<FilesSidebarTreeItemMenuPopover_Props["onUnarchive"]>(() => {
		onUnarchive(itemId);
	});

	const handleRowContextMenu = useFn<MyContextMenuTrigger_Props["onContextMenu"]>((event) => {
		if (event.shiftKey) {
			// Native browser menu.
			return;
		}

		item.setFocused();
	});

	const handleTreeItemArrowClick = useFn<FilesSidebarTreeItemArrow_Props["onClick"]>(() => {
		if (isExpanded) {
			item.collapse();
		} else {
			item.expand();
		}
	});

	const handlePlaceholderDragEnter = useFn<ComponentProps<"div">["onDragEnter"]>((event) => {
		itemProps.onDragEnter?.(event);
	});

	const handlePlaceholderDragOver = useFn<ComponentProps<"div">["onDragOver"]>((event) => {
		itemProps.onDragOver?.(event);
	});

	const handlePlaceholderDragLeave = useFn<ComponentProps<"div">["onDragLeave"]>((event) => {
		itemProps.onDragLeave?.(event);
	});

	const handlePlaceholderDrop = useFn<ComponentProps<"div">["onDrop"]>((event) => {
		itemProps.onDrop?.(event);
	});

	return (
		<>
			<MyContextMenu setOpen={setIsMenuOpen}>
				<MyContextMenuTrigger onContextMenu={handleRowContextMenu}>
					<div
						className={cn(
							"FilesSidebarTreeItem" satisfies FilesSidebarTreeItem_ClassNames,
							isNavigated && ("FilesSidebarTreeItem-content-navigated" satisfies FilesSidebarTreeItem_ClassNames),
							isArchived && ("FilesSidebarTreeItem-content-archived" satisfies FilesSidebarTreeItem_ClassNames),
							isRenaming && ("FilesSidebarTreeItem-content-renaming" satisfies FilesSidebarTreeItem_ClassNames),
						)}
						style={sx({
							"--FilesSidebarTreeItem-content-depth": depth,
						} satisfies Partial<FilesSidebar_CssVars>)}
						{...({
							"data-files-sidebar-tree-context": "",
							"data-file-id": itemId,
						} satisfies Partial<CustomAttributes & FilesSidebarTreeItem_CustomAttributes>)}
					>
						<FilesSidebarTreeItemPrimaryAction
							itemProps={itemProps}
							itemId={itemId}
							kind={itemData.kind}
							updatedAt={itemData.updatedAt}
							updatedByDisplayName={updatedByDisplayName}
							isPending={isPending}
							isSelected={isSelected || isMenuOpen}
							isRestricted={isRestricted}
							isDropZoneIncluded={isDropZoneIncluded}
							isTreeDragging={isTreeDragging}
							isFocused={isFocused}
							isFallbackTabStop={isFallbackTabStop}
							ariaLabel={label}
						/>

						<FilesSidebarTreeItemTrack
							trackFileIds={ancestorIds}
							trackActiveFileIds={trackActiveFileIds}
							terminalTrackFileId={terminalTrackFileId}
							hiddenTrackFileIds={hiddenTrackFileIds}
						/>

						<FilesSidebarTreeItemPrimaryContent
							title={itemData.name}
							kind={itemData.kind}
							renameInputProps={renameInputProps}
							isRenaming={isRenaming}
							isRestricted={isRestricted}
							renameError={renameError}
							onRenameErrorClear={handleRenameErrorClear}
						/>

						{itemData.kind === "folder" ? (
							<FilesSidebarTreeItemArrow
								itemId={itemId}
								label={label}
								isExpanded={isExpanded}
								isPending={isPending}
								isFocused={isFocused}
								onClick={handleTreeItemArrowClick}
							/>
						) : (
							<div
								className={"FilesSidebarTreeItemArrow" satisfies FilesSidebarTreeItemArrow_ClassNames}
								aria-hidden="true"
							/>
						)}

						<FilesSidebarTreeItemSecondaryContent
							nodeId={files_is_node(itemData) ? (itemId as app_convex_Id<"files_nodes">) : null}
							secondaryText={metaText}
							isAddedFile={isAddedFile}
						/>

						<FilesSidebarTreeItemActions
							label={label}
							isPending={isPending}
							isFocused={isFocused}
							canCreateChildren={itemData.kind === "folder"}
							canCreate={canWrite}
							onCreateFile={handleCreateFileClick}
							onCreateFolder={handleCreateFolderClick}
						/>

						{isNavigated ? (
							<div
								className={"FilesSidebarTreeItemNavigatedRail" satisfies FilesSidebarTreeItem_ClassNames}
								aria-hidden="true"
							/>
						) : null}
					</div>
				</MyContextMenuTrigger>

				<FilesSidebarTreeItemMenuPopover
					kind={itemData.kind}
					label={label}
					archiveOperationId={itemData.archiveOperationId}
					canCreate={canWrite}
					canRename={canRename}
					canShare={canShare}
					canArchive={canWrite}
					canExpandSubtree={canExpandSubtree}
					canCollapseSubtree={canCollapseSubtree}
					expandedFolderActionsVisible={expandedFolderActionsVisible}
					onCreateFile={handleCreateFileClick}
					onCreateFolder={handleCreateFolderClick}
					onCopy={handleCopyClick}
					onCopyLink={handleCopyLinkClick}
					onCopyNodeId={handleCopyNodeIdClick}
					onRename={handleRenameClick}
					onShare={handleShareClick}
					onExpandSubtree={handleExpandSubtreeClick}
					onCollapseSubtree={handleCollapseSubtreeClick}
					onArchive={handleArchiveClick}
					onUnarchive={handleUnarchiveClick}
				/>
			</MyContextMenu>

			{shouldRenderPlaceholder ? (
				<FilesSidebarTreeItemPlaceholder
					itemId={itemId}
					ancestorIds={ancestorIds}
					trackActiveFileIds={trackActiveFileIds}
					hiddenTrackFileIds={hiddenTrackFileIds}
					onDragEnter={handlePlaceholderDragEnter}
					onDragOver={handlePlaceholderDragOver}
					onDragLeave={handlePlaceholderDragLeave}
					onDrop={handlePlaceholderDrop}
				/>
			) : null}
		</>
	);
});
// #endregion tree item

// #region tree drop zone area
type FilesSidebarTreeDropZoneArea_ClassNames =
	| "FilesSidebarTreeDropZoneArea"
	| "FilesSidebarTreeDropZoneArea-root"
	| "FilesSidebarTreeDropZoneArea-folder";

type FilesSidebarTreeDropZoneArea_CssVars = {
	"--FilesSidebarTreeDropZoneArea-top": string;
	"--FilesSidebarTreeDropZoneArea-height": string;
};

type FilesSidebarTreeDropZoneArea_Props = {
	dropZone: DropZone;
};

const FilesSidebarTreeDropZoneArea = memo(function FilesSidebarTreeDropZoneArea(
	props: FilesSidebarTreeDropZoneArea_Props,
) {
	const { dropZone } = props;

	return (
		<div
			className={cn(
				"FilesSidebarTreeDropZoneArea" satisfies FilesSidebarTreeDropZoneArea_ClassNames,
				dropZone.kind === "root" &&
					("FilesSidebarTreeDropZoneArea-root" satisfies FilesSidebarTreeDropZoneArea_ClassNames),
				dropZone.kind === "folder" &&
					("FilesSidebarTreeDropZoneArea-folder" satisfies FilesSidebarTreeDropZoneArea_ClassNames),
			)}
			style={
				dropZone.kind === "folder"
					? sx({
							"--FilesSidebarTreeDropZoneArea-top": dropZone.top,
							"--FilesSidebarTreeDropZoneArea-height": dropZone.height,
						} satisfies Partial<FilesSidebarTreeDropZoneArea_CssVars>)
					: undefined
			}
			aria-hidden="true"
		/>
	);
});
// #endregion tree drop zone area

// #region tree drop zone indicator
type FilesSidebarTreeDropZoneIndicator_ClassNames =
	| "FilesSidebarTreeDropZoneIndicator"
	| "FilesSidebarTreeDropZoneIndicator-label"
	| "FilesSidebarTreeDropZoneIndicator-icon";

type FilesSidebarTreeDropZoneIndicator_Props = {
	kind: DropZone["kind"];
};

const FilesSidebarTreeDropZoneIndicator = memo(function FilesSidebarTreeDropZoneIndicator(
	props: FilesSidebarTreeDropZoneIndicator_Props,
) {
	const { kind } = props;
	const label = kind === "root" ? "Drop at root" : "Drop into folder";

	return (
		<div
			className={"FilesSidebarTreeDropZoneIndicator" satisfies FilesSidebarTreeDropZoneIndicator_ClassNames}
			aria-hidden="true"
		>
			<div className={"FilesSidebarTreeDropZoneIndicator-label" satisfies FilesSidebarTreeDropZoneIndicator_ClassNames}>
				<MyIcon
					className={"FilesSidebarTreeDropZoneIndicator-icon" satisfies FilesSidebarTreeDropZoneIndicator_ClassNames}
				>
					<Upload />
				</MyIcon>
				<span>{label}</span>
			</div>
		</div>
	);
});
// #endregion tree drop zone indicator

// #region tree
function get_tree_drop_zone(args: {
	rows: DropZoneRow[];
	activeDropTargetId: string | null;
	isDraggingOverRootZone: boolean;
}) {
	if (args.isDraggingOverRootZone || args.activeDropTargetId === files_ROOT_ID) {
		return { kind: "root" } satisfies DropZone;
	}

	if (!args.activeDropTargetId) {
		return undefined;
	}

	// Count rendered placeholder rows too so the dotted subtree range matches the visible tree.
	const rowModels: {
		row: DropZoneRow;
		itemRowIndex: number;
		placeholderRowIndex: number | undefined;
	}[] = [];
	let rowIndex = 0;
	let activeItemIndex = -1;

	for (let itemIndex = 0; itemIndex < args.rows.length; itemIndex++) {
		const row = args.rows[itemIndex]!;
		const itemRowIndex = rowIndex;

		rowModels.push({
			row,
			itemRowIndex,
			placeholderRowIndex: row.hasPlaceholderRow ? itemRowIndex + 1 : undefined,
		});

		if (row.id === args.activeDropTargetId) {
			activeItemIndex = itemIndex;
		}

		rowIndex += row.hasPlaceholderRow ? 2 : 1;
	}

	const activeItemRowModel = rowModels[activeItemIndex];
	if (!activeItemRowModel || activeItemRowModel.row.kind !== "folder") {
		return undefined;
	}

	const startRowIndex = activeItemRowModel.itemRowIndex;
	let endRowIndex = activeItemRowModel.placeholderRowIndex ?? activeItemRowModel.itemRowIndex;

	// Keep the folder target as the whole visible subtree; collapsed descendants are represented by the folder row.
	for (const rowModel of rowModels.slice(activeItemIndex + 1)) {
		if (rowModel.row.depth <= activeItemRowModel.row.depth) {
			break;
		}

		endRowIndex = rowModel.placeholderRowIndex ?? rowModel.itemRowIndex;
	}

	return {
		kind: "folder",
		top: `${startRowIndex * ROW_HEIGHT_PX}px`,
		height: `${(endRowIndex - startRowIndex + 1) * ROW_HEIGHT_PX}px`,
	} satisfies DropZone;
}

function get_tree_drop_zone_item_ids(args: {
	rows: DropZoneRow[];
	activeDropTargetId: string | null;
	isDraggingOverRootZone: boolean;
}) {
	if (args.isDraggingOverRootZone || args.activeDropTargetId === files_ROOT_ID) {
		return new Set(args.rows.map((row) => row.id));
	}

	if (!args.activeDropTargetId) {
		return new Set<string>();
	}

	const activeItemIndex = args.rows.findIndex((row) => row.id === args.activeDropTargetId);
	const activeRow = args.rows[activeItemIndex];
	if (!activeRow || activeRow.kind !== "folder") {
		return new Set<string>();
	}

	const itemIds = new Set<string>([activeRow.id]);
	for (const row of args.rows.slice(activeItemIndex + 1)) {
		if (row.depth <= activeRow.depth) {
			break;
		}

		itemIds.add(row.id);
	}

	return itemIds;
}

function get_tree_drag_hover_state(args: {
	rows: DropZoneRow[];
	hasDraggedItems: boolean;
	isFileDrag: boolean;
	isExternalFileDrag: boolean;
	isPointerOverTreeItem: boolean;
	hoveredItemId: string | null;
}) {
	// Keep the tri-state explicit: undefined delegates to Headless Tree, null suppresses stale invalid targets.
	if (!args.hasDraggedItems && !args.isExternalFileDrag) {
		return {
			isDraggingOverRootZone: false,
			activeExternalFileDropTargetId: args.isFileDrag ? null : undefined,
		};
	}

	if (!args.isPointerOverTreeItem) {
		return {
			isDraggingOverRootZone: true,
			activeExternalFileDropTargetId: args.isExternalFileDrag ? null : undefined,
		};
	}

	if (!args.isExternalFileDrag) {
		return {
			isDraggingOverRootZone: false,
			activeExternalFileDropTargetId: undefined,
		};
	}

	const hoveredRow = args.rows.find((row) => row.id === args.hoveredItemId);
	if (!hoveredRow) {
		return {
			isDraggingOverRootZone: false,
			activeExternalFileDropTargetId: null,
		};
	}

	// File rows resolve to their containing folder so drops never dead-end on a file.
	const targetId = hoveredRow.kind === "folder" ? hoveredRow.id : hoveredRow.parentId;
	return {
		isDraggingOverRootZone: targetId === files_ROOT_ID,
		activeExternalFileDropTargetId: targetId === files_ROOT_ID ? null : targetId,
	};
}

const FilesSidebarTree_COMPACT_ACTIONS_MAX_WIDTH = 300;

type FilesSidebarTree_ClassNames =
	| "FilesSidebarTree"
	| "FilesSidebarTree-dragging"
	| "FilesSidebarTree-empty-state"
	| "FilesSidebarTree-folder-actions-expanded";

type FilesSidebarTree_Props = {
	tree: FilesSidebarTree_Shared;
	isTreeLoading: boolean;
	showEmptyState: boolean;
	isSearchActive: boolean;
	displayNameByUserId: Map<string, string>;
	trackActiveFileIds: Set<string>;
	selectedNodeId: string | null;
	selectedNodeIds: Set<string>;
	isBusy: boolean;
	isUploadingFile: boolean;
	pendingActionNodeIds: Set<string>;
	renameErrorByNodeId: Map<string, string>;
	onCreateNode: (parentNodeId: string, kind: files_TreeItem["kind"]) => void;
	onStartRename: (itemId: string) => void;
	onRenameErrorClear: (itemId: string) => void;
	onCopy: (nodeId: string) => void;
	onCopyLink: (nodeId: string) => void;
	onCopyNodeId: (nodeId: string) => void;
	onShare: (nodeId: string) => void;
	onArchive: (nodeId: string) => void;
	onUnarchive: (nodeId: string) => void;
};

type FilesSidebarTree_DivProps = ComponentProps<"div">;

const FilesSidebarTree = memo(function FilesSidebarTree(props: FilesSidebarTree_Props) {
	const {
		tree,
		isTreeLoading,
		showEmptyState,
		isSearchActive,
		displayNameByUserId,
		trackActiveFileIds,
		selectedNodeId,
		selectedNodeIds,
		isBusy,
		isUploadingFile,
		pendingActionNodeIds,
		renameErrorByNodeId,
		onCreateNode,
		onStartRename,
		onRenameErrorClear,
		onCopy,
		onCopyLink,
		onCopyNodeId,
		onShare,
		onArchive,
		onUnarchive,
	} = props;

	const treeContainerProps = tree().getContainerProps("Files");
	const { ref: treeContainerRef, ...treeContainerRest } = treeContainerProps;

	const [expandedFolderActionsVisible, setExpandedFolderActionsVisible] = useState(false);

	const isTreeDragging = (tree().getState().dnd?.draggedItems?.length ?? 0) > 0;
	const renderedTreeItems = tree().getItems();
	// When the focused item is no longer rendered (e.g. archived away), no row keeps tabIndex 0
	// and the tree drops out of the Tab order; fall back to the first row as the tab stop.
	const hasFocusedRenderedItem = renderedTreeItems.some((item) => item.isFocused());

	const treeRootElementRef = useRef<HTMLDivElement | null>(null);
	const treeRootResizeObserverRef = useRef<ResizeObserver | null>(null);

	const [isDraggingOverRootZone, setIsDraggingOverRootZone] = useState(false);
	const isDraggingOverRootZoneRef = useRef(false);
	// Use undefined to fall back to Headless Tree, and null to suppress stale targets while drops are blocked.
	const [activeExternalFileDropTargetId, setActiveExternalFileDropTargetId] = useState<string | null | undefined>(
		undefined,
	);

	const activeExternalFileDropTargetIdRef = useRef<string | null | undefined>(undefined);
	// Use the resolved drag target (not the hovered item) so file hovers highlight their containing folder.
	const headlessActiveDropTargetId = tree().getState().dnd?.dragTarget?.item.getId() ?? null;
	const activeDropTargetId =
		activeExternalFileDropTargetId === undefined ? headlessActiveDropTargetId : activeExternalFileDropTargetId;
	const dropZoneRows = renderedTreeItems.map((item) => {
		const itemData = item.getItemData();

		return {
			id: item.getId(),
			parentId: item.getParent()?.getId() ?? files_ROOT_ID,
			kind: itemData.kind,
			depth: item.getItemMeta().level,
			hasPlaceholderRow:
				!isSearchActive && itemData.kind === "folder" && item.getChildren().length === 0 && item.isExpanded(),
		} satisfies DropZoneRow;
	});

	const dropZone = get_tree_drop_zone({
		rows: dropZoneRows,
		activeDropTargetId,
		isDraggingOverRootZone,
	});
	const dropZoneItemIds = get_tree_drop_zone_item_ids({
		rows: dropZoneRows,
		activeDropTargetId,
		isDraggingOverRootZone,
	});

	const handleSetIsDraggingOverRootZone = (nextValue: FilesSidebarTree_Props["isBusy"]) => {
		if (isDraggingOverRootZoneRef.current === nextValue) {
			return;
		}

		isDraggingOverRootZoneRef.current = nextValue;
		setIsDraggingOverRootZone(nextValue);
	};

	const handleSetActiveExternalFileDropTargetId = (nextValue: string | null | undefined) => {
		if (activeExternalFileDropTargetIdRef.current === nextValue) {
			return;
		}

		activeExternalFileDropTargetIdRef.current = nextValue;
		setActiveExternalFileDropTargetId(nextValue);
	};

	const handleUpdateRootZoneFromDragEvent: NonNullable<FilesSidebarTree_DivProps["onDragOverCapture"]> = (event) => {
		const draggedItems = tree().getState().dnd?.draggedItems ?? [];
		const isFileDrag = has_file_drop(event.dataTransfer);
		const isExternalFileDrag = !isBusy && !isUploadingFile && isFileDrag;
		const hoveredItemElement =
			event.target instanceof Element
				? event.target.closest(".FilesSidebarTreeItem, .FilesSidebarTreeItemPlaceholder")
				: null;
		const treeRootElement = event.currentTarget;
		const isPointerOverTreeItem = hoveredItemElement instanceof Element && treeRootElement.contains(hoveredItemElement);
		const dragHoverState = get_tree_drag_hover_state({
			rows: dropZoneRows,
			hasDraggedItems: draggedItems.length > 0,
			isFileDrag,
			isExternalFileDrag,
			isPointerOverTreeItem,
			hoveredItemId:
				hoveredItemElement instanceof Element
					? hoveredItemElement.getAttribute("data-file-id" satisfies keyof FilesSidebarTreeItem_CustomAttributes)
					: null,
		});

		handleSetIsDraggingOverRootZone(dragHoverState.isDraggingOverRootZone);
		handleSetActiveExternalFileDropTargetId(dragHoverState.activeExternalFileDropTargetId);
	};

	const handleDragEnterCapture: NonNullable<FilesSidebarTree_DivProps["onDragEnterCapture"]> = (event) => {
		handleUpdateRootZoneFromDragEvent(event);
	};

	const handleDragOverCapture: NonNullable<FilesSidebarTree_DivProps["onDragOverCapture"]> = (event) => {
		handleUpdateRootZoneFromDragEvent(event);
	};

	const handleDragLeaveCapture: NonNullable<FilesSidebarTree_DivProps["onDragLeaveCapture"]> = (event) => {
		const nextHoveredElement = event.relatedTarget;
		if (nextHoveredElement instanceof Node && event.currentTarget.contains(nextHoveredElement)) {
			return;
		}

		handleSetIsDraggingOverRootZone(false);
		handleSetActiveExternalFileDropTargetId(undefined);
	};

	const handleDragEndCapture = () => {
		handleSetIsDraggingOverRootZone(false);
		handleSetActiveExternalFileDropTargetId(undefined);
	};

	const handleDropCapture = () => {
		handleSetIsDraggingOverRootZone(false);
		handleSetActiveExternalFileDropTargetId(undefined);
	};

	const handleTreeRootRef = useFn((element: HTMLDivElement | null) => {
		forward_ref(element, treeContainerRef);
		if (treeRootElementRef.current === element) {
			return;
		}

		treeRootResizeObserverRef.current?.disconnect();
		treeRootResizeObserverRef.current = null;
		treeRootElementRef.current = element;

		if (!element) {
			setExpandedFolderActionsVisible(false);
			return;
		}

		const updateExpandedFolderActionsVisible = () => {
			setExpandedFolderActionsVisible(element.clientWidth < FilesSidebarTree_COMPACT_ACTIONS_MAX_WIDTH);
		};
		updateExpandedFolderActionsVisible();

		const resizeObserver = new ResizeObserver(updateExpandedFolderActionsVisible);
		resizeObserver.observe(element);
		treeRootResizeObserverRef.current = resizeObserver;
	});

	useEffect(() => {
		if (isTreeDragging) {
			return;
		}

		handleSetIsDraggingOverRootZone(false);
	}, [isTreeDragging]);

	return (
		<div
			ref={handleTreeRootRef}
			className={cn(
				"FilesSidebarTree" satisfies FilesSidebarTree_ClassNames,
				isTreeDragging && ("FilesSidebarTree-dragging" satisfies FilesSidebarTree_ClassNames),
				expandedFolderActionsVisible &&
					("FilesSidebarTree-folder-actions-expanded" satisfies FilesSidebarTree_ClassNames),
			)}
			{...treeContainerRest}
			style={treeContainerProps.style}
			onDragEnterCapture={handleDragEnterCapture}
			onDragOverCapture={handleDragOverCapture}
			onDragLeaveCapture={handleDragLeaveCapture}
			onDragEndCapture={handleDragEndCapture}
			onDropCapture={handleDropCapture}
		>
			<AssistiveTreeDescription tree={tree()} />
			{isTreeLoading ? (
				<div className={cn("FilesSidebarTree-empty-state" satisfies FilesSidebarTree_ClassNames)}>Loading files...</div>
			) : (
				<>
					{showEmptyState ? (
						<div className={cn("FilesSidebarTree-empty-state" satisfies FilesSidebarTree_ClassNames)}>
							{isSearchActive ? "No files match your search." : "No files yet."}
						</div>
					) : null}
					{renderedTreeItems.map((item, itemIndex) => {
						const itemId = item.getId();
						return (
							<FilesSidebarTreeItem
								key={itemId}
								tree={tree}
								item={item}
								displayNameByUserId={displayNameByUserId}
								trackActiveFileIds={trackActiveFileIds}
								selectedNodeId={selectedNodeId}
								isSelected={selectedNodeIds.has(itemId)}
								isDropZoneIncluded={dropZoneItemIds.has(itemId)}
								isSearchActive={isSearchActive}
								isBusy={isBusy}
								pendingActionNodeIds={pendingActionNodeIds}
								renameError={renameErrorByNodeId.get(itemId)}
								isTreeDragging={isTreeDragging}
								isFallbackTabStop={!hasFocusedRenderedItem && itemIndex === 0}
								expandedFolderActionsVisible={expandedFolderActionsVisible}
								onCreateNode={onCreateNode}
								onStartRename={onStartRename}
								onRenameErrorClear={onRenameErrorClear}
								onCopy={onCopy}
								onCopyLink={onCopyLink}
								onCopyNodeId={onCopyNodeId}
								onShare={onShare}
								onArchive={onArchive}
								onUnarchive={onUnarchive}
							/>
						);
					})}
				</>
			)}
			{dropZone ? (
				<>
					<FilesSidebarTreeDropZoneArea dropZone={dropZone} />
					<FilesSidebarTreeDropZoneIndicator kind={dropZone.kind} />
				</>
			) : null}
		</div>
	);
});
// #endregion tree

// #region search
type FilesSidebarSearch_ClassNames = "FilesSidebarSearch";

type FilesSidebarSearch_Props = {
	initialQuery: string;
	onSearchQueryChange: (searchQuery: string) => void;
	onSubmit: (searchQuery: string) => void;
};

const FilesSidebarSearch = memo(function FilesSidebarSearch(props: FilesSidebarSearch_Props) {
	const { initialQuery, onSearchQueryChange, onSubmit } = props;

	const [searchQuery, setSearchQuery] = useState(initialQuery);
	const searchQueryDebounced = useDebounce(searchQuery, 300);

	const handleInputChange = useFn<ComponentProps<typeof MyInputControl>["onChange"]>((event) => {
		setSearchQuery(event.target.value);
	});

	// Enter opens the one node the query identifies. This is what makes "paste a copied
	// path or link, then press Enter" work as a single motion.
	const handleInputKeyDown = useFn<ComponentProps<typeof MyInputControl>["onKeyDown"]>((event) => {
		if (event.key !== "Enter") {
			return;
		}

		// Pass the live input value, not the debounced one, so a paste followed straight away by
		// Enter acts on what was just pasted.
		onSubmit(searchQuery);
	});

	useEffect(() => {
		onSearchQueryChange(searchQueryDebounced);
	}, [searchQueryDebounced]);

	// `MyInputControl` owns its own generated id for label wiring, so the global id that the
	// Mod+K shortcut looks up lives on the wrapper.
	return (
		<MyInput
			id={"app_files_sidebar_search" satisfies AppElementId}
			className={cn("FilesSidebarSearch" satisfies FilesSidebarSearch_ClassNames)}
		>
			<MyInputBackground />
			<MyInputArea>
				<MyInputIcon>
					<Search />
				</MyInputIcon>
				<MyInputControl
					aria-label="Search files by name, path, id, or link"
					placeholder="Search files"
					value={searchQuery}
					onChange={handleInputChange}
					onKeyDown={handleInputKeyDown}
				/>
			</MyInputArea>
			<MyInputBox />
		</MyInput>
	);
});
// #endregion search

// #region header
type FilesSidebarHeader_ClassNames =
	| "FilesSidebarHeader"
	| "FilesSidebarHeader-top-section-left"
	| "FilesSidebarHeader-hamburger-button"
	| "FilesSidebarHeader-title"
	| "FilesSidebarHeader-close-button";

type FilesSidebarHeader_Props = {
	view: files_EditorView;
	onClose: () => void;
};

const FilesSidebarHeader = memo(function FilesSidebarHeader(props: FilesSidebarHeader_Props) {
	const { view, onClose } = props;

	const { organizationName, workspaceName } = AppTenantProvider.useContext();

	return (
		<MySidebarHeader className={cn("FilesSidebarHeader" satisfies FilesSidebarHeader_ClassNames)}>
			<div className={cn("FilesSidebarHeader-top-section-left" satisfies FilesSidebarHeader_ClassNames)}>
				<MainAppSidebarToggle
					className={"FilesSidebarHeader-hamburger-button" satisfies FilesSidebarHeader_ClassNames}
					variant="ghost-highlightable"
					tooltip="Main Menu"
				/>

				<MyTooltip>
					<MyTooltipTrigger>
						<MyLink
							className={cn("FilesSidebarHeader-title" satisfies FilesSidebarHeader_ClassNames)}
							variant="button-tertiary"
							to="/w/$organizationName/$workspaceName/files"
							params={{ organizationName, workspaceName }}
							// Keep `q`: the sidebar stays mounted with its search box filled, so dropping the
							// param here would leave the URL disagreeing with what the user still sees.
							search={(prev) => ({ ...prev, nodeId: files_ROOT_ID, view })}
						>
							<MySidebarTitle>Files</MySidebarTitle>
						</MyLink>
					</MyTooltipTrigger>
					<MyTooltipContent>Open files root</MyTooltipContent>
				</MyTooltip>
			</div>

			<MyIconButton
				variant="ghost-highlightable"
				onClick={onClose}
				tooltip="Close"
				className={cn("FilesSidebarHeader-close-button" satisfies FilesSidebarHeader_ClassNames)}
			>
				<MyIconButtonIcon>
					<X />
				</MyIconButtonIcon>
			</MyIconButton>
		</MySidebarHeader>
	);
});
// #endregion header

// #region top section more action
type FilesSidebarTopSectionMoreAction_ClassNames = "FilesSidebarTopSectionMoreAction";

type FilesSidebarTopSectionMoreAction_Props = {
	className: string;
	isBusy: boolean;
	isUploadingFile: boolean;
	isMultiSelectionActive: boolean;
	selectedNodeIdsCount: number;
	archivedCount: number;
	showArchived: boolean;
	onArchiveToggleClick: () => void;
	onArchiveSelectionClick: () => void;
	onUploadFileClick: () => void;
	onImportFolderClick: () => void;
};

const FilesSidebarTopSectionMoreAction = memo(function FilesSidebarTopSectionMoreAction(
	props: FilesSidebarTopSectionMoreAction_Props,
) {
	const {
		className,
		isBusy,
		isUploadingFile,
		isMultiSelectionActive,
		selectedNodeIdsCount,
		archivedCount,
		showArchived,
		onArchiveToggleClick,
		onArchiveSelectionClick,
		onUploadFileClick,
		onImportFolderClick,
	} = props;

	const archivedItemsLabel = `${showArchived ? "Hide" : "Show"} ${archivedCount} ${
		archivedCount === 1 ? "item" : "items"
	} archived`;
	const selectedItemsArchiveLabel = `Archive ${selectedNodeIdsCount} selected ${
		selectedNodeIdsCount === 1 ? "item" : "items"
	}`;

	const handleArchiveToggleClick = useFn(() => {
		onArchiveToggleClick();
	});

	const handleArchiveSelectionClick = useFn<MyMenuItem_Props["onClick"]>(() => {
		onArchiveSelectionClick();
	});

	return (
		<MyMenu placement="bottom-end">
			<MyMenuTrigger>
				<MyIconButton
					className={cn(
						"FilesSidebarTopSectionMoreAction" satisfies FilesSidebarTopSectionMoreAction_ClassNames,
						className,
					)}
					variant="ghost-highlightable"
					tooltip="More options"
					disabled={isBusy}
				>
					<MyIconButtonIcon>
						<EllipsisVertical />
					</MyIconButtonIcon>
				</MyIconButton>
			</MyMenuTrigger>
			<MyMenuPopover
				{...({
					"data-files-sidebar-tree-context": "",
				} satisfies Partial<CustomAttributes>)}
				unmountOnHide
			>
				<MyMenuPopoverContent>
					{isMultiSelectionActive ? (
						<MyMenuItem variant="destructive" disabled={isBusy} hideOnClick onClick={handleArchiveSelectionClick}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<Archive />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>{selectedItemsArchiveLabel}</MyMenuItemContentPrimary>
							</MyMenuItemContent>
						</MyMenuItem>
					) : (
						<>
							<MyMenuCheckboxItem
								name="showArchivedFiles"
								checked={showArchived}
								disabled={isBusy || archivedCount === 0}
								onClick={handleArchiveToggleClick}
							>
								<MyMenuItemContent>
									<MyMenuCheckboxItemControl checked={showArchived} disabled={isBusy || archivedCount === 0} />
									<MyMenuItemContentPrimary>{archivedItemsLabel}</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuCheckboxItem>
							<MyMenuItem disabled={isBusy || isUploadingFile} onClick={onUploadFileClick}>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>
										<Upload />
									</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>Upload file</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
							<MyMenuItem disabled={isBusy || isUploadingFile} onClick={onImportFolderClick}>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>
										<FolderUp />
									</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>Import folder</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
						</>
					)}
				</MyMenuPopoverContent>
			</MyMenuPopover>
		</MyMenu>
	);
});
// #endregion top section more action

// #region top section
type FilesSidebarTopSection_ClassNames =
	| "FilesSidebarTopSection"
	| "FilesSidebarTopSection-actions"
	| "FilesSidebarTopSection-actions-group"
	| "FilesSidebarTopSection-actions-icon-button"
	| "FilesSidebarTopSection-multi-selection-counter"
	| "FilesSidebarTopSection-multi-selection-counter-label";

type FilesSidebarTopSection_Props = {
	view: files_EditorView;
	selectedNodeIdsCount: number;
	isBusy: boolean;
	isUploadingFile: boolean;
	canExpandAll: boolean;
	canCollapseAll: boolean;
	treeItemsList: files_TreeItem[] | undefined;
	showArchived: boolean;
	initialSearchQuery: string;
	onClose: () => void;
	onSearchQueryChange: (searchQuery: string) => void;
	onSearchSubmit: (searchQuery: string) => void;
	onExpandTopFilesClick: () => void;
	onCollapseAllClick: () => void;
	onClearSelectionClick: () => void;
	onCreateRootFileClick: () => void;
	onCreateRootFolderClick: () => void;
	onArchiveToggleClick: () => void;
	onArchiveSelectionClick: () => void;
	onUploadFileClick: () => void;
	onImportFolderClick: () => void;
};

const FilesSidebarTopSection = memo(function FilesSidebarTopSection(props: FilesSidebarTopSection_Props) {
	const {
		view,
		selectedNodeIdsCount,
		isBusy,
		isUploadingFile,
		canExpandAll,
		canCollapseAll,
		treeItemsList,
		showArchived,
		initialSearchQuery,
		onClose,
		onSearchQueryChange,
		onSearchSubmit,
		onExpandTopFilesClick,
		onCollapseAllClick,
		onClearSelectionClick,
		onCreateRootFileClick,
		onCreateRootFolderClick,
		onArchiveToggleClick,
		onArchiveSelectionClick,
		onUploadFileClick,
		onImportFolderClick,
	} = props;

	const archivedCount =
		treeItemsList?.filter((item) => files_is_node(item) && item.archiveOperationId !== undefined).length ?? 0;

	return (
		<div className={cn("FilesSidebarTopSection" satisfies FilesSidebarTopSection_ClassNames)}>
			<FilesSidebarHeader view={view} onClose={onClose} />

			<FilesSidebarSearch
				initialQuery={initialSearchQuery}
				onSearchQueryChange={onSearchQueryChange}
				onSubmit={onSearchSubmit}
			/>

			<div
				className={cn("FilesSidebarTopSection-actions" satisfies FilesSidebarTopSection_ClassNames)}
				{...({
					"data-files-sidebar-tree-context": "",
				} satisfies Partial<CustomAttributes>)}
			>
				{selectedNodeIdsCount > 1 ? (
					<div
						className={cn("FilesSidebarTopSection-multi-selection-counter" satisfies FilesSidebarTopSection_ClassNames)}
					>
						<span
							className={cn(
								"FilesSidebarTopSection-multi-selection-counter-label" satisfies FilesSidebarTopSection_ClassNames,
							)}
						>
							{selectedNodeIdsCount} items selected
						</span>
						<div className={cn("FilesSidebarTopSection-actions-group" satisfies FilesSidebarTopSection_ClassNames)}>
							<MyIconButton
								className={cn("FilesSidebarTopSection-actions-icon-button" satisfies FilesSidebarTopSection_ClassNames)}
								variant="ghost-highlightable"
								tooltip="Clear"
								onClick={onClearSelectionClick}
								disabled={isBusy}
							>
								<MyIconButtonIcon>
									<X />
								</MyIconButtonIcon>
							</MyIconButton>
						</div>
					</div>
				) : (
					<div className={cn("FilesSidebarTopSection-actions-group" satisfies FilesSidebarTopSection_ClassNames)}>
						<MyIconButton
							className={cn("FilesSidebarTopSection-actions-icon-button" satisfies FilesSidebarTopSection_ClassNames)}
							variant="ghost-highlightable"
							tooltip="New file"
							onClick={onCreateRootFileClick}
							disabled={isBusy}
						>
							<MyIconButtonIcon>
								<FilePlus />
							</MyIconButtonIcon>
						</MyIconButton>
						<MyIconButton
							className={cn("FilesSidebarTopSection-actions-icon-button" satisfies FilesSidebarTopSection_ClassNames)}
							variant="ghost-highlightable"
							tooltip="New folder"
							onClick={onCreateRootFolderClick}
							disabled={isBusy}
						>
							<MyIconButtonIcon>
								<FolderPlus />
							</MyIconButtonIcon>
						</MyIconButton>
					</div>
				)}

				<div className={cn("FilesSidebarTopSection-actions-group" satisfies FilesSidebarTopSection_ClassNames)}>
					{selectedNodeIdsCount <= 1 ? (
						<>
							<MyIconButton
								className={cn("FilesSidebarTopSection-actions-icon-button" satisfies FilesSidebarTopSection_ClassNames)}
								variant="ghost-highlightable"
								tooltip="Expand root folders"
								onClick={onExpandTopFilesClick}
								disabled={isBusy || !canExpandAll}
							>
								<MyIconButtonIcon>
									<CopyPlus />
								</MyIconButtonIcon>
							</MyIconButton>

							<MyIconButton
								className={cn("FilesSidebarTopSection-actions-icon-button" satisfies FilesSidebarTopSection_ClassNames)}
								variant="ghost-highlightable"
								tooltip="Collapse all"
								onClick={onCollapseAllClick}
								disabled={isBusy || !canCollapseAll}
							>
								<MyIconButtonIcon>
									<CopyMinus />
								</MyIconButtonIcon>
							</MyIconButton>
						</>
					) : null}
					<FilesSidebarTopSectionMoreAction
						className={cn("FilesSidebarTopSection-actions-icon-button" satisfies FilesSidebarTopSection_ClassNames)}
						isBusy={isBusy}
						isUploadingFile={isUploadingFile}
						isMultiSelectionActive={selectedNodeIdsCount > 1}
						selectedNodeIdsCount={selectedNodeIdsCount}
						archivedCount={archivedCount}
						showArchived={showArchived}
						onArchiveToggleClick={onArchiveToggleClick}
						onArchiveSelectionClick={onArchiveSelectionClick}
						onUploadFileClick={onUploadFileClick}
						onImportFolderClick={onImportFolderClick}
					/>
				</div>
			</div>
		</div>
	);
});
// #endregion top section

// #region upload conflict modal
type FilesSidebarUploadDraft = {
	file: File;
	parentId: app_convex_Id<"files_nodes"> | typeof files_ROOT_ID;
	filename: string;
	contentType?: string;
	isMarkdown: boolean;
	reason: "path_conflict" | "missing_extension";
	conflict?: {
		nodeId: app_convex_Id<"files_nodes">;
		kind: files_TreeItem["kind"];
		name: string;
	};
};

type FilesSidebarUploadConflictModal_ClassNames =
	| "FilesSidebarUploadConflictModal"
	| "FilesSidebarUploadConflictModal-body"
	| "FilesSidebarUploadConflictModal-description-filename"
	| "FilesSidebarUploadConflictModal-form"
	| "FilesSidebarUploadConflictModal-helper-row"
	| "FilesSidebarUploadConflictModal-helper-message"
	| "FilesSidebarUploadConflictModal-helper-state-error"
	| "FilesSidebarUploadConflictModal-name-field-state-attention";

type FilesSidebarUploadConflictModal_Props = {
	draft: FilesSidebarUploadDraft | null;
	isUploading: boolean;
	onClose: () => void;
	onRename: (filename: string) => void;
	onReplace: () => void;
};

function get_upload_conflict_modal_state(args: { draft: FilesSidebarUploadDraft | null; filename: string }) {
	const normalizedFilenameResult = args.draft?.isMarkdown
		? files_normalize_markdown_name(args.filename)
		: { _yay: files_normalize_upload_file_name(args.filename) };
	const normalizedFilename = normalizedFilenameResult?._yay ?? "";
	const invalidFilenameMessage =
		normalizedFilenameResult?._nay?.message ??
		(!args.draft?.isMarkdown && !upload_filename_has_real_extension(normalizedFilename)
			? "Uploaded files must include a file extension."
			: undefined);
	const pathConflictMessage =
		args.draft?.reason === "path_conflict" && normalizedFilename === args.draft.filename
			? args.draft.conflict?.kind === "file"
				? "Choose a different filename or replace the existing file."
				: "Choose a different filename."
			: undefined;
	const helperText =
		invalidFilenameMessage ?? pathConflictMessage ?? "This file will be uploaded with the specified filename.";
	const showReplace =
		args.draft?.reason === "path_conflict" &&
		args.draft.conflict?.kind === "file" &&
		normalizedFilename === args.draft.filename;
	const showAttentionState = !invalidFilenameMessage && Boolean(pathConflictMessage);
	const uploadBlockingMessage = invalidFilenameMessage ?? pathConflictMessage;

	return {
		normalizedFilename,
		invalidFilenameMessage,
		pathConflictMessage,
		helperText,
		showReplace,
		showAttentionState,
		uploadBlockingMessage,
	};
}

const FilesSidebarUploadConflictModal = memo(function FilesSidebarUploadConflictModal(
	props: FilesSidebarUploadConflictModal_Props,
) {
	const { draft, isUploading, onClose, onRename, onReplace } = props;
	const [filename, setFilename] = useState("");
	const filenameInputRef = useRef<HTMLInputElement | null>(null);

	useEffect(() => {
		const nextFilename = draft?.filename ?? "";
		setFilename(nextFilename);

		const inputElement = filenameInputRef.current;
		if (!draft || !inputElement) {
			return;
		}

		// Match the tree rename input: keep the extension out of the initial selection
		// so typing replaces only the basename.
		inputElement.value = nextFilename;
		files_name_input_select_stem({ element: inputElement, kind: "file" });
	}, [draft]);

	const {
		normalizedFilename,
		invalidFilenameMessage,
		pathConflictMessage,
		helperText,
		showReplace,
		showAttentionState,
		uploadBlockingMessage,
	} = get_upload_conflict_modal_state({ draft, filename });

	const handleOpenChange = useFn((open: boolean) => {
		if (!open && !isUploading) {
			onClose();
		}
	});

	const handleSubmit = useFn<ComponentProps<"form">["onSubmit"]>((event) => {
		event.preventDefault();
		if (!draft || uploadBlockingMessage || isUploading) {
			return;
		}

		onRename(normalizedFilename);
	});

	if (!draft) {
		return null;
	}

	const title = draft.reason === "path_conflict" ? "File already exists" : "Rename upload";

	return (
		<MyModal open={draft !== null} setOpen={handleOpenChange}>
			<MyModalPopover
				className={"FilesSidebarUploadConflictModal" satisfies FilesSidebarUploadConflictModal_ClassNames}
			>
				<MyModalHeader>
					<MyModalHeading>{title}</MyModalHeading>
					<MyModalDescription>
						{draft.reason === "path_conflict" ? (
							<>
								A {draft.conflict?.kind ?? "file"} named{" "}
								<strong
									className={
										"FilesSidebarUploadConflictModal-description-filename" satisfies FilesSidebarUploadConflictModal_ClassNames
									}
								>
									{draft.conflict?.name ?? draft.filename}
								</strong>{" "}
								already exists.
							</>
						) : (
							"Uploaded files need a real filename extension before they can be created."
						)}
					</MyModalDescription>
				</MyModalHeader>
				<form
					className={"FilesSidebarUploadConflictModal-form" satisfies FilesSidebarUploadConflictModal_ClassNames}
					onSubmit={handleSubmit}
				>
					<div className={"FilesSidebarUploadConflictModal-body" satisfies FilesSidebarUploadConflictModal_ClassNames}>
						<MyInput
							layout="stacked"
							className={cn(
								showAttentionState &&
									("FilesSidebarUploadConflictModal-name-field-state-attention" satisfies FilesSidebarUploadConflictModal_ClassNames),
							)}
							displayValidationMessage={invalidFilenameMessage}
						>
							<MyInputBackground />
							<MyInputArea>
								<FilesNameInputControl
									ref={filenameInputRef}
									kind="file"
									autoFocus
									aria-label="Filename"
									autoComplete="off"
									value={filename}
									disabled={isUploading}
									validationMessage={invalidFilenameMessage}
									onValueChange={setFilename}
								/>
							</MyInputArea>
							<MyInputBox />
							<MyInputHelperText
								className={
									"FilesSidebarUploadConflictModal-helper-row" satisfies FilesSidebarUploadConflictModal_ClassNames
								}
								aria-live="polite"
							>
								<span
									className={cn(
										"FilesSidebarUploadConflictModal-helper-message" satisfies FilesSidebarUploadConflictModal_ClassNames,
										(invalidFilenameMessage || pathConflictMessage) &&
											("FilesSidebarUploadConflictModal-helper-state-error" satisfies FilesSidebarUploadConflictModal_ClassNames),
									)}
								>
									{helperText}
								</span>
							</MyInputHelperText>
						</MyInput>
					</div>
					<MyModalFooter>
						<MyButton type="button" variant="outline" disabled={isUploading} onClick={onClose}>
							Cancel
						</MyButton>
						{showReplace ? (
							<MyButton type="button" variant="destructive" disabled={isUploading} onClick={onReplace}>
								Replace
							</MyButton>
						) : (
							<MyButton type="submit" variant="accent" disabled={Boolean(uploadBlockingMessage) || isUploading}>
								Upload
							</MyButton>
						)}
					</MyModalFooter>
				</form>
				<MyModalCloseTrigger disabled={isUploading} />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion upload conflict modal

// #region import conflict modal
type FilesSidebarImportConflictModal_ClassNames =
	| "FilesSidebarImportConflictModal"
	| "FilesSidebarImportConflictModal-list"
	| "FilesSidebarImportConflictModal-list-item";

type FilesSidebarImportConflictModal_Props = {
	/** The import pauses while this list is non-empty; an empty list renders nothing. */
	conflicts: FilesImportConflict[];
	onReplace: () => void;
	onSkipExisting: () => void;
	onCancel: () => void;
};

const FilesSidebarImportConflictModal = memo(function FilesSidebarImportConflictModal(
	props: FilesSidebarImportConflictModal_Props,
) {
	const { conflicts, onReplace, onSkipExisting, onCancel } = props;

	const handleOpenChange = useFn((open: boolean) => {
		if (!open) {
			onCancel();
		}
	});

	if (conflicts.length === 0) {
		return null;
	}

	return (
		<MyModal open setOpen={handleOpenChange}>
			<MyModalPopover className={"FilesSidebarImportConflictModal" satisfies FilesSidebarImportConflictModal_ClassNames}>
				<MyModalHeader>
					<MyModalHeading>Some files already exist</MyModalHeading>
					<MyModalDescription>
						{conflicts.length === 1
							? "1 path in this import already exists in the destination folder."
							: `${conflicts.length} paths in this import already exist in the destination folder.`}{" "}
						Replacing archives the current files; skipping keeps them and imports the rest.
					</MyModalDescription>
				</MyModalHeader>
				<ul className={"FilesSidebarImportConflictModal-list" satisfies FilesSidebarImportConflictModal_ClassNames}>
					{conflicts.map((conflict) => (
						<li
							key={conflict.relativePath}
							className={"FilesSidebarImportConflictModal-list-item" satisfies FilesSidebarImportConflictModal_ClassNames}
						>
							{conflict.kind === "folder" ? `${conflict.relativePath}/` : conflict.relativePath}
						</li>
					))}
				</ul>
				<MyModalFooter>
					<MyButton type="button" variant="outline" onClick={onCancel}>
						Cancel import
					</MyButton>
					<MyButton type="button" variant="outline" onClick={onSkipExisting}>
						Skip existing
					</MyButton>
					<MyButton type="button" variant="destructive" onClick={onReplace}>
						Replace existing
					</MyButton>
				</MyModalFooter>
				<MyModalCloseTrigger />
			</MyModalPopover>
		</MyModal>
	);
});
// #endregion import conflict modal

// #region root
function has_file_node_drop(dataTransfer: DataTransfer) {
	return Array.from(dataTransfer.types).includes(files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE);
}

function get_file_node_drop_ids(dataTransfer: DataTransfer) {
	return dataTransfer
		.getData(files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE)
		.split("\n")
		.map((fileNodeId) => fileNodeId.trim())
		.filter(Boolean);
}

async function get_dropped_files(dataTransfer: DataTransfer) {
	if (!has_file_drop(dataTransfer)) {
		return Result({ _nay: { name: "nay", message: "Drop a file to upload." } });
	}

	let files: FileWithPath[];
	try {
		const droppedItems = await fromEvent({ dataTransfer, type: "drop" });
		files = droppedItems.filter((item): item is FileWithPath => item instanceof File);
	} catch (error) {
		console.error("[FilesSidebar.getDroppedFiles] Failed to read dropped files", { error });
		return Result({ _nay: { name: "nay", message: "Failed to read dropped files.", cause: error } });
	}

	if (files.length === 0) {
		return Result({ _nay: { name: "nay", message: "Drop a file to upload." } });
	}

	return Result({ _yay: files });
}

function can_receive_file_drop(args: {
	dataTransfer: DataTransfer;
	target: DragTarget<files_TreeItem>;
	isBusy: boolean;
	isUploadingFile: boolean;
}) {
	if (args.isBusy || args.isUploadingFile || !has_file_drop(args.dataTransfer)) {
		return false;
	}

	const targetId = args.target.item.getId();
	const targetData = args.target.item.getItemData();
	return targetId === files_ROOT_ID || targetData.kind === "folder";
}

function can_receive_file_node_drop(args: {
	dataTransfer: DataTransfer;
	target: DragTarget<files_TreeItem>;
	isBusy: boolean;
	isUploadingFile: boolean;
}) {
	if (args.isBusy || args.isUploadingFile || !has_file_node_drop(args.dataTransfer)) {
		return false;
	}

	const targetId = args.target.item.getId();
	const targetData = args.target.item.getItemData();
	return targetId === files_ROOT_ID || targetData.kind === "folder";
}

function get_default_node_name(args: { parentId: string; kind: files_TreeItem["kind"]; treeItems: TreeItems }) {
	const siblingIds = args.treeItems.sortedItemsIdsByParentId.get(args.parentId) ?? [];
	const activeSiblingNames = new Set<string>();

	for (const siblingId of siblingIds) {
		const siblingItem = args.treeItems.itemById.get(siblingId);
		if (!siblingItem || siblingItem._id === files_ROOT_ID) {
			continue;
		}
		if (siblingItem.archiveOperationId !== undefined) {
			continue;
		}

		activeSiblingNames.add(siblingItem.name);
	}

	return files_get_default_node_name({ kind: args.kind, siblingNames: activeSiblingNames });
}

function join_file_node_path(parentPath: string, pathSegment: string) {
	return parentPath === "/" ? `/${pathSegment}` : `${parentPath}/${pathSegment}`;
}

function get_uploaded_file_rename_validation(args: {
	treeItemsList: files_TreeItem[] | undefined;
	nodeIdToIgnore?: app_convex_Id<"files_nodes">;
	parentId: app_convex_Doc<"files_nodes">["parentId"];
	nameOrPath: string;
}) {
	const pathSegments = path_extract_segments_from(args.nameOrPath.trim());
	if (pathSegments.length === 0) {
		return {
			normalizedName: null,
			validationMessage: null,
			cacheValidationMessage: (_message?: string) => {},
		};
	}

	const normalizedPathSegments: string[] = [];
	for (const [index, pathSegment] of pathSegments.entries()) {
		const isLeaf = index === pathSegments.length - 1;
		if (isLeaf) {
			const normalizedFileName = files_normalize_upload_file_name(pathSegment);
			if (!upload_filename_has_real_extension(normalizedFileName)) {
				return {
					normalizedName: null,
					validationMessage: "Uploaded files must include a file extension.",
					cacheValidationMessage: (_message?: string) => {},
				};
			}

			normalizedPathSegments.push(normalizedFileName);
			continue;
		}

		const normalizedFolderName = files_normalize_name("folder", pathSegment);
		if (normalizedFolderName._nay) {
			return {
				normalizedName: null,
				validationMessage: normalizedFolderName._nay.message,
				cacheValidationMessage: (_message?: string) => {},
			};
		}

		normalizedPathSegments.push(normalizedFolderName._yay);
	}

	let currentParentId = args.parentId;
	for (const [index, normalizedName] of normalizedPathSegments.entries()) {
		const isLeaf = index === normalizedPathSegments.length - 1;
		const existingNode = args.treeItemsList?.find((item): item is files_VisibleTreeNode => {
			return (
				files_is_node(item) &&
				item._id !== args.nodeIdToIgnore &&
				item.parentId === currentParentId &&
				item.archiveOperationId === undefined &&
				item.name.trim().toLowerCase() === normalizedName.toLowerCase()
			);
		});
		if (isLeaf) {
			return {
				normalizedName: normalizedPathSegments.join("/"),
				validationMessage: existingNode ? "This file already exists." : null,
				cacheValidationMessage: (_message?: string) => {},
			};
		}

		if (!existingNode || existingNode.kind !== "folder") {
			return {
				normalizedName: normalizedPathSegments.join("/"),
				validationMessage: null,
				cacheValidationMessage: (_message?: string) => {},
			};
		}

		currentParentId = existingNode._id;
	}

	return {
		normalizedName: normalizedPathSegments.join("/"),
		validationMessage: null,
		cacheValidationMessage: (_message?: string) => {},
	};
}

function sort_children(args: { children: string[]; itemById: Map<string, files_TreeItem> }) {
	return [...args.children].sort((a, b) => {
		const itemA = args.itemById.get(a);
		const itemB = args.itemById.get(b);
		if (!itemA || !itemB) {
			return 0;
		}

		if (itemA.kind !== itemB.kind) {
			return itemA.kind === "folder" ? -1 : 1;
		}

		const nameA = itemA.name || "";
		const nameB = itemB.name || "";
		return nameA.localeCompare(nameB, undefined, {
			numeric: true,
			sensitivity: "base",
		});
	});
}

function is_inside_tree_selection_area(target: EventTarget | null) {
	if (!(target instanceof Element)) {
		return false;
	}

	// Tree rows and their menus carry this attribute; interacting inside them keeps the tree selection.
	return Boolean(target.closest(`[${"data-files-sidebar-tree-context" satisfies keyof CustomAttributes}]`));
}

function is_tree_context_menu_open() {
	// An open tree menu means an outside interaction is dismissing it, not leaving the tree.
	return Boolean(
		document.querySelector(
			`.${"MyMenuPopover" satisfies MyMenuPopover_ClassNames}[${"data-files-sidebar-tree-context" satisfies keyof CustomAttributes}]`,
		),
	);
}

function get_tree_items_list_after_optimistic_rename(args: {
	treeItemsList: files_TreeItem[];
	itemId: string;
	normalizedName: string;
	now: number;
}) {
	const renamedItem = args.treeItemsList.find(
		(treeItem): treeItem is files_VisibleTreeNode => files_is_node(treeItem) && treeItem._id === args.itemId,
	);
	if (!renamedItem) {
		return args.treeItemsList;
	}

	const parent = args.treeItemsList.find((candidate) => candidate._id === renamedItem.parentId);

	return args.treeItemsList.map((treeItem) => {
		if (files_is_node(treeItem) && treeItem._id === args.itemId) {
			return {
				...treeItem,
				name: args.normalizedName,
				...(parent ? { path: join_file_node_path(parent.path, args.normalizedName) } : {}),
				updatedAt: args.now,
			};
		}
		return treeItem;
	});
}

type SearchMode = "name" | "path" | "node";

/**
 * Decide what a search query means from its shape.
 *
 * A user pastes whatever they copied: a file name, a copied path, a node id, or a full app
 * link. Reading the shape means they never have to learn a prefix syntax for each case.
 * A pasted link is unwrapped first into the node id or the path it carries.
 */
function parse_search_query(rawQuery: string): { mode: SearchMode; value: string } {
	const query = rawQuery.trim();

	const link = url_parse_file_link(query);
	if (link) {
		return "nodeId" in link ? { mode: "node", value: link.nodeId } : { mode: "path", value: link.path.toLowerCase() };
	}

	// The tree lookup in `files_sidebar_get_search_matches` confirms an id guess.
	if (app_convex_is_id_like(query)) {
		return { mode: "node", value: query };
	}

	if (path_is_path_like(query)) {
		return { mode: "path", value: query.toLowerCase() };
	}

	return { mode: "name", value: query.toLowerCase() };
}

/**
 * Match a search query against the tree.
 *
 * `visibleFileIds` keeps every match plus its ancestor chain so results render as a pruned tree.
 * `topMatchId` is the node Enter opens: the one whose path matched exactly, or the only node
 * that matched at all.
 *
 * This runs on the deferred query for rendering and again on the live input value when the user
 * presses Enter, so a paste followed straight away by Enter cannot act on the previous query.
 */
function get_search_matches(args: { treeItems: TreeItems; searchQuery: string }) {
	const parsedQuery = parse_search_query(args.searchQuery);

	const visibleFileIds = new Set<string>();
	const directMatchIds: string[] = [];
	let exactMatchId: string | null = null;

	for (const item of args.treeItems.list ?? []) {
		if (!args.treeItems.itemById.has(item._id)) {
			continue;
		}

		// Match the field the query shape asked for. Only path and id queries can name one
		// exact node, so only they can set the exact match.
		if (parsedQuery.mode === "node") {
			if (item._id !== parsedQuery.value) {
				continue;
			}

			exactMatchId = item._id;
		} else if (parsedQuery.mode === "path") {
			const itemPath = item.path.toLowerCase();
			if (!itemPath.includes(parsedQuery.value)) {
				continue;
			}

			if (itemPath === parsedQuery.value) {
				exactMatchId = item._id;
			}
		} else if (!item.name.toLowerCase().includes(parsedQuery.value)) {
			continue;
		}

		visibleFileIds.add(item._id);
		directMatchIds.push(item._id);

		// If we are at the root, skip the ancestors step
		if (item._id === files_ROOT_ID) {
			continue;
		}

		// Add all ancestors of a matching item to the visible items set
		let currentParentId = item.parentId;
		while (currentParentId) {
			const parentItem = args.treeItems.itemById.get(currentParentId);
			if (!parentItem || visibleFileIds.has(currentParentId)) {
				break;
			}

			visibleFileIds.add(currentParentId);
			if (parentItem._id === files_ROOT_ID) {
				break;
			}

			currentParentId = parentItem.parentId;
		}
	}

	return {
		visibleFileIds,
		topMatchId: exactMatchId ?? (directMatchIds.length === 1 ? (directMatchIds[0] ?? null) : null),
	};
}

type FilesSidebar_ClassNames = "FilesSidebar" | "FilesSidebar-content";

export type FilesSidebar_Props = {
	selectedNodeId: string | null;
	view: files_EditorView;
	/**
	 * Seeded from the route's `q` param so
	 * the path route's not-found recovery link lands on a filled search.
	 **/
	initialSearchQuery: string;
	onClose: () => void;
	onArchive: (itemId: string) => void;
	onPrimaryAction: (itemId: string, itemType: string) => void;
	onSearchQueryChange: (searchQuery: string) => void;
};

export const FilesSidebar = memo(function FilesSidebar(props: FilesSidebar_Props) {
	const { selectedNodeId, view, initialSearchQuery, onClose, onArchive, onPrimaryAction, onSearchQueryChange } = props;

	const navigate = useNavigate();
	const convex = useConvex();
	const { membershipId, organizationName, workspaceName } = AppTenantProvider.useContext();

	const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
	const searchQueryDeferred = useDeferredValue(searchQuery);
	const isSearchActive = searchQueryDeferred.trim().length > 0;

	const [showArchived, setShowArchived] = useState(false);

	const [isCreatingFile, setIsCreatingFile] = useState(false);
	const [isArchivingSelection, setIsArchivingSelection] = useState(false);
	const [isUploadingSingleFile, setIsUploadingSingleFile] = useState(false);
	const [uploadDraft, setUploadDraft] = useState<FilesSidebarUploadDraft | null>(null);
	const [pendingActionNodeIds, setPendingActionNodeIds] = useState<Set<string>>(new Set());
	const [renamingItem, setRenamingItem] = useState<string | null | undefined>(undefined);
	const [renameErrorByNodeId, setRenameErrorByNodeId] = useState<Map<string, string>>(new Map());
	/** The node whose share dialog is open, or `null` when it is closed. */
	const [shareNodeId, setShareNodeId] = useState<app_convex_Id<"files_nodes"> | null>(null);
	const isImportingFiles = useFilesImportStore((state) => state.phase !== "idle");
	const importConflicts = useFilesImportStore((state) => state.conflicts);
	// One gate for every upload affordance: the single-file PUT or a running folder import.
	const isUploadingFile = isUploadingSingleFile || isImportingFiles;
	const isBusy = isCreatingFile || isArchivingSelection;
	const uploadInputRef = useRef<HTMLInputElement | null>(null);
	const importFolderInputRef = useRef<HTMLInputElement | null>(null);

	const [expandedItems, setExpandedItems] = useState<string[]>([]);
	const canCollapseAll = expandedItems.length > 1;

	const expandedItemsBeforeSearchRef = useRef<Set<string> | null>(null);
	const selectedFilePathAutoExpandedKeyRef = useRef<string | null>(null);

	const treeNodesList = useQuery(app_convex_api.files_nodes.list_tree, {
		membershipId,
	});
	const treeItemsList = useMemo(
		() => (treeNodesList ? files_create_tree_items_list_from_nodes(treeNodesList) : undefined),
		[treeNodesList],
	);

	// Resolve updater ids through shared anagraphic queries; React Compiler memoizes these derived values.
	const updatedByUserIds = ((/* iife */) => {
		const result = new Set<app_convex_Id<"users">>();
		for (const item of treeItemsList ?? []) {
			if (files_is_node(item)) {
				result.add(item.updatedBy);
			}
		}
		return [...result];
	})();

	const updatedByAnagraphicQueryResults = useQueries(
		Object.fromEntries(
			updatedByUserIds.map((userId) => [
				userId,
				{
					query: app_convex_api.users.get_anagraphic,
					args: { userId },
				},
			]),
		),
	);

	const displayNameByUserId = ((/* iife */) => {
		const result = new Map<string, string>();
		for (const userId of updatedByUserIds) {
			const queryResult = updatedByAnagraphicQueryResults[userId];
			if (queryResult === undefined || queryResult instanceof Error || queryResult === null) {
				continue;
			}

			const displayName = queryResult.displayName.trim();
			if (displayName) {
				result.set(userId, displayName);
			}
		}
		return result;
	})();

	// Keep this manual memo: React Compiler otherwise fuses the tree index with `canExpandAll`
	// and rebuilds the full tree whenever `expandedItems` changes.
	const treeItems = useMemo(() => {
		if (!treeItemsList) {
			return undefined;
		}

		const rootItem = treeItemsList.find((item) => item._id === files_ROOT_ID);
		if (!rootItem) {
			return undefined;
		}

		const result = {
			list: treeItemsList,
			itemsIds: new Set<string>([files_ROOT_ID]),
			itemsIdsByParentId: new Map<string, Set<string>>([[files_ROOT_ID, new Set()]]),
			sortedItemsIdsByParentId: new Map<string, string[]>([[files_ROOT_ID, []]]),
			itemById: new Map<string, files_TreeItem>([[files_ROOT_ID, rootItem]]),
		} satisfies TreeItems;

		const shownItemIds = new Set<string>([files_ROOT_ID]);
		for (const item of treeItemsList) {
			if (files_is_node(item) && (item.archiveOperationId === undefined || showArchived)) {
				shownItemIds.add(item._id);
			}
		}

		// Collect all items from the list to the maps
		for (const item of treeItemsList) {
			if (!files_is_node(item) || (item.archiveOperationId !== undefined && !showArchived)) {
				continue;
			}

			// Somebody who was given one folder gets that folder without the open folders above it, so
			// its parent is missing here. Show it at the top instead: filed under a parent that never
			// renders, the folder they were given would be invisible.
			const parentId = shownItemIds.has(item.parentId) ? item.parentId : files_ROOT_ID;

			let siblingsIds = result.itemsIdsByParentId.get(parentId);
			if (!siblingsIds) {
				siblingsIds = new Set();
				result.itemsIdsByParentId.set(parentId, siblingsIds);
			}

			let sortedSiblingsIds = result.sortedItemsIdsByParentId.get(parentId);
			if (!sortedSiblingsIds) {
				sortedSiblingsIds = [];
				result.sortedItemsIdsByParentId.set(parentId, sortedSiblingsIds);
			}

			siblingsIds.add(item._id);
			sortedSiblingsIds.push(item._id);
			result.itemById.set(item._id, item);
			result.itemsIds.add(item._id);
			if (!result.itemsIdsByParentId.has(item._id)) {
				result.itemsIdsByParentId.set(item._id, new Set());
			}
			if (!result.sortedItemsIdsByParentId.has(item._id)) {
				result.sortedItemsIdsByParentId.set(item._id, []);
			}
		}

		// Sort children in `sortedItemsIdsByParentId`
		for (const [itemId, children] of result.sortedItemsIdsByParentId.entries()) {
			if (children.length === 0) {
				continue;
			}

			result.sortedItemsIdsByParentId.set(
				itemId,
				sort_children({
					children,
					itemById: result.itemById,
				}),
			);
		}

		return result;
	}, [treeItemsList, showArchived]);

	const canExpandAll = ((/* iife */) => {
		const topLevelItems = treeItems?.itemsIdsByParentId.get(files_ROOT_ID);

		if (!topLevelItems || topLevelItems.size === 0) {
			return false;
		}

		return topLevelItems.difference(new Set(expandedItems)).size > 0;
	})();

	/**
	 * Filtered item ids from the search query.
	 */
	const visibleFileIds = ((/* iife */) => {
		if (!treeItems || searchQueryDeferred.trim().length === 0) {
			return treeItems?.itemsIds ?? new Set<string>();
		}

		return get_search_matches({ treeItems, searchQuery: searchQueryDeferred }).visibleFileIds;
	})();

	const hasSelectedFileInTree = Boolean(selectedNodeId && visibleFileIds.has(selectedNodeId));

	const markFileAsPending = (nodeId: string) => {
		setPendingActionNodeIds((oldValue) => {
			const nextValue = new Set(oldValue);
			nextValue.add(nodeId);
			return nextValue;
		});
	};

	const unmarkFileAsPending = (nodeId: string) => {
		setPendingActionNodeIds((oldValue) => {
			const nextValue = new Set(oldValue);
			nextValue.delete(nodeId);
			return nextValue;
		});
	};

	const setRenameError = useFn((nodeId: string, message: string) => {
		setRenameErrorByNodeId((oldValue) => {
			const nextValue = new Map(oldValue);
			nextValue.set(nodeId, message);
			return nextValue;
		});
	});

	const clearRenameError = useFn((nodeId: string) => {
		setRenameErrorByNodeId((oldValue) => {
			if (!oldValue.has(nodeId)) {
				return oldValue;
			}

			const nextValue = new Map(oldValue);
			nextValue.delete(nodeId);
			return nextValue;
		});
	});

	const canDrag = useFn<NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["canDrag"]>>((items) => {
		return items.every((item) => files_is_node(item.getItemData()));
	});

	const canDrop = useFn<NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["canDrop"]>>((items, target) => {
		const targetId = target.item.getId();
		const targetData = target.item.getItemData();
		if (targetId !== files_ROOT_ID && targetData.kind !== "folder") {
			return false;
		}

		return items.every((item) => {
			if (!files_is_node(item.getItemData())) {
				return false;
			}
			if (item.getId() === targetId) {
				return false;
			}
			if (target.item.isDescendentOf(item.getId())) {
				return false;
			}
			return true;
		});
	});

	const handleDrop = useFn<NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["onDrop"]>>((items, target) => {
		if (!treeItems) {
			console.error(should_never_happen("[FilesSidebar.handleDrop] missing deps", { treeItems }));
			return;
		}

		const nodeIds = items.map((item) => item.getId());
		const targetParentId = target.item.getId();

		const movedNodeIds = nodeIds.filter((nodeId) => {
			const item = treeItems.itemById.get(nodeId);
			return item && files_is_node(item);
		});
		if (movedNodeIds.length === 0) {
			return;
		}

		return convex
			.mutation(app_convex_api.files_nodes.move_nodes, {
				membershipId,
				itemIds: movedNodeIds.map((itemId) => itemId as app_convex_Id<"files_nodes">),
				targetParentId:
					targetParentId === files_ROOT_ID ? files_ROOT_ID : (targetParentId as app_convex_Id<"files_nodes">),
			})
			.then((result) => {
				if (result._nay) {
					console.error("[FilesSidebar.moveNodesToParent] Failed to move nodes", { result });
					if (result._nay.message === "Permission denied") {
						toast.error("You don't have permission to edit files in this workspace.");
						return;
					}
					toast.error(result._nay.message);
					return;
				}
			})
			.catch((error) => console.error("[FilesSidebar.moveNodesToParent] Error moving nodes", { error }));
	});

	const createUploadNodeAndPut = useFn(
		(args: {
			file: File;
			parentId: app_convex_Id<"files_nodes"> | typeof files_ROOT_ID;
			filename: string;
			contentType?: string;
		}) => {
			setIsUploadingSingleFile(true);
			convex
				.mutation(app_convex_api.files_nodes.create_upload_node, {
					membershipId,
					parentId: args.parentId,
					filename: args.filename,
					contentType: args.contentType,
					size: args.file.size,
				})
				.then(async (created) => {
					if (created._nay) {
						console.error("[FilesSidebar.createUploadNodeAndPut] Failed to create upload node", { created });
						toast.error(created._nay.message ?? "Failed to prepare upload");
						return null;
					}

					setUploadDraft(null);
					const uploadResponse = await fetch(created._yay.url, {
						method: "PUT",
						headers: created._yay.headers,
						body: args.file,
					});
					if (!uploadResponse.ok) {
						console.error("[FilesSidebar.uploadFile] R2 upload failed", {
							status: uploadResponse.status,
							assetId: created._yay.assetId,
							nodeId: created._yay.nodeId,
						});
						toast.error("Upload failed before processing could start.");
						return null;
					}

					toast.success("File uploaded. Processing...");
					return null;
				})
				.catch((error) => {
					console.error("[FilesSidebar.createUploadNodeAndPut] Error uploading file", { error });
					toast.error(error instanceof Error ? error.message : "Failed to upload file");
				})
				.finally(() => {
					setIsUploadingSingleFile(false);
				});
		},
	);

	const uploadFile = useFn(
		(args: {
			file: File;
			parentId: app_convex_Id<"files_nodes"> | typeof files_ROOT_ID;
			filename: string;
			contentType?: string;
			isMarkdown: boolean;
		}) => {
			if (!treeItems) {
				console.error(should_never_happen("[FilesSidebar.uploadFile] missing deps", { treeItems }));
				return;
			}

			if (!args.isMarkdown && !upload_filename_has_real_extension(args.filename)) {
				setUploadDraft({
					file: args.file,
					parentId: args.parentId,
					filename: args.filename,
					contentType: args.contentType,
					isMarkdown: args.isMarkdown,
					reason: "missing_extension",
				});
				return;
			}

			const parentItem = treeItems.itemById.get(args.parentId);
			if (!parentItem || parentItem.kind !== "folder") {
				console.error("[FilesSidebar.uploadFile] Parent folder not found", { parentId: args.parentId });
				toast.error("Parent folder not found");
				return;
			}

			convex
				.query(app_convex_api.files_nodes.get_authorized_by_path, {
					membershipId,
					path: join_file_node_path(parentItem.path, args.filename),
				})
				.then((existingNode) => {
					if (existingNode) {
						setUploadDraft({
							file: args.file,
							parentId: args.parentId,
							filename: args.filename,
							contentType: args.contentType,
							isMarkdown: args.isMarkdown,
							reason: "path_conflict",
							conflict: {
								nodeId: existingNode.nodeId,
								kind: existingNode.kind,
								name: existingNode.name,
							},
						});
						return;
					}

					createUploadNodeAndPut(args);
				})
				.catch((error) => {
					console.error("[FilesSidebar.uploadFile] Failed to check upload path", { error });
					toast.error("Failed to prepare upload");
				});
		},
	);

	const uploadBrowserFile = useFn(
		async (args: { file: File; parentId: app_convex_Id<"files_nodes"> | typeof files_ROOT_ID }) => {
			// Prepare the actual blob before creating the upload node so Convex and
			// R2 store the same byte size and content type the browser uploads.
			const file = await prepare_image_upload_file(args.file);
			if (file !== args.file) {
				toast.info("Image compressed before upload.");
			}

			const contentType = file.type || undefined;
			const isMarkdown = contentType?.startsWith("text/markdown" satisfies files_ContentType) ?? false;
			const filenameResult = isMarkdown
				? files_normalize_markdown_name(file.name)
				: { _yay: files_normalize_upload_file_name(file.name) };
			if (filenameResult._nay) {
				toast.error(filenameResult._nay.message ?? "Invalid file name");
				return;
			}

			uploadFile({
				file,
				parentId: args.parentId,
				filename: filenameResult._yay,
				contentType,
				isMarkdown,
			});
		},
	);

	const importBrowserFiles = useFn(
		(args: { entries: FilesImportEntry[]; parentId: app_convex_Id<"files_nodes"> | typeof files_ROOT_ID }) => {
			if (useFilesImportStore.getState().phase !== "idle") {
				toast.error("Another import is already running.");
				return;
			}
			if (args.entries.length > FILES_IMPORT_MAX_FILES) {
				toast.error(`Imports are limited to ${FILES_IMPORT_MAX_FILES} files.`);
				return;
			}

			run_folder_import({
				convex,
				membershipId,
				parentId: args.parentId,
				entries: args.entries,
			}).catch((error: unknown) => {
				console.error("[FilesSidebar.importBrowserFiles] Unexpected import run error", { error });
			});
		},
	);

	const handleImportConflictReplace = useFn(() => {
		useFilesImportStore.getState().confirmResolver?.("replace");
	});

	const handleImportConflictSkip = useFn(() => {
		useFilesImportStore.getState().confirmResolver?.("skip");
	});

	const handleImportConflictCancel = useFn(() => {
		useFilesImportStore.getState().confirmResolver?.("cancel");
	});

	const canDragForeignDragObjectOver = useFn<
		NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["canDragForeignDragObjectOver"]>
	>((dataTransfer, target) => {
		// Drops on file rows land in their containing folder (Headless Tree resolves the real target on drop),
		// so gate the drag-over on the parent instead of rejecting the file row.
		const effectiveTarget =
			target.item.getItemData().kind === "folder" ? target : { item: target.item.getParent() ?? target.item };
		return (
			can_receive_file_drop({
				dataTransfer,
				target: effectiveTarget,
				isBusy,
				isUploadingFile,
			}) ||
			can_receive_file_node_drop({
				dataTransfer,
				target: effectiveTarget,
				isBusy,
				// A folder import can run for minutes; moving existing nodes conflicts with nothing
				// in it, so only the short single-file upload blocks node moves.
				isUploadingFile: isUploadingSingleFile,
			})
		);
	});

	const canDropForeignDragObject = useFn<
		NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["canDropForeignDragObject"]>
	>((dataTransfer, target) => {
		return (
			can_receive_file_drop({
				dataTransfer,
				target,
				isBusy,
				isUploadingFile,
			}) ||
			can_receive_file_node_drop({
				dataTransfer,
				target,
				isBusy,
				isUploadingFile: isUploadingSingleFile,
			})
		);
	});

	const handleDropForeignDragObject = useFn<
		NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["onDropForeignDragObject"]>
	>(async (dataTransfer, target) => {
		if (
			can_receive_file_node_drop({
				dataTransfer,
				target,
				isBusy,
				isUploadingFile: isUploadingSingleFile,
			})
		) {
			if (!treeItems) {
				console.error(should_never_happen("[FilesSidebar.handleDropForeignDragObject] missing deps", { treeItems }));
				return;
			}

			const targetParentId = target.item.getId();
			const movedFileNodeIds = get_file_node_drop_ids(dataTransfer).filter((fileNodeId) => {
				const fileNode = treeItems.itemById.get(fileNodeId);
				if (!fileNode || !files_is_node(fileNode)) {
					return false;
				}
				if (fileNode._id === targetParentId || fileNode.parentId === targetParentId) {
					return false;
				}
				if (target.item.isDescendentOf(fileNodeId)) {
					return false;
				}
				return true;
			});
			if (movedFileNodeIds.length === 0) {
				return;
			}

			return convex
				.mutation(app_convex_api.files_nodes.move_nodes, {
					membershipId,
					itemIds: movedFileNodeIds.map((fileNodeId) => fileNodeId as app_convex_Id<"files_nodes">),
					targetParentId:
						targetParentId === files_ROOT_ID ? files_ROOT_ID : (targetParentId as app_convex_Id<"files_nodes">),
				})
				.then((result) => {
					if (result._nay) {
						console.error("[FilesSidebar.handleDropForeignDragObject] Failed to move nodes", { result });
						if (result._nay.message === "Permission denied") {
							toast.error("You don't have permission to edit files in this workspace.");
							return;
						}
						toast.error(result._nay.message);
						return;
					}
				})
				.catch((error) => {
					console.error("[FilesSidebar.handleDropForeignDragObject] Error moving nodes", { error });
				});
		}

		if (
			!can_receive_file_drop({
				dataTransfer,
				target,
				isBusy,
				isUploadingFile,
			})
		) {
			toast.error("Drop files onto a folder or the root.");
			return;
		}

		const droppedFiles = await get_dropped_files(dataTransfer);
		if (droppedFiles._nay) {
			toast.error(droppedFiles._nay.message ?? "Failed to read dropped files.");
			return;
		}

		const targetParentId = target.item.getId();
		const parentId = targetParentId === files_ROOT_ID ? files_ROOT_ID : (targetParentId as app_convex_Id<"files_nodes">);
		const entries = get_import_file_entries(droppedFiles._yay);
		if (entries.length === 0) {
			toast.error("Drop a file to upload.");
			return;
		}

		// A single bare file keeps the existing per-file flow with its rename and replace modal.
		if (entries.length === 1 && entries[0]!.relativePath === entries[0]!.file.name) {
			uploadBrowserFile({ file: entries[0]!.file, parentId });
			return;
		}

		importBrowserFiles({ entries, parentId });
	});

	const canRename = useFn<NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["canRename"]>>((item) => {
		const itemData = item.getItemData();
		return files_is_node(itemData);
	});

	/**
	 * Handle Headless Tree rename mode changes.
	 *
	 * Called whenever rename mode starts, aborts, or completes.
	 */
	const handleRenamingItemChange = useFn<NonNullable<TreeConfig<files_TreeItem>["setRenamingItem"]>>(
		(renamingItemUpdate) => {
			const nextRenamingItem =
				typeof renamingItemUpdate === "function" ? renamingItemUpdate(renamingItem) : renamingItemUpdate;

			setRenamingItem(nextRenamingItem);
			if (nextRenamingItem == null) {
				dom_clear_text_selection();
				files_clear_node_path_cached_validation_messages();
			}
			setRenameErrorByNodeId(new Map());
		},
	);

	/**
	 * Handle accepted rename submissions.
	 *
	 * Called by Headless Tree from `completeRenaming()` after the submit path is allowed.
	 */
	const handleRename = useFn<NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["onRename"]>>((item, value) => {
		const trimmedValue = value.trim();
		const itemData = item.getItemData();
		const itemId = item.getId();

		if (!files_is_node(itemData)) {
			console.error("[FilesSidebar.handleRename] item is not a node", { itemId, itemData });
			return;
		}

		if (!trimmedValue) {
			return;
		}

		const renameData = ((/* iife */) => {
			if (
				itemData.assetId &&
				!(itemData.contentType?.startsWith("text/markdown" satisfies files_ContentType) ?? false)
			) {
				const renameValidation = get_uploaded_file_rename_validation({
					treeItemsList: treeItems?.list,
					nodeIdToIgnore: itemId as app_convex_Id<"files_nodes">,
					parentId: itemData.parentId,
					nameOrPath: trimmedValue,
				});

				return {
					renameValidation,
					normalizedName: renameValidation.normalizedName,
				};
			}

			const renameValidation = files_get_node_path_validation({
				scopeId: membershipId,
				fileNodesList: treeItems?.list,
				nodeIdToIgnore: itemId as app_convex_Id<"files_nodes">,
				parentId: itemData.parentId,
				kind: itemData.kind,
				nameOrPath: trimmedValue,
			});

			// Keep path-like renames as folder segments, but canonicalize the final file leaf before Convex creates/moves nodes.
			const isPathLikeName = trimmedValue.includes("/");
			const normalizedName = ((/* iife */) => {
				if (isPathLikeName) {
					const pathSegments = path_extract_segments_from(trimmedValue);
					const leafSegment = pathSegments.at(-1);
					if (!leafSegment) {
						return null;
					}

					if (itemData.kind === "file") {
						const leafSegmentResult = files_normalize_name(itemData.kind, leafSegment);
						if (leafSegmentResult._nay) {
							console.error("[FilesSidebar.handleRename] Invalid path leaf value", {
								result: leafSegmentResult,
								itemId,
							});
							return null;
						}

						pathSegments[pathSegments.length - 1] = leafSegmentResult._yay;
					}

					return pathSegments.join("/");
				}

				const normalizedNameResult = files_normalize_name(itemData.kind, trimmedValue);
				if (normalizedNameResult._nay) {
					console.error("[FilesSidebar.handleRename] Invalid rename value", { result: normalizedNameResult, itemId });
					return null;
				}

				return normalizedNameResult._yay;
			})();

			return {
				renameValidation,
				normalizedName,
			};
		})();
		const { renameValidation, normalizedName } = renameData;
		const renameError = renameValidation.validationMessage;
		if (renameError) {
			renameValidation.cacheValidationMessage(renameError);
			setRenameError(itemId, renameError);
			item.setFocused();
			return;
		}

		if (normalizedName == null) {
			return;
		}

		if (normalizedName === itemData.name) {
			return;
		}

		clearRenameError(itemId);
		item.setFocused();
		markFileAsPending(itemId);
		convex
			.mutation(
				app_convex_api.files_nodes.rename_node,
				{
					membershipId,
					nodeId: itemId as app_convex_Id<"files_nodes">,
					path: normalizedName,
				},
				{
					optimisticUpdate: (localStore) => {
						// Keep cache writes representable as raw `files_nodes` docs; path-like renames may create folders.
						if (normalizedName.includes("/")) {
							return;
						}

						const treeNodesList = localStore.getQuery(app_convex_api.files_nodes.list_tree, {
							membershipId,
						});
						if (!treeNodesList) {
							return;
						}
						const treeItemsList = files_create_tree_items_list_from_nodes(treeNodesList);
						const nextTreeItemsList = get_tree_items_list_after_optimistic_rename({
							treeItemsList,
							itemId,
							normalizedName,
							now: Date.now(),
						});
						const renamedItem = nextTreeItemsList.find(
							(treeItem): treeItem is files_VisibleTreeNode => files_is_node(treeItem) && treeItem._id === itemId,
						);
						if (!renamedItem) {
							return;
						}

						localStore.setQuery(
							app_convex_api.files_nodes.list_tree,
							{
								membershipId,
							},
							treeNodesList.map((node) =>
								node._id === itemId
									? {
											...node,
											name: renamedItem.name,
											path: renamedItem.path,
											updatedAt: renamedItem.updatedAt,
										}
									: node,
							),
						);
					},
				},
			)
			.then((result) => {
				if (result._nay) {
					console.error("[FilesSidebar.handleRename] Failed to rename node", { result });
					// A refused permission is not a bad name. Showing it under the name input would tell the
					// user to pick another name, which never helps here.
					if (result._nay.message === "Permission denied") {
						toast.error("You don't have permission to edit files in this workspace.");
						return;
					}
					renameValidation.cacheValidationMessage(result._nay.message);
					setRenameError(itemId, result._nay.message);
				}
			})
			.catch((error) => {
				console.error("[FilesSidebar.handleRename] Error on rename node", { error });
			})
			.finally(() => {
				unmarkFileAsPending(itemId);
				files_clear_node_path_cached_validation_messages();
			});
	});

	/**
	 * Handle Enter while an item is being renamed.
	 *
	 * Called by the Headless Tree hotkey layer before `completeRenaming()` submits the value.
	 */
	const handleCompleteRenamingHotkey = useFn((event: KeyboardEvent, currentTree: TreeInstance<files_TreeItem>) => {
		const item = currentTree.getRenamingItem();
		if (!item) {
			return;
		}

		const itemData = item.getItemData();
		const itemId = item.getId();
		const trimmedValue = currentTree.getRenamingValue().trim();
		if (files_is_node(itemData) && trimmedValue) {
			const isMarkdown = itemData.contentType?.startsWith("text/markdown" satisfies files_ContentType) ?? false;
			const renameValidation =
				itemData.assetId && !isMarkdown
					? get_uploaded_file_rename_validation({
							treeItemsList: treeItems?.list,
							nodeIdToIgnore: itemId as app_convex_Id<"files_nodes">,
							parentId: itemData.parentId,
							nameOrPath: trimmedValue,
						})
					: files_get_node_path_validation({
							scopeId: membershipId,
							fileNodesList: treeItems?.list,
							nodeIdToIgnore: itemId as app_convex_Id<"files_nodes">,
							parentId: itemData.parentId,
							kind: itemData.kind,
							nameOrPath: trimmedValue,
						});
			const renameError = renameValidation.validationMessage;
			if (renameError) {
				event.preventDefault();
				renameValidation.cacheValidationMessage(renameError);
				setRenameError(itemId, renameError);
				item.setFocused();
				return;
			}
		}

		clearRenameError(itemId);

		// Triggers the BE mutation
		currentTree.completeRenaming();
	});

	const handlePrimaryAction = useFn<NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["onPrimaryAction"]>>(
		(item) => {
			const itemData = item.getItemData();
			if (files_is_node(itemData)) {
				onPrimaryAction(item.getId(), itemData.kind);
			}
		},
	);

	const isInternalTreeDragActiveRef = useRef(false);
	const reconcileTreeSelectionToNavigatedNode = useFn((treeInstance: TreeInstance<files_TreeItem>) => {
		const selectableNavigatedNodeId =
			selectedNodeId && selectedNodeId !== files_ROOT_ID && visibleFileIds.has(selectedNodeId) ? selectedNodeId : null;
		const selectionDataRef = treeInstance.getDataRef<SelectionDataRef>();
		const selectedItemIds = treeInstance.getState().selectedItems ?? [];

		if (!selectableNavigatedNodeId) {
			if (selectedItemIds.length === 0 && !selectionDataRef.current.selectUpToAnchorId) {
				return;
			}

			selectionDataRef.current.selectUpToAnchorId = null;
			treeInstance.setSelectedItems([]);
			return;
		}

		if (
			selectedItemIds.length === 1 &&
			selectedItemIds[0] === selectableNavigatedNodeId &&
			selectionDataRef.current.selectUpToAnchorId === selectableNavigatedNodeId
		) {
			return;
		}

		// Keep drag cleanup aligned with the route-owned navigated row, not Headless Tree's temporary drag source.
		selectionDataRef.current.selectUpToAnchorId = selectableNavigatedNodeId;
		treeInstance.setSelectedItems([selectableNavigatedNodeId]);
		treeInstance.getItemInstance(selectableNavigatedNodeId).setFocused();
	});

	const reconcileTreeSelectionToNavigatedNodeAfterInternalDrag = useFn((treeInstance: TreeInstance<files_TreeItem>) => {
		if (!isInternalTreeDragActiveRef.current) {
			return;
		}

		isInternalTreeDragActiveRef.current = false;
		reconcileTreeSelectionToNavigatedNode(treeInstance);
	});

	const [dragSelectionReconcileFeature] = useState(
		() =>
			({
				key: "files-sidebar-drag-selection-reconcile",

				treeInstance: {
					getContainerProps: ({ tree, prev }, treeLabel) => {
						const prevProps = prev?.(treeLabel) ?? {};

						return {
							...prevProps,
							onDrop: (event: DragEvent) => {
								return Promise.resolve(prevProps.onDrop?.(event)).finally(() => {
									reconcileTreeSelectionToNavigatedNodeAfterInternalDrag(tree);
								});
							},
						};
					},
				},

				itemInstance: {
					getProps: ({ tree, prev }) => {
						const prevProps = prev?.() ?? {};

						return {
							...prevProps,
							onDrop: (event: DragEvent) => {
								return Promise.resolve(prevProps.onDrop?.(event)).finally(() => {
									reconcileTreeSelectionToNavigatedNodeAfterInternalDrag(tree);
								});
							},
						};
					},

					getDragHandleProps: ({ tree, prev }) => {
						const prevProps = prev?.() ?? {};

						return {
							...prevProps,
							onDragStart: (event: DragEvent) => {
								isInternalTreeDragActiveRef.current = true;
								prevProps.onDragStart?.(event);
								if (event.defaultPrevented) {
									isInternalTreeDragActiveRef.current = false;
								}
							},
							onDragEnd: (event: DragEvent) => {
								prevProps.onDragEnd?.(event);
								reconcileTreeSelectionToNavigatedNodeAfterInternalDrag(tree);
							},
						};
					},
				},
			}) satisfies FeatureImplementation<files_TreeItem>,
	);

	const [clickBehaviorFeature] = useState(
		() =>
			({
				key: "files-sidebar-click-behavior",

				itemInstance: {
					getProps: ({ tree, item, itemId, prev }) => {
						const prevProps = prev?.() ?? {};

						return {
							...prevProps,
							onClick: (event: MouseEvent) => {
								const isModifierClick = event.shiftKey || event.ctrlKey || event.metaKey;

								if (event.shiftKey) {
									item.selectUpTo(event.ctrlKey || event.metaKey);
								} else if (event.ctrlKey || event.metaKey) {
									item.toggleSelect();
								} else {
									tree.setSelectedItems([itemId]);
								}

								if (!isModifierClick) {
									tree.getDataRef<SelectionDataRef>().current.selectUpToAnchorId = itemId;
								}

								item.setFocused();
								if (isModifierClick) {
									return;
								}

								if (event.altKey) {
									// Alt+click selects the row without opening the file.
									return;
								}

								item.primaryAction();
							},
						};
					},
				},
			}) satisfies FeatureImplementation<files_TreeItem>,
	);

	const dataLoader = {
		getItem: (itemId: string) =>
			treeItems?.itemById.get(itemId) ?? treeItems?.itemById.get(files_ROOT_ID) ?? files_SYNTHETIC_ROOT_FOLDER,
		getChildren: (itemId: string) => {
			const children = treeItems?.sortedItemsIdsByParentId.get(itemId) ?? [];
			if (!isSearchActive) {
				return children;
			}
			return children.filter((childId) => visibleFileIds.has(childId));
		},
	} satisfies TreeConfig<files_TreeItem>["dataLoader"];

	const tree = useTree<files_TreeItem>({
		rootItemId: files_ROOT_ID,
		state: {
			expandedItems,
			renamingItem,
		},
		setExpandedItems,
		canReorder: false,
		dataLoader,
		features: [
			syncDataLoaderFeature,
			selectionFeature,
			hotkeysCoreFeature,
			dragAndDropFeature,
			renamingFeature,
			expandAllFeature,
			dragSelectionReconcileFeature,
			clickBehaviorFeature,
			propMemoizationFeature,
		],
		hotkeys: {
			completeRenaming: {
				hotkey: "Enter",
				allowWhenInputFocused: true,
				handler: handleCompleteRenamingHotkey,
			},
		},
		getItemName: (item) => item.getItemData().name,
		isItemFolder: (item) => item.getItemData().kind === "folder",
		canDrag,
		canDrop,
		canDragForeignDragObjectOver,
		canDropForeignDragObject,
		onDropForeignDragObject: handleDropForeignDragObject,
		setRenamingItem: handleRenamingItemChange,
		onDrop: handleDrop,
		canRename,
		onRename: handleRename,
		onPrimaryAction: handlePrimaryAction,
	});

	const renderedTreeItems = tree().getItems();
	const renderedNodeIds = new Set(
		renderedTreeItems.filter((item) => files_is_node(item.getItemData())).map((item) => item.getId()),
	);

	const selectedNodeIds = new Set(
		renderedTreeItems
			.filter((item) => item.isSelected() && files_is_node(item.getItemData()))
			.map((item) => item.getId()),
	);
	const selectionAnchorNodeId = tree().getDataRef<SelectionDataRef>().current.selectUpToAnchorId ?? null;

	useGlobalEventList(
		FILES_SIDEBAR_SELECTION_CONTEXT_EVENTS,
		(event) => {
			// A click or focus outside the tree selection areas means the user moved on to
			// other work: drop the multi-selection and select only the open file's row again.
			if (is_inside_tree_selection_area(event.target)) {
				return;
			}

			if (is_tree_context_menu_open()) {
				return;
			}

			reconcileTreeSelectionToNavigatedNode(tree());
		},
		{ capture: true },
	);

	/**
	 * The files ids used as the source for active tree tracks.
	 * In multi-select mode, only the selection anchor files track highlighting.
	 */
	const trackSourceNodeIds = ((/* iife */) => {
		const result = new Set<string>();

		if (selectedNodeIds.size > 1) {
			const anchorNodeId = selectionAnchorNodeId;
			if (anchorNodeId && selectedNodeIds.has(anchorNodeId) && renderedNodeIds.has(anchorNodeId)) {
				result.add(anchorNodeId);
				return result;
			}

			for (const item of renderedTreeItems) {
				const itemId = item.getId();
				if (selectedNodeIds.has(itemId)) {
					result.add(itemId);
					break;
				}
			}

			return result;
		}

		if (selectedNodeIds.size === 1) {
			const singleSelectedNodeId = selectedNodeIds.values().next().value;
			if (singleSelectedNodeId) {
				result.add(singleSelectedNodeId);
			}
			return result;
		}

		if (selectedNodeId && renderedNodeIds.has(selectedNodeId)) {
			result.add(selectedNodeId);
		}

		return result;
	})();

	/**
	 * The files ids with the tracks that needs to highlight
	 * for selected and navigated files.
	 */
	const trackActiveFileIds = ((/* iife */) => {
		const result = new Set<string>();

		for (const sourceNodeId of trackSourceNodeIds) {
			const item = tree().getItemInstance(sourceNodeId);

			// If the file is expanded, highlight the track inside
			if (item.isFolder() && item.getChildren().length > 0 && item.isExpanded()) {
				result.add(item.getId());
				continue;
			}

			// If the file is not expanded, highlight the track of the parent
			const parent = item.getParent();
			if (parent) {
				result.add(parent.getId());
			}
		}

		return result;
	})();

	const showEmptyState = treeItemsList !== undefined && visibleFileIds.size <= 1;

	const startRename = useFn((itemId: string) => {
		const item = tree().getItemInstance(itemId);
		if (!files_is_node(item.getItemData())) {
			return;
		}

		item.setFocused();
		item.startRenaming();
	});

	const handleStartRename = useFn<FilesSidebarTree_Props["onStartRename"]>((itemId) => {
		startRename(itemId);
	});

	const handleCreateNodeClick = useFn<FilesSidebarTree_Props["onCreateNode"]>((parentNodeId, kind) => {
		if (!treeItems) {
			console.error(should_never_happen("[FilesSidebar.handleCreateNodeClick] missing deps", { treeItems }));
			return;
		}

		const nextNodeName = get_default_node_name({
			parentId: parentNodeId,
			kind,
			treeItems,
		});

		setIsCreatingFile(true);
		const createNodePromise =
			kind === "folder"
				? convex.mutation(app_convex_api.files_nodes.create_folder_node, {
						membershipId,
						parentId: parentNodeId === files_ROOT_ID ? files_ROOT_ID : (parentNodeId as app_convex_Id<"files_nodes">),
						path: nextNodeName,
					})
				: convex.action(app_convex_api.files_nodes_content.create_markdown_node, {
						membershipId,
						parentId: parentNodeId === files_ROOT_ID ? files_ROOT_ID : (parentNodeId as app_convex_Id<"files_nodes">),
						path: nextNodeName,
					});

		createNodePromise
			.then((result) => {
				if (result._nay) {
					console.error("[FilesSidebar.handleCreateNodeClick] Failed to create node", {
						result,
					});
					// A refused permission is not a bad name. Showing it under the name input would tell the
					// user to pick another name, which never helps here.
					if (result._nay.message === "Permission denied") {
						toast.error("You don't have permission to create files in this workspace.");
						return;
					}
					const createNodeValidation = files_get_node_path_validation({
						scopeId: membershipId,
						fileNodesList: treeItems.list,
						parentId: parentNodeId === files_ROOT_ID ? files_ROOT_ID : (parentNodeId as app_convex_Id<"files_nodes">),
						kind,
						nameOrPath: nextNodeName,
					});
					createNodeValidation.cacheValidationMessage(result._nay.message);
					return;
				}

				// Mirror non-modifier tree clicks so programmatic create moves the visible selection too.
				tree().setSelectedItems([result._yay.nodeId]);
				tree().getDataRef<SelectionDataRef>().current.selectUpToAnchorId = result._yay.nodeId;

				return navigate({
					to: "/w/$organizationName/$workspaceName/files",
					params: { organizationName, workspaceName },
					search: { nodeId: result._yay.nodeId, view },
				}).then(() => {
					return startRename(result._yay.nodeId);
				});
			})
			.catch((error) => {
				console.error("[FilesSidebar.handleCreateNodeClick] Error creating node", { error });
			})
			.finally(() => {
				setIsCreatingFile(false);
			});
	});

	const handleCopy = useFn<FilesSidebarTree_Props["onCopy"]>((nodeId) => {
		const shouldCopySelectedFiles = selectedNodeIds.has(nodeId);
		const nodeIdsToCopy = shouldCopySelectedFiles ? selectedNodeIds : new Set([nodeId]);
		const paths = Array.from(nodeIdsToCopy, (id) => tree().getItemInstance(id).getItemData().path);

		copy_to_clipboard({ text: paths.join("\n") }).catch((error) => {
			console.error("[FilesSidebar.handleCopy] Failed to copy paths", { error, nodeId });
		});
	});

	const handleCopyLink = useFn<FilesSidebarTree_Props["onCopyLink"]>((nodeId) => {
		const shouldCopySelectedFiles = selectedNodeIds.has(nodeId);
		const nodeIdsToCopy = shouldCopySelectedFiles ? selectedNodeIds : new Set([nodeId]);
		const links = Array.from(
			nodeIdsToCopy,
			(id) => `${window.location.origin}${url_path_file_by_node_id({ organizationName, workspaceName, nodeId: id })}`,
		);

		copy_to_clipboard({ text: links.join("\n") }).catch((error) => {
			console.error("[FilesSidebar.handleCopyLink] Failed to copy links", { error, nodeId });
		});
	});

	const handleCopyNodeId = useFn<FilesSidebarTree_Props["onCopyNodeId"]>((nodeId) => {
		const shouldCopySelectedFiles = selectedNodeIds.has(nodeId);
		const nodeIdsToCopy = shouldCopySelectedFiles ? selectedNodeIds : new Set([nodeId]);

		copy_to_clipboard({ text: Array.from(nodeIdsToCopy).join("\n") }).catch((error) => {
			console.error("[FilesSidebar.handleCopyNodeId] Failed to copy node ids", { error, nodeId });
		});
	});

	// Sharing is always about one node, unlike copy or archive, which act on the whole selection: a
	// share list belongs to a single file or folder, so there is nothing to apply to the others.
	const handleShare = useFn<FilesSidebarTree_Props["onShare"]>((nodeId) => {
		setShareNodeId(nodeId as app_convex_Id<"files_nodes">);
	});

	const handleShareModalClose = useFn(() => {
		setShareNodeId(null);
	});

	const handleSearchQueryChange = useFn<FilesSidebarTopSection_Props["onSearchQueryChange"]>((nextSearchQuery) => {
		setSearchQuery(nextSearchQuery);
		onSearchQueryChange(nextSearchQuery);
	});

	const handleSearchSubmit = useFn<FilesSidebarSearch_Props["onSubmit"]>((searchQuery) => {
		// Match on the value the input holds right now. `searchResult` lags behind it by the
		// debounce plus the deferred render, so Enter right after a paste would use the old query.
		if (!treeItems || searchQuery.trim().length === 0) {
			return;
		}

		const topMatchId = get_search_matches({ treeItems, searchQuery }).topMatchId;
		const topMatchItem = topMatchId ? treeItems.itemById.get(topMatchId) : undefined;
		if (!topMatchId || !topMatchItem) {
			return;
		}

		onPrimaryAction(topMatchId, topMatchItem.kind);
	});

	const handleArchive = useFn<FilesSidebarTree_Props["onArchive"]>((nodeId) => {
		const shouldArchiveSelectedFiles = selectedNodeIds.has(nodeId);
		const nodeIdsToArchive = shouldArchiveSelectedFiles ? selectedNodeIds : new Set([nodeId]);

		if (shouldArchiveSelectedFiles) {
			setIsArchivingSelection(true);
		} else {
			markFileAsPending(nodeId);
		}

		convex
			.mutation(app_convex_api.files_nodes.archive_nodes, {
				membershipId,
				nodeIds: Array.from(nodeIdsToArchive),
			})
			.then((result) => {
				if (result._nay) {
					console.error("[FilesSidebar.handleArchive] Failed to archive files", {
						result,
						nodeId,
						nodeIdsToArchive,
					});
					if (result._nay.message === "Permission denied") {
						toast.error("You don't have permission to edit files in this workspace.");
						return;
					}
					toast.error(result._nay.message);
					return;
				}

				if (selectedNodeId && nodeIdsToArchive.has(selectedNodeId)) {
					onArchive(selectedNodeId);
					return;
				}

				if (!shouldArchiveSelectedFiles) {
					onArchive(nodeId);
				}
			})
			.catch((error) => {
				console.error("[FilesSidebar.handleArchive] Error archiving files", {
					error,
					nodeIdsToArchive,
				});
			})
			.finally(() => {
				if (shouldArchiveSelectedFiles) {
					tree().setSelectedItems([]);
					setIsArchivingSelection(false);
					return;
				}

				unmarkFileAsPending(nodeId);
			});
	});

	const handleArchiveSelectionClick = useFn(() => {
		const firstSelectedNodeId = selectedNodeIds.values().next().value;
		if (!firstSelectedNodeId) {
			return;
		}

		handleArchive(firstSelectedNodeId);
	});

	const handleUnarchive = useFn<FilesSidebarTree_Props["onUnarchive"]>((nodeId) => {
		markFileAsPending(nodeId);
		convex
			.mutation(app_convex_api.files_nodes.unarchive_nodes, {
				membershipId,
				nodeIds: [nodeId as app_convex_Id<"files_nodes">],
			})
			.then((result) => {
				if (result._nay) {
					console.error("[FilesSidebar.handleUnarchive] Failed to unarchive file", { result, nodeId });
					if (result._nay.message === "Permission denied") {
						toast.error("You don't have permission to edit files in this workspace.");
						return;
					}
					toast.error(result._nay.message);
					return;
				}
			})
			.catch((error) => {
				console.error("[FilesSidebar.handleUnarchive] Error unarchiving file", { error, nodeId });
			})
			.finally(() => {
				unmarkFileAsPending(nodeId);
			});
	});

	const handleExpandTopFilesClick = useFn(() => {
		// Expand only the immediate children of the root file
		Promise.try(() => tree().loadChildrenIds(files_ROOT_ID))
			.then(() => {
				for (const child of tree().getRootItem().getChildren()) {
					child.expand();
				}
			})
			.catch((error) => {
				console.error("[FilesSidebar.handleExpandAllClick] Failed to expand tree", { error });
			});
	});

	const handleCollapseAllClick = useFn(() => {
		tree().collapseAll();
	});

	const handleClearSelectionClick = useFn(() => {
		tree().setSelectedItems([]);
	});

	const handleCreateRootFileClick = useFn(() => {
		handleCreateNodeClick(files_ROOT_ID, "file");
	});

	const handleCreateRootFolderClick = useFn(() => {
		handleCreateNodeClick(files_ROOT_ID, "folder");
	});

	const handleArchiveToggleClick = useFn(() => {
		setShowArchived((oldValue) => !oldValue);
	});

	const handleUploadFileClick = useFn(() => {
		uploadInputRef.current?.click();
	});

	// Picked uploads land in the selected folder when one is selected, otherwise in the root.
	const resolveSelectedFolderParentId = () => {
		const selectedItem = selectedNodeId && treeItems ? treeItems.itemById.get(selectedNodeId) : null;
		return selectedItem &&
			selectedItem._id !== files_ROOT_ID &&
			selectedItem.kind === "folder" &&
			selectedItem.archiveOperationId === undefined
			? (selectedItem._id as app_convex_Id<"files_nodes">)
			: files_ROOT_ID;
	};

	const handleUploadFileChange = useFn<React.ComponentProps<"input">["onChange"]>((event) => {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = "";
		if (!file || !treeItems) {
			return;
		}

		uploadBrowserFile({
			file,
			parentId: resolveSelectedFolderParentId(),
		});
	});

	const handleImportFolderClick = useFn(() => {
		importFolderInputRef.current?.click();
	});

	const handleImportFolderChange = useFn<React.ComponentProps<"input">["onChange"]>((event) => {
		const inputElement = event.currentTarget;
		// `fromEvent` reads the files from the event target, so reset the input only after it resolves.
		fromEvent(event.nativeEvent)
			.then((pickedItems) => {
				inputElement.value = "";
				const files = pickedItems.filter((item): item is FileWithPath => item instanceof File);
				const entries = get_import_file_entries(files);
				if (entries.length === 0) {
					return;
				}

				importBrowserFiles({ entries, parentId: resolveSelectedFolderParentId() });
			})
			.catch((error: unknown) => {
				inputElement.value = "";
				console.error("[FilesSidebar.handleImportFolderChange] Failed to read picked folder", { error });
				toast.error("Failed to read the selected folder.");
			});
	});

	const handleUploadDraftClose = useFn(() => {
		setUploadDraft(null);
	});

	const handleUploadDraftRename = useFn((filename: string) => {
		if (!uploadDraft) {
			return;
		}

		uploadFile({
			file: uploadDraft.file,
			parentId: uploadDraft.parentId,
			filename,
			contentType: uploadDraft.contentType,
			isMarkdown: uploadDraft.isMarkdown,
		});
	});

	const handleUploadDraftReplace = useFn(() => {
		if (!uploadDraft?.conflict || uploadDraft.conflict.kind !== "file") {
			return;
		}

		createUploadNodeAndPut({
			file: uploadDraft.file,
			parentId: uploadDraft.parentId,
			filename: uploadDraft.filename,
			contentType: uploadDraft.contentType,
		});
	});

	// A workspace switch must not keep writing into the old workspace: cancel a running import
	// that was started under another membership. The import loop checks `cancelRequested`
	// between chunks and cleans up its un-uploaded nodes.
	useEffect(() => {
		const importState = useFilesImportStore.getState();
		if (importState.phase !== "idle" && importState.membershipId && importState.membershipId !== membershipId) {
			useFilesImportStore.setState({ cancelRequested: true });
		}
	}, [membershipId]);

	// Rebuild tree when visible files or controlled expansion state changes.
	useLayoutEffect(() => {
		tree().rebuildTree();
	}, [expandedItems, visibleFileIds]);

	// Auto-expand search matches and the current page path.
	useLayoutEffect(() => {
		if (!treeItems) {
			return;
		}

		const currentExpandedItems = new Set(expandedItems);
		let nextExpandedItemsSet = new Set(currentExpandedItems);

		// When search closes, restore whatever expansion state existed before entering search mode.
		if (!isSearchActive) {
			const expandedItemsBeforeSearch = expandedItemsBeforeSearchRef.current;
			if (expandedItemsBeforeSearch) {
				nextExpandedItemsSet = new Set(expandedItemsBeforeSearch);
				expandedItemsBeforeSearchRef.current = null;
			}
		}
		// When search opens, snapshot current expansion once, then force-expand ancestors of visible items.
		else {
			if (!expandedItemsBeforeSearchRef.current) {
				expandedItemsBeforeSearchRef.current = new Set(currentExpandedItems);
			}

			nextExpandedItemsSet = new Set<string>([files_ROOT_ID]);
			for (const nodeId of visibleFileIds) {
				const childrenIds = treeItems.itemsIdsByParentId.get(nodeId);
				if (!childrenIds) {
					continue;
				}

				for (const childId of childrenIds) {
					if (visibleFileIds.has(childId)) {
						nextExpandedItemsSet.add(nodeId);
						break;
					}
				}
			}
		}

		// Build a stable selected-file path key so each selected path auto-expands once, even after nested create/rename moves.
		const selectedFilePathAutoExpanded = (() => {
			if (!selectedNodeId || !hasSelectedFileInTree) {
				return null;
			}

			const ancestorIds: string[] = [];
			let currentItemId = treeItems.itemById.get(selectedNodeId)?.parentId;

			while (currentItemId) {
				ancestorIds.push(currentItemId);

				const currentItem = treeItems.itemById.get(currentItemId);
				if (!currentItem || currentItem._id === files_ROOT_ID) {
					break;
				}

				currentItemId = currentItem.parentId;
			}

			return {
				ancestorIds,
				key: [selectedNodeId, ...ancestorIds].join("/"),
			};
		})();

		// Keep the current page visible in the tree after route changes and path-based create/rename moves.
		if (
			selectedFilePathAutoExpanded &&
			selectedFilePathAutoExpandedKeyRef.current !== selectedFilePathAutoExpanded.key
		) {
			for (const ancestorId of selectedFilePathAutoExpanded.ancestorIds) {
				nextExpandedItemsSet.add(ancestorId);
			}

			selectedFilePathAutoExpandedKeyRef.current = selectedFilePathAutoExpanded.key;
		}

		// Skip state updates when nothing changed to avoid unnecessary rebuilds.
		if (currentExpandedItems.symmetricDifference(nextExpandedItemsSet).size > 0) {
			setExpandedItems([...nextExpandedItemsSet]);
		}
	}, [expandedItems, hasSelectedFileInTree, selectedNodeId, setExpandedItems, treeItems, visibleFileIds]);

	// Auto focus file in tree on file navigation
	useEffect(() => {
		const nextFocusedItemId =
			(selectedNodeId && visibleFileIds.has(selectedNodeId) ? selectedNodeId : undefined) ??
			treeItems?.sortedItemsIdsByParentId.get(files_ROOT_ID)?.[0];
		if (!nextFocusedItemId) {
			return;
		}

		tree().getItemInstance(nextFocusedItemId).setFocused();
	}, [visibleFileIds, selectedNodeId]);

	// Keep the URL-owned selected node as the single selected tree row; root/home means no tree row is selected.
	useLayoutEffect(() => {
		reconcileTreeSelectionToNavigatedNode(tree());
	}, [selectedNodeId, visibleFileIds]);

	// The `aside` gets a name because the app sidebar is also a `complementary` landmark. Two landmarks
	// of the same type with no name sound identical to a screen reader moving between them.
	return (
		<aside aria-label="Files" className={"FilesSidebar" satisfies FilesSidebar_ClassNames}>
			<input
				ref={uploadInputRef}
				type="file"
				aria-hidden="true"
				tabIndex={-1}
				style={{ display: "none" }}
				onChange={handleUploadFileChange}
			/>
			<input
				ref={importFolderInputRef}
				type="file"
				aria-hidden="true"
				tabIndex={-1}
				style={{ display: "none" }}
				// `webkitdirectory` makes the picker select a folder; React's input typings omit it,
				// so spread it as a raw attribute.
				{...{ webkitdirectory: "" }}
				onChange={handleImportFolderChange}
			/>
			<FilesSidebarUploadConflictModal
				draft={uploadDraft}
				isUploading={isUploadingFile}
				onClose={handleUploadDraftClose}
				onRename={handleUploadDraftRename}
				onReplace={handleUploadDraftReplace}
			/>
			<FilesSidebarImportConflictModal
				conflicts={importConflicts}
				onReplace={handleImportConflictReplace}
				onSkipExisting={handleImportConflictSkip}
				onCancel={handleImportConflictCancel}
			/>
			<FilesSidebarTopSection
				view={view}
				selectedNodeIdsCount={selectedNodeIds.size}
				isBusy={isBusy}
				isUploadingFile={isUploadingFile}
				canExpandAll={canExpandAll}
				canCollapseAll={canCollapseAll}
				treeItemsList={treeItemsList}
				showArchived={showArchived}
				initialSearchQuery={initialSearchQuery}
				onClose={onClose}
				onSearchQueryChange={handleSearchQueryChange}
				onSearchSubmit={handleSearchSubmit}
				onExpandTopFilesClick={handleExpandTopFilesClick}
				onCollapseAllClick={handleCollapseAllClick}
				onClearSelectionClick={handleClearSelectionClick}
				onCreateRootFileClick={handleCreateRootFileClick}
				onCreateRootFolderClick={handleCreateRootFolderClick}
				onArchiveToggleClick={handleArchiveToggleClick}
				onArchiveSelectionClick={handleArchiveSelectionClick}
				onUploadFileClick={handleUploadFileClick}
				onImportFolderClick={handleImportFolderClick}
			/>

			<div className={cn("FilesSidebar-content" satisfies FilesSidebar_ClassNames)}>
				<FilesSidebarTree
					tree={tree}
					isTreeLoading={treeItemsList === undefined}
					showEmptyState={showEmptyState}
					isSearchActive={isSearchActive}
					displayNameByUserId={displayNameByUserId}
					trackActiveFileIds={trackActiveFileIds}
					selectedNodeId={selectedNodeId}
					selectedNodeIds={selectedNodeIds}
					isBusy={isBusy}
					isUploadingFile={isUploadingFile}
					pendingActionNodeIds={pendingActionNodeIds}
					renameErrorByNodeId={renameErrorByNodeId}
					onCreateNode={handleCreateNodeClick}
					onStartRename={handleStartRename}
					onRenameErrorClear={clearRenameError}
					onCopy={handleCopy}
					onCopyLink={handleCopyLink}
					onCopyNodeId={handleCopyNodeId}
					onShare={handleShare}
					onArchive={handleArchive}
					onUnarchive={handleUnarchive}
				/>
			</div>

			<FilesShareModal nodeId={shareNodeId} onClose={handleShareModalClose} />
		</aside>
	);
});
// #endregion root

// #region tests
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, test, expect, vi } = import.meta.vitest;

	const test_node = (args: {
		id: string;
		parentId: string;
		kind: files_TreeItem["kind"];
		name: string;
		path?: string;
		archiveOperationId?: string;
	}): files_VisibleTreeNode => {
		const id = args.id as app_convex_Id<"files_nodes">;
		const path = args.path ?? `/${args.name}`;
		const lowercaseExtension =
			args.kind === "file" && args.name.includes(".")
				? args.name.slice(args.name.lastIndexOf(".") + 1).toLowerCase()
				: null;
		return {
			_id: id,
			_creationTime: 0,
			organizationId: "organization" as app_convex_Id<"organizations">,
			workspaceId: "workspace" as app_convex_Id<"organizations_workspaces">,
			parentId: args.parentId === files_ROOT_ID ? files_ROOT_ID : (args.parentId as app_convex_Id<"files_nodes">),
			path,
			treePath: args.kind === "folder" && path !== "/" ? `${path}/` : path,
			pathDepth: path === "/" ? 0 : path.split("/").filter(Boolean).length,
			name: args.name,
			kind: args.kind,
			lowercaseExtension,
			archiveOperationId: args.archiveOperationId,
			createdBy: "test-user" as app_convex_Id<"users">,
			updatedAt: 1,
			updatedBy: "test-user" as app_convex_Id<"users">,
		};
	};

	const test_file = (name = "upload.pdf") => {
		return new File(["content"], name, { type: "application/pdf" });
	};

	const test_upload_draft = (args?: {
		filename?: string;
		reason?: FilesSidebarUploadDraft["reason"];
		conflictKind?: files_TreeItem["kind"];
		conflictName?: string;
	}) => {
		const filename = args?.filename ?? "report.pdf";
		const reason = args?.reason ?? "path_conflict";
		return {
			file: test_file(filename),
			parentId: files_ROOT_ID,
			filename,
			contentType: "application/pdf",
			isMarkdown: false,
			reason,
			...(reason === "path_conflict"
				? {
						conflict: {
							nodeId: "conflict_node" as app_convex_Id<"files_nodes">,
							kind: args?.conflictKind ?? "file",
							name: args?.conflictName ?? filename,
						},
					}
				: {}),
		} satisfies FilesSidebarUploadDraft;
	};

	const test_file_from_directory = (name = "upload.pdf") => {
		const file = test_file(name) as FileWithPath;
		Object.defineProperty(file, "path", {
			value: `/folder/${name}`,
			configurable: true,
		});
		return file;
	};

	const test_file_with_path = (name: string, path: string, type = "application/pdf") => {
		const file = new File(["content"], name, { type }) as FileWithPath;
		Object.defineProperty(file, "path", { value: path, configurable: true });
		return file;
	};

	const test_data_transfer = (args: { types?: string[]; files?: File[]; items?: DataTransferItem[] }) => {
		return {
			types: args.types ?? ["Files"],
			files: args.files ?? [],
			...(args.items ? { items: args.items } : {}),
		} as unknown as DataTransfer;
	};

	const test_drag_target = (itemData: files_TreeItem) => {
		return {
			item: {
				getId: () => itemData._id,
				getItemData: () => itemData,
			},
		} as unknown as DragTarget<files_TreeItem>;
	};

	describe("image upload compression helpers", () => {
		test("compresses only static browser image types", () => {
			expect(image_upload_compression_mime_type(new File(["content"], "photo.jpg", { type: "image/jpeg" }))).toBe(
				"image/jpeg",
			);
			expect(image_upload_compression_mime_type(new File(["content"], "photo.png", { type: "image/png" }))).toBe(
				"image/png",
			);
			expect(image_upload_compression_mime_type(new File(["content"], "photo.webp", { type: "image/webp" }))).toBe(
				"image/webp",
			);
			expect(image_upload_compression_mime_type(new File(["content"], "animated.gif", { type: "image/gif" }))).toBe(
				null,
			);
		});
	});

	const test_drop_zone_row = (args: {
		id: string;
		parentId?: string;
		kind: files_TreeItem["kind"];
		depth: number;
		hasPlaceholderRow?: boolean;
	}): DropZoneRow => {
		return {
			id: args.id,
			parentId: args.parentId ?? files_ROOT_ID,
			kind: args.kind,
			depth: args.depth,
			hasPlaceholderRow: args.hasPlaceholderRow ?? false,
		};
	};

	describe("external file drop helpers", () => {
		test("detects browser file drags from DataTransfer types", () => {
			expect(has_file_drop(test_data_transfer({ types: ["Files"] }))).toBe(true);
			expect(has_file_drop(test_data_transfer({ types: ["text/plain"] }))).toBe(false);
		});

		test("detects internal file node drags from DataTransfer types", () => {
			expect(
				has_file_node_drop(
					test_data_transfer({
						types: [files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE],
					}),
				),
			).toBe(true);
			expect(has_file_node_drop(test_data_transfer({ types: ["Files"] }))).toBe(false);
		});

		test("returns every dropped file, including files from folders", async () => {
			const file = test_file();
			const nested = test_file_from_directory("nested.pdf");
			const result = await get_dropped_files(
				test_data_transfer({
					files: [file, nested],
				}),
			);

			expect(result).toEqual({
				_yay: [file, nested],
			});
		});

		test("rejects empty drops", async () => {
			await expect(get_dropped_files(test_data_transfer({ files: [] }))).resolves.toMatchObject({
				_nay: { message: "Drop a file to upload." },
			});
		});

		test("allows external file drops only on root and folder targets while idle", () => {
			const dataTransfer = test_data_transfer({ files: [test_file()] });
			const folder = test_node({
				id: "folder_1",
				parentId: files_ROOT_ID,
				kind: "folder",
				name: "folder",
			});
			const file = test_node({
				id: "file_1",
				parentId: files_ROOT_ID,
				kind: "file",
				name: "file.md",
			});

			expect(
				can_receive_file_drop({
					dataTransfer,
					target: test_drag_target(files_SYNTHETIC_ROOT_FOLDER),
					isBusy: false,
					isUploadingFile: false,
				}),
			).toBe(true);
			expect(
				can_receive_file_drop({
					dataTransfer,
					target: test_drag_target(folder),
					isBusy: false,
					isUploadingFile: false,
				}),
			).toBe(true);
			expect(
				can_receive_file_drop({
					dataTransfer,
					target: test_drag_target(file),
					isBusy: false,
					isUploadingFile: false,
				}),
			).toBe(false);
			expect(
				can_receive_file_drop({
					dataTransfer,
					target: test_drag_target(folder),
					isBusy: false,
					isUploadingFile: true,
				}),
			).toBe(false);
		});

		test("allows internal file node drops only on root and folder targets while idle", () => {
			const dataTransfer = test_data_transfer({ types: [files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE] });
			const folder = test_node({
				id: "folder_1",
				parentId: files_ROOT_ID,
				kind: "folder",
				name: "folder",
			});
			const file = test_node({
				id: "file_1",
				parentId: files_ROOT_ID,
				kind: "file",
				name: "file.md",
			});

			expect(
				can_receive_file_node_drop({
					dataTransfer,
					target: test_drag_target(files_SYNTHETIC_ROOT_FOLDER),
					isBusy: false,
					isUploadingFile: false,
				}),
			).toBe(true);
			expect(
				can_receive_file_node_drop({
					dataTransfer,
					target: test_drag_target(folder),
					isBusy: false,
					isUploadingFile: false,
				}),
			).toBe(true);
			expect(
				can_receive_file_node_drop({
					dataTransfer,
					target: test_drag_target(file),
					isBusy: false,
					isUploadingFile: false,
				}),
			).toBe(false);
			expect(
				can_receive_file_node_drop({
					dataTransfer,
					target: test_drag_target(folder),
					isBusy: false,
					isUploadingFile: true,
				}),
			).toBe(false);
		});
	});

	describe("folder import helpers", () => {
		test("get_import_file_entries strips path prefixes and filters junk files", () => {
			const bare = test_file_with_path("bare.pdf", "./bare.pdf");
			const dropped = test_file_with_path("photo.png", "/folder/photo.png");
			const picked = test_file_with_path("notes.md", "folder/sub/notes.md");
			const junk = test_file_with_path(".DS_Store", "/folder/.DS_Store");
			const windowsJunk = test_file_with_path("Thumbs.db", "folder/Thumbs.db");
			const relativePathOnly = new File(["content"], "legacy.pdf", { type: "application/pdf" }) as FileWithPath;
			Object.defineProperty(relativePathOnly, "relativePath", { value: "folder/legacy.pdf", configurable: true });

			expect(get_import_file_entries([bare, dropped, picked, junk, windowsJunk, relativePathOnly])).toEqual([
				{ file: bare, relativePath: "bare.pdf" },
				{ file: dropped, relativePath: "folder/photo.png" },
				{ file: picked, relativePath: "folder/sub/notes.md" },
				{ file: relativePathOnly, relativePath: "folder/legacy.pdf" },
			]);
		});

		test("build_import_plan normalizes paths and dedupes targets first-wins", () => {
			const first = test_file_with_path("A.PDF", "/docs/A.PDF");
			const duplicate = test_file_with_path("a.pdf", "/docs/a.pdf");
			const markdown = test_file_with_path("notes.markdown", "/docs/notes.markdown", "text/markdown");
			const missingExtension = test_file_with_path("no-extension", "/docs/no-extension");
			const invalidFolder = test_file_with_path("up.pdf", "../up.pdf");

			const plan = build_import_plan(
				get_import_file_entries([first, duplicate, markdown, missingExtension, invalidFolder]),
			);

			expect(plan.items.map((item) => item.normalizedPath)).toEqual(["docs/a.pdf", "docs/notes.md"]);
			expect(plan.items[0]!.file).toBe(first);
			expect(plan.skipped).toEqual([
				{ relativePath: "docs/a.pdf", reason: "duplicate_after_normalization" },
				{ relativePath: "docs/no-extension", reason: "missing_extension" },
				{ relativePath: "../up.pdf", reason: "invalid_name" },
			]);
		});

		test("build_import_plan keeps special-cased markdown names server-acceptable", () => {
			// The server re-runs the markdown normalizer and rejects any leaf it would change, and
			// `readme` is special-cased to uppercase, so the plan must already carry `README.md`.
			const readme = test_file_with_path("readme.md", "/docs/readme.md", "text/markdown");

			const plan = build_import_plan(get_import_file_entries([readme]));

			expect(plan.items.map((item) => item.normalizedPath)).toEqual(["docs/README.md"]);
			expect(plan.skipped).toEqual([]);
		});

		test("build_import_plan skips too-deep paths", () => {
			const deepPath = `${Array.from({ length: 33 }, (_, index) => `d${index}`).join("/")}/leaf.pdf`;
			const deep = test_file_with_path("leaf.pdf", `/${deepPath}`);

			const plan = build_import_plan(get_import_file_entries([deep]));

			expect(plan.items).toEqual([]);
			expect(plan.skipped).toEqual([{ relativePath: deepPath, reason: "too_deep" }]);
		});

		test("build_import_plan skips over-long paths", () => {
			const longPath = `${Array.from({ length: 20 }, () => "d".repeat(60)).join("/")}/leaf.pdf`;
			const long = test_file_with_path("leaf.pdf", `/${longPath}`);

			const plan = build_import_plan(get_import_file_entries([long]));

			expect(plan.items).toEqual([]);
			expect(plan.skipped).toEqual([{ relativePath: longPath, reason: "too_deep" }]);
		});

		test("chunk_import_items bounds chunks by count and by declared bytes", () => {
			const item = (size: number, name: string): FilesImportPlanItem => ({
				file: { size } as unknown as File,
				relativePath: name,
				normalizedPath: name,
				contentType: undefined,
			});

			const manyItems = Array.from({ length: 51 }, (_, index) => item(1, `f${index}.pdf`));
			expect(chunk_import_items(manyItems).map((chunk) => chunk.length)).toEqual([50, 1]);

			const bigItems = [
				item(800 * 1024 * 1024, "a.bin"),
				item(800 * 1024 * 1024, "b.bin"),
				item(1, "c.bin"),
			];
			expect(chunk_import_items(bigItems).map((chunk) => chunk.map((chunkItem) => chunkItem.relativePath))).toEqual([
				["a.bin"],
				["b.bin", "c.bin"],
			]);
		});

		test("run_folder_import waits out a rate-limited chunk and counts kept nodes as imported", async () => {
			// First create call is rate-limited, second succeeds. The PUT then fails, but the
			// discard answers `removed: false` (the upload landed after all), so the file must
			// count as imported and not as failed.
			let createCalls = 0;
			const convexStub = {
				query: async () => [],
				mutation: async (_fn: unknown, mutationArgs: Record<string, unknown>) => {
					if ("items" in mutationArgs) {
						createCalls += 1;
						if (createCalls === 1) {
							return { _nay: { name: "nay", message: "Rate limit exceeded", data: { retryAfterMs: 5 } } };
						}
						return {
							_yay: {
								created: [{ relativePath: "a.pdf", nodeId: "node1", url: "https://r2.test/a", headers: {} }],
								skipped: [],
							},
						};
					}
					return { _yay: { removed: false } };
				},
			} as unknown as ConvexReactClient;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(null, { status: 500 })),
			);

			let maxDone = 0;
			let maxFailed = 0;
			const unsubscribe = useFilesImportStore.subscribe((state) => {
				maxDone = Math.max(maxDone, state.done);
				maxFailed = Math.max(maxFailed, state.failed.length);
			});
			try {
				await run_folder_import({
					convex: convexStub,
					membershipId: "membership" as app_convex_Id<"organizations_workspaces_users">,
					parentId: files_ROOT_ID,
					entries: get_import_file_entries([test_file_with_path("a.pdf", "./a.pdf")]),
				});
			} finally {
				unsubscribe();
				vi.unstubAllGlobals();
			}

			expect(createCalls).toBe(2);
			expect(maxDone).toBe(1);
			expect(maxFailed).toBe(0);
			expect(useFilesImportStore.getState().phase).toBe("idle");
		});
	});

	describe("is_inside_tree_selection_area", () => {
		test("keeps marked elements and their descendants inside the selection area", () => {
			const element = document.createElement("div");
			const child = document.createElement("button");
			element.setAttribute("data-files-sidebar-tree-context" satisfies keyof CustomAttributes, "");
			element.append(child);

			expect(is_inside_tree_selection_area(element)).toBe(true);
			expect(is_inside_tree_selection_area(child)).toBe(true);
		});

		test("treats tree whitespace as outside the selection area", () => {
			const treeElement = document.createElement("div");
			const whitespaceChild = document.createElement("div");
			treeElement.className = "FilesSidebarTree" satisfies FilesSidebarTree_ClassNames;
			treeElement.append(whitespaceChild);

			expect(is_inside_tree_selection_area(treeElement)).toBe(false);
			expect(is_inside_tree_selection_area(whitespaceChild)).toBe(false);
		});

		test("treats unrelated sidebar and page elements as outside the selection area", () => {
			const searchInput = document.createElement("input");
			searchInput.className = "FilesSidebarSearch" satisfies FilesSidebarSearch_ClassNames;
			const pageElement = document.createElement("main");

			expect(is_inside_tree_selection_area(searchInput)).toBe(false);
			expect(is_inside_tree_selection_area(pageElement)).toBe(false);
			expect(is_inside_tree_selection_area(null)).toBe(false);
		});
	});

	describe("get_tree_drop_zone", () => {
		test("returns the root drop zone independently from row geometry", () => {
			expect(
				get_tree_drop_zone({
					rows: [],
					activeDropTargetId: null,
					isDraggingOverRootZone: true,
				}),
			).toEqual({ kind: "root" });
			expect(
				get_tree_drop_zone({
					rows: [],
					activeDropTargetId: files_ROOT_ID,
					isDraggingOverRootZone: false,
				}),
			).toEqual({ kind: "root" });
		});

		test("returns no drop zone when nothing valid is targeted", () => {
			const rows = [test_drop_zone_row({ id: "file", kind: "file", depth: 0 })];

			expect(
				get_tree_drop_zone({
					rows,
					activeDropTargetId: null,
					isDraggingOverRootZone: false,
				}),
			).toBeUndefined();
			expect(
				get_tree_drop_zone({
					rows,
					activeDropTargetId: "file",
					isDraggingOverRootZone: false,
				}),
			).toBeUndefined();
		});

		test("covers a folder row and all visible descendants until depth returns", () => {
			const rows = [
				test_drop_zone_row({ id: "folder", kind: "folder", depth: 0 }),
				test_drop_zone_row({ id: "child", kind: "folder", depth: 1 }),
				test_drop_zone_row({ id: "grandchild-file", kind: "file", depth: 2 }),
				test_drop_zone_row({ id: "sibling", kind: "file", depth: 0 }),
			];

			expect(
				get_tree_drop_zone({
					rows,
					activeDropTargetId: "folder",
					isDraggingOverRootZone: false,
				}),
			).toEqual({
				kind: "folder",
				top: "0px",
				height: "135px",
			});
		});

		test("positions nested folder drop zones by their visible row offset", () => {
			const rows = [
				test_drop_zone_row({ id: "folder", kind: "folder", depth: 0 }),
				test_drop_zone_row({ id: "child", kind: "folder", depth: 1 }),
				test_drop_zone_row({ id: "grandchild-file", kind: "file", depth: 2 }),
				test_drop_zone_row({ id: "sibling", kind: "file", depth: 0 }),
			];

			expect(
				get_tree_drop_zone({
					rows,
					activeDropTargetId: "child",
					isDraggingOverRootZone: false,
				}),
			).toEqual({
				kind: "folder",
				top: "45px",
				height: "90px",
			});
		});

		test("includes an expanded empty-folder placeholder in the drop zone height", () => {
			const rows = [
				test_drop_zone_row({ id: "folder", kind: "folder", depth: 0 }),
				test_drop_zone_row({ id: "empty-child", kind: "folder", depth: 1, hasPlaceholderRow: true }),
				test_drop_zone_row({ id: "sibling", kind: "file", depth: 0 }),
			];

			expect(
				get_tree_drop_zone({
					rows,
					activeDropTargetId: "empty-child",
					isDraggingOverRootZone: false,
				}),
			).toEqual({
				kind: "folder",
				top: "45px",
				height: "90px",
			});
		});

		test("treats collapsed folders as a single visible row", () => {
			const rows = [test_drop_zone_row({ id: "folder", kind: "folder", depth: 0 })];

			expect(
				get_tree_drop_zone({
					rows,
					activeDropTargetId: "folder",
					isDraggingOverRootZone: false,
				}),
			).toEqual({
				kind: "folder",
				top: "0px",
				height: "45px",
			});
		});
	});

	describe("get_tree_drop_zone_item_ids", () => {
		test("returns every visible row for the root drop zone", () => {
			const rows = [
				test_drop_zone_row({ id: "folder", kind: "folder", depth: 0 }),
				test_drop_zone_row({ id: "child", kind: "file", depth: 1 }),
				test_drop_zone_row({ id: "sibling", kind: "file", depth: 0 }),
			];

			expect(
				get_tree_drop_zone_item_ids({
					rows,
					activeDropTargetId: null,
					isDraggingOverRootZone: true,
				}),
			).toEqual(new Set(["folder", "child", "sibling"]));
			expect(
				get_tree_drop_zone_item_ids({
					rows,
					activeDropTargetId: files_ROOT_ID,
					isDraggingOverRootZone: false,
				}),
			).toEqual(new Set(["folder", "child", "sibling"]));
		});

		test("returns a folder row and visible descendants until depth returns", () => {
			const rows = [
				test_drop_zone_row({ id: "folder", kind: "folder", depth: 0 }),
				test_drop_zone_row({ id: "child", kind: "folder", depth: 1 }),
				test_drop_zone_row({ id: "grandchild-file", kind: "file", depth: 2 }),
				test_drop_zone_row({ id: "sibling", kind: "file", depth: 0 }),
			];

			expect(
				get_tree_drop_zone_item_ids({
					rows,
					activeDropTargetId: "child",
					isDraggingOverRootZone: false,
				}),
			).toEqual(new Set(["child", "grandchild-file"]));
		});

		test("returns no rows when no valid folder drop target is active", () => {
			const rows = [test_drop_zone_row({ id: "file", kind: "file", depth: 0 })];

			expect(
				get_tree_drop_zone_item_ids({
					rows,
					activeDropTargetId: null,
					isDraggingOverRootZone: false,
				}),
			).toEqual(new Set());
			expect(
				get_tree_drop_zone_item_ids({
					rows,
					activeDropTargetId: "file",
					isDraggingOverRootZone: false,
				}),
			).toEqual(new Set());
		});
	});

	describe("get_tree_drag_hover_state", () => {
		const rows = [
			test_drop_zone_row({ id: "folder-a", kind: "folder", depth: 0 }),
			test_drop_zone_row({ id: "folder-b", parentId: "folder-a", kind: "folder", depth: 1 }),
			test_drop_zone_row({ id: "file-b", parentId: "folder-b", kind: "file", depth: 2 }),
			test_drop_zone_row({ id: "file-root", kind: "file", depth: 0 }),
		];

		const get_external_file_hover_state = (hoveredItemId: string | null) => {
			return get_tree_drag_hover_state({
				rows,
				hasDraggedItems: false,
				isFileDrag: true,
				isExternalFileDrag: true,
				isPointerOverTreeItem: hoveredItemId !== null,
				hoveredItemId,
			});
		};

		test("resolves hovered file rows to their containing folder", () => {
			expect(get_external_file_hover_state("folder-a")).toEqual({
				isDraggingOverRootZone: false,
				activeExternalFileDropTargetId: "folder-a",
			});
			expect(get_external_file_hover_state("folder-b")).toEqual({
				isDraggingOverRootZone: false,
				activeExternalFileDropTargetId: "folder-b",
			});
			expect(get_external_file_hover_state("file-b")).toEqual({
				isDraggingOverRootZone: false,
				activeExternalFileDropTargetId: "folder-b",
			});
			expect(get_external_file_hover_state("file-root")).toEqual({
				isDraggingOverRootZone: true,
				activeExternalFileDropTargetId: null,
			});
			expect(get_external_file_hover_state("unknown-row")).toEqual({
				isDraggingOverRootZone: false,
				activeExternalFileDropTargetId: null,
			});
		});

		test("delegates to Headless Tree for internal tree drags", () => {
			expect(
				get_tree_drag_hover_state({
					rows,
					hasDraggedItems: true,
					isFileDrag: false,
					isExternalFileDrag: false,
					isPointerOverTreeItem: true,
					hoveredItemId: "file-b",
				}),
			).toEqual({
				isDraggingOverRootZone: false,
				activeExternalFileDropTargetId: undefined,
			});
			expect(
				get_tree_drag_hover_state({
					rows,
					hasDraggedItems: true,
					isFileDrag: false,
					isExternalFileDrag: false,
					isPointerOverTreeItem: false,
					hoveredItemId: null,
				}),
			).toEqual({
				isDraggingOverRootZone: true,
				activeExternalFileDropTargetId: undefined,
			});
		});

		test("suppresses stale Headless Tree targets for blocked external file drags", () => {
			expect(
				get_tree_drag_hover_state({
					rows,
					hasDraggedItems: false,
					isFileDrag: true,
					isExternalFileDrag: false,
					isPointerOverTreeItem: true,
					hoveredItemId: "folder-a",
				}),
			).toEqual({
				isDraggingOverRootZone: false,
				activeExternalFileDropTargetId: null,
			});
		});
	});

	describe("get_default_node_name", () => {
		test("ignores archived siblings when picking the next default name", () => {
			const root = files_SYNTHETIC_ROOT_FOLDER;
			const activeFolder = test_node({
				id: "active_folder",
				parentId: files_ROOT_ID,
				kind: "folder",
				name: "new-folder",
			});
			const archivedFolder = test_node({
				id: "archived_folder",
				parentId: files_ROOT_ID,
				kind: "folder",
				name: "new-folder-1",
				archiveOperationId: "archive_operation",
			});
			const treeItems = {
				list: [root, activeFolder, archivedFolder],
				itemsIds: new Set<string>([root._id, activeFolder._id, archivedFolder._id]),
				itemsIdsByParentId: new Map<string, Set<string>>([
					[files_ROOT_ID, new Set<string>([activeFolder._id, archivedFolder._id])],
				]),
				sortedItemsIdsByParentId: new Map<string, string[]>([[files_ROOT_ID, [activeFolder._id, archivedFolder._id]]]),
				itemById: new Map<string, files_TreeItem>([
					[root._id, root],
					[activeFolder._id, activeFolder],
					[archivedFolder._id, archivedFolder],
				]),
			} satisfies TreeItems;

			expect(get_default_node_name({ parentId: files_ROOT_ID, kind: "folder", treeItems })).toBe("new-folder-1");
		});
	});

	describe("get_upload_conflict_modal_state", () => {
		test("treats an exact file conflict as a replace attention state", () => {
			const message = "Choose a different filename or replace the existing file.";

			expect(
				get_upload_conflict_modal_state({
					draft: test_upload_draft({ filename: "report.pdf" }),
					filename: "report.pdf",
				}),
			).toEqual({
				normalizedFilename: "report.pdf",
				invalidFilenameMessage: undefined,
				pathConflictMessage: message,
				helperText: message,
				showReplace: true,
				showAttentionState: true,
				uploadBlockingMessage: message,
			});
		});

		test("switches to upload when the conflicting file is renamed", () => {
			expect(
				get_upload_conflict_modal_state({
					draft: test_upload_draft({ filename: "report.pdf" }),
					filename: "Report Copy.PDF",
				}),
			).toEqual({
				normalizedFilename: "report-copy.pdf",
				invalidFilenameMessage: undefined,
				pathConflictMessage: undefined,
				helperText: "This file will be uploaded with the specified filename.",
				showReplace: false,
				showAttentionState: false,
				uploadBlockingMessage: undefined,
			});
		});

		test("keeps missing upload extensions as native invalid input", () => {
			const message = "Uploaded files must include a file extension.";

			expect(
				get_upload_conflict_modal_state({
					draft: test_upload_draft({ filename: "report", reason: "missing_extension" }),
					filename: "report",
				}),
			).toEqual({
				normalizedFilename: "report",
				invalidFilenameMessage: message,
				pathConflictMessage: undefined,
				helperText: message,
				showReplace: false,
				showAttentionState: false,
				uploadBlockingMessage: message,
			});
		});

		test("blocks folder conflicts without offering replace", () => {
			const message = "Choose a different filename.";

			expect(
				get_upload_conflict_modal_state({
					draft: test_upload_draft({ filename: "report.pdf", conflictKind: "folder" }),
					filename: "report.pdf",
				}),
			).toEqual({
				normalizedFilename: "report.pdf",
				invalidFilenameMessage: undefined,
				pathConflictMessage: message,
				helperText: message,
				showReplace: false,
				showAttentionState: true,
				uploadBlockingMessage: message,
			});
		});
	});

	describe("get_uploaded_file_rename_validation", () => {
		test("normalizes upload file names while preserving the extension", () => {
			expect(
				get_uploaded_file_rename_validation({
					treeItemsList: undefined,
					parentId: files_ROOT_ID,
					nameOrPath: "Annual Report 2026.PDF",
				}),
			).toMatchObject({
				normalizedName: "annual-report-2026.pdf",
				validationMessage: null,
			});
		});

		test("requires an uploaded file extension", () => {
			for (const nameOrPath of ["file", "file."]) {
				expect(
					get_uploaded_file_rename_validation({
						treeItemsList: undefined,
						parentId: files_ROOT_ID,
						nameOrPath,
					}),
				).toMatchObject({
					normalizedName: null,
					validationMessage: "Uploaded files must include a file extension.",
				});
			}
		});

		test("detects nested upload conflicts through existing folders", () => {
			const root = files_SYNTHETIC_ROOT_FOLDER;
			const folder = test_node({
				id: "folder_docs",
				parentId: files_ROOT_ID,
				kind: "folder",
				name: "docs",
			});
			const file = test_node({
				id: "file_report",
				parentId: folder._id,
				kind: "file",
				name: "report.pdf",
				path: "/docs/report.pdf",
			});

			expect(
				get_uploaded_file_rename_validation({
					treeItemsList: [root, folder, file],
					parentId: files_ROOT_ID,
					nameOrPath: "docs/report.pdf",
				}),
			).toMatchObject({
				normalizedName: "docs/report.pdf",
				validationMessage: "This file already exists.",
			});
		});

		test("ignores the file currently being renamed", () => {
			const root = files_SYNTHETIC_ROOT_FOLDER;
			const folder = test_node({
				id: "folder_docs",
				parentId: files_ROOT_ID,
				kind: "folder",
				name: "docs",
			});
			const file = test_node({
				id: "file_report",
				parentId: folder._id,
				kind: "file",
				name: "report.pdf",
				path: "/docs/report.pdf",
			});

			expect(
				get_uploaded_file_rename_validation({
					treeItemsList: [root, folder, file],
					nodeIdToIgnore: file._id,
					parentId: folder._id,
					nameOrPath: "report.pdf",
				}),
			).toMatchObject({
				normalizedName: "report.pdf",
				validationMessage: null,
			});
		});
	});

	describe("sort_children", () => {
		test("sorts folders before files with case-insensitive numeric name ordering", () => {
			const folderAlpha = test_node({
				id: "folder_alpha",
				parentId: files_ROOT_ID,
				kind: "folder",
				name: "Alpha",
			});
			const folderBeta = test_node({
				id: "folder_beta",
				parentId: files_ROOT_ID,
				kind: "folder",
				name: "beta",
			});
			const fileTwo = test_node({
				id: "file_two",
				parentId: files_ROOT_ID,
				kind: "file",
				name: "File-2.md",
			});
			const fileTen = test_node({
				id: "file_ten",
				parentId: files_ROOT_ID,
				kind: "file",
				name: "file-10.md",
			});

			expect(
				sort_children({
					children: [fileTen._id, folderBeta._id, fileTwo._id, folderAlpha._id],
					itemById: new Map<string, files_TreeItem>([
						[fileTen._id, fileTen],
						[folderBeta._id, folderBeta],
						[fileTwo._id, fileTwo],
						[folderAlpha._id, folderAlpha],
					]),
				}),
			).toEqual([folderAlpha._id, folderBeta._id, fileTwo._id, fileTen._id]);
		});

		test("keeps visible child order that raw treePath order does not provide", () => {
			const folderTwo = test_node({
				id: "folder_two",
				parentId: files_ROOT_ID,
				kind: "folder",
				name: "file-2",
			});
			const folderTen = test_node({
				id: "folder_ten",
				parentId: files_ROOT_ID,
				kind: "folder",
				name: "file-10",
			});
			const fileTwo = test_node({
				id: "file_two",
				parentId: files_ROOT_ID,
				kind: "file",
				name: "file-2.md",
			});
			const fileTen = test_node({
				id: "file_ten",
				parentId: files_ROOT_ID,
				kind: "file",
				name: "file-10.md",
			});
			const folderReport = test_node({
				id: "folder_report",
				parentId: files_ROOT_ID,
				kind: "folder",
				name: "report",
			});
			const fileReport = test_node({
				id: "file_report",
				parentId: files_ROOT_ID,
				kind: "file",
				name: "report.md",
			});
			const items = [folderTwo, folderTen, fileTwo, fileTen, folderReport, fileReport];
			const itemById = new Map<string, files_TreeItem>(items.map((item) => [item._id, item]));
			const treePathOrder = [...items].sort((left, right) => left.treePath.localeCompare(right.treePath));

			expect(treePathOrder.map((item) => item._id)).not.toEqual(
				sort_children({
					children: items.map((item) => item._id),
					itemById,
				}),
			);
		});
	});

	describe("files_sidebar_parse_search_query", () => {
		test("treats a plain word as a name query", () => {
			expect(parse_search_query("  API.md ")).toEqual({ mode: "name", value: "api.md" });
		});

		test("treats anything with a slash as a path query", () => {
			expect(parse_search_query("/Docs/api.md")).toEqual({ mode: "path", value: "/docs/api.md" });
			expect(parse_search_query("docs/api")).toEqual({ mode: "path", value: "docs/api" });
		});

		test("treats a long lowercase alphanumeric string as a node id query", () => {
			expect(parse_search_query("k5701abcdefghijklmnop")).toEqual({
				mode: "node",
				value: "k5701abcdefghijklmnop",
			});
		});

		test("unwraps a pasted node-id link", () => {
			expect(parse_search_query("http://localhost:5173/w/acme/main/files?nodeId=k5701abc&view=diff_editor")).toEqual({
				mode: "node",
				value: "k5701abc",
			});
		});

		test("unwraps a pasted path link and decodes its segments", () => {
			expect(parse_search_query("https://app.test/w/acme/main/files/Docs/api%20notes.md")).toEqual({
				mode: "path",
				value: "/docs/api notes.md",
			});
		});

		test("leaves a link that carries no file reference as a path query that matches nothing", () => {
			expect(parse_search_query("https://app.test/w/acme/main/chat")).toEqual({
				mode: "path",
				value: "https://app.test/w/acme/main/chat",
			});
		});
	});

	describe("get_tree_items_list_after_optimistic_rename", () => {
		test("updates only the DB doc fields for simple renames", () => {
			const root = files_SYNTHETIC_ROOT_FOLDER;
			const file = test_node({
				id: "file_1",
				parentId: files_ROOT_ID,
				kind: "file",
				name: "draft.md",
			});
			const result = get_tree_items_list_after_optimistic_rename({
				treeItemsList: [root, file],
				itemId: file._id,
				normalizedName: "plan.md",
				now: 10,
			});

			expect(result).toEqual([root, { ...file, name: "plan.md", path: "/plan.md", updatedAt: 10 }]);
		});

		test("returns the original list when the node is missing", () => {
			const root = files_SYNTHETIC_ROOT_FOLDER;
			const file = test_node({
				id: "file_1",
				parentId: files_ROOT_ID,
				kind: "file",
				name: "draft.md",
			});
			const treeItemsList = [root, file];
			const result = get_tree_items_list_after_optimistic_rename({
				treeItemsList: [root, file],
				itemId: "missing",
				normalizedName: "plan.md",
				now: 10,
			});

			expect(result).toEqual(treeItemsList);
		});
	});
}
// #endregion tests
