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
	Folder,
	FolderPlus,
	Search,
	Upload,
	X,
	CopyMinus,
	CopyPlus,
} from "lucide-react";
import { useConvex, useQueries, useQuery } from "convex/react";
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
	MyMenuTrigger,
	type MyMenuItem_Props,
} from "@/components/my-menu.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
} from "@/components/my-modal.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import {
	cn,
	copy_to_clipboard,
	forward_ref,
	path_extract_segments_from,
	should_never_happen,
	sx,
} from "@/lib/utils.ts";
import { app_convex_api, type app_convex_Doc, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { dom_clear_text_selection } from "@/lib/dom-utils.ts";
import { Result } from "@/lib/errors-as-values-utils.ts";
import { useGlobalEventList } from "@/lib/global-event.tsx";
import { useDebounce, useFn, useVal } from "@/hooks/utils-hooks.ts";
import {
	files_ROOT_ID,
	files_SYNTHETIC_ROOT_FOLDER,
	files_FILE_NODE_DRAG_DATA_TRANSFER_TYPE,
	files_clear_node_path_cached_validation_messages,
	files_create_tree_items_list_from_nodes,
	files_find_file_stem_end_index,
	files_get_default_node_name,
	files_get_node_path_validation,
	files_is_node,
	files_normalize_name_input,
	files_normalize_name,
	files_normalize_markdown_name,
	files_normalize_upload_file_name,
	type files_ContentType,
	type files_EditorView,
	type files_TreeItem,
	type files_VisibleTreeNode,
} from "@/lib/files.ts";
import { format_relative_time } from "@/lib/date.ts";

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
		const scale = Math.min(1, IMAGE_UPLOAD_COMPRESSION_MAX_DIMENSION_PX / Math.max(imageBitmap.width, imageBitmap.height));
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

// #region tree item icon
type FilesSidebarTreeItemIcon_ClassNames = "FilesSidebarTreeItemIcon";

type FilesSidebarTreeItemIcon_Props = {
	kind: files_TreeItem["kind"];
};

const FilesSidebarTreeItemIcon = memo(function FilesSidebarTreeItemIcon(props: FilesSidebarTreeItemIcon_Props) {
	const { kind } = props;
	return (
		<MyIcon className={"FilesSidebarTreeItemIcon" satisfies FilesSidebarTreeItemIcon_ClassNames}>
			{kind === "folder" ? <Folder /> : <FileText />}
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
type FilesSidebarTreeItemMoreAction_ClassNames =
	| "FilesSidebarTreeItemMoreAction"
	| "FilesSidebarTreeItemMoreAction-menu-create-action"
	| "FilesSidebarTreeItemMoreAction-menu-create-action-visible";

type FilesSidebarTreeItemMoreAction_Props = {
	kind: files_TreeItem["kind"];
	label: string;
	archiveOperationId: string | undefined;
	isPending: boolean;
	isFocused: boolean;
	canRename: boolean;
	canExpandSubtree: boolean;
	canCollapseSubtree: boolean;
	expandedFolderActionsVisible: boolean;
	onCreateFile: () => void;
	onCreateFolder: () => void;
	onCopy: () => void;
	onRename: () => void;
	onExpandSubtree: () => void;
	onCollapseSubtree: () => void;
	onArchive: () => void;
	onUnarchive: () => void;
};

const FilesSidebarTreeItemMoreAction = memo(function FilesSidebarTreeItemMoreAction(
	props: FilesSidebarTreeItemMoreAction_Props,
) {
	const {
		kind,
		label,
		archiveOperationId,
		isPending,
		isFocused,
		canRename,
		canExpandSubtree,
		canCollapseSubtree,
		expandedFolderActionsVisible,
		onCreateFile,
		onCreateFolder,
		onCopy,
		onRename,
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
		<MyMenu>
			<MyMenuTrigger tabIndex={isFocused ? 0 : -1}>
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
			</MyMenuTrigger>
			<MyMenuPopover
				{...({
					"data-files-sidebar-tree-context": "",
				} satisfies Partial<CustomAttributes>)}
				unmountOnHide
			>
				<MyMenuPopoverContent>
					{kind === "folder" ? (
						<MyMenuItemsGroup>
							<MyMenuItem
								className={cn(
									"FilesSidebarTreeItemMoreAction-menu-create-action" satisfies FilesSidebarTreeItemMoreAction_ClassNames,
									expandedFolderActionsVisible &&
										("FilesSidebarTreeItemMoreAction-menu-create-action-visible" satisfies FilesSidebarTreeItemMoreAction_ClassNames),
								)}
								aria-label={`Add file to ${label}`}
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
									"FilesSidebarTreeItemMoreAction-menu-create-action" satisfies FilesSidebarTreeItemMoreAction_ClassNames,
									expandedFolderActionsVisible &&
										("FilesSidebarTreeItemMoreAction-menu-create-action-visible" satisfies FilesSidebarTreeItemMoreAction_ClassNames),
								)}
								aria-label={`Add folder to ${label}`}
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
					<MyMenuItemsGroup separator={kind === "folder"}>
						<MyMenuItem hideOnClick onClick={onCopy}>
							<MyMenuItemContent>
								<MyMenuItemContentIcon>
									<Copy />
								</MyMenuItemContentIcon>
								<MyMenuItemContentPrimary>Copy path</MyMenuItemContentPrimary>
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
						<MyMenuItem
							variant={isArchived ? "default" : "destructive"}
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
			</MyMenuPopover>
		</MyMenu>
	);
});
// #endregion tree item more action

// #region tree item arrow
type FilesSidebarTreeItemArrow_ClassNames = "FilesSidebarTreeItemArrow" | "FilesSidebarTreeItemArrow-icon-button";

type FilesSidebarTreeItemArrow_Props = {
	label: string;
	isExpanded: boolean;
	isPending: boolean;
	isFocused: boolean;
	onClick: () => void;
};

const FilesSidebarTreeItemArrow = memo(function FilesSidebarTreeItemArrow(props: FilesSidebarTreeItemArrow_Props) {
	const { label, isExpanded, isPending, isFocused, onClick } = props;
	const actionLabel = isExpanded ? "Collapse folder" : "Expand folder";

	return (
		<div className={"FilesSidebarTreeItemArrow" satisfies FilesSidebarTreeItemArrow_ClassNames}>
			<MyIconButton
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
function get_protected_markdown_extension_start(args: {
	kind: files_TreeItem["kind"];
	value: string;
	selectionStart: number;
	selectionEnd: number;
}) {
	// Locate the storage extension so live basename edits can ignore the protected suffix.
	const extensionStart = args.value.length - ".md".length;
	if (
		args.kind === "file" &&
		args.value.endsWith(".md") &&
		args.selectionStart <= extensionStart &&
		args.selectionEnd <= extensionStart
	) {
		// Ignore `.md` separator adjacency when the edit is fully inside the basename.
		return extensionStart;
	}

	// Normalize edits that touch the extension against the full remaining value.
	return args.value.length;
}

function normalize_rename_input_value(args: { kind: files_TreeItem["kind"]; value: string }) {
	if (args.kind === "file" && args.value.endsWith(".md")) {
		// Preserve the protected Markdown extension and sanitize only the editable basename.
		const extensionStart = args.value.length - ".md".length;
		return `${files_normalize_name_input({
			kind: args.kind,
			previousText: "",
			insertedText: args.value.slice(0, extensionStart),
			nextText: "",
		})}.md`;
	}

	// Sanitize the whole current value for folders and non-canonical file drafts.
	return files_normalize_name_input({
		kind: args.kind,
		previousText: "",
		insertedText: args.value,
		nextText: "",
	});
}

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

	const syncRenameInputValue = useFn((element: HTMLInputElement, nextValue: string, nextSelectionStart?: number) => {
		if (element.value !== nextValue) {
			// Update the DOM immediately because beforeinput/paste handlers prevent the browser default.
			element.value = nextValue;
		}

		// Mirror the same value into Headless Tree's controlled renaming state.
		renameInputProps.onChange({ target: { value: nextValue } });

		if (nextSelectionStart === undefined) {
			return;
		}

		queueMicrotask(() => {
			if (document.activeElement !== element) {
				return;
			}

			// Restore the caret after React and Headless Tree have reconciled the controlled value.
			const safeSelectionStart = Math.min(nextSelectionStart, element.value.length);
			element.setSelectionRange(safeSelectionStart, safeSelectionStart);
		});
	});

	const replaceRenameInputSelection = useFn((element: HTMLInputElement, insertedText: string) => {
		// Read the current selection so typed and pasted text replace the same range natively.
		const selectionStart = element.selectionStart ?? element.value.length;
		const selectionEnd = element.selectionEnd ?? element.value.length;
		const nextTextEnd = get_protected_markdown_extension_start({
			kind,
			value: element.value,
			selectionStart,
			selectionEnd,
		});
		const replacementEnd =
			kind === "file" && selectionEnd === nextTextEnd && insertedText.includes(".")
				? element.value.length
				: selectionEnd;
		// Let full file names such as `foo/bar.md` replace the protected `.md` instead of appending another suffix.
		// Normalize only the inserted fragment, using the surrounding text for separator adjacency.
		const normalizedInsertedText = files_normalize_name_input({
			kind,
			previousText: element.value.slice(0, selectionStart),
			insertedText,
			nextText: element.value.slice(selectionEnd, nextTextEnd),
		});
		// Rebuild the full control value with the sanitized replacement.
		const nextValue =
			element.value.slice(0, selectionStart) + normalizedInsertedText + element.value.slice(replacementEnd);
		if (nextValue === element.value) {
			return;
		}

		// Place the caret at the end of the inserted normalized fragment.
		syncRenameInputValue(element, nextValue, selectionStart + normalizedInsertedText.length);
	});

	const applyRenameInputToControl = useFn((element: HTMLInputElement) => {
		// Preserve the current caret as closely as possible when the fallback sanitizer rewrites the value.
		const selectionStart = element.selectionStart ?? element.value.length;
		const nextValue = normalize_rename_input_value({
			kind,
			value: element.value,
		});

		// Push the fully sanitized fallback value into both DOM and Headless Tree state.
		syncRenameInputValue(element, nextValue, selectionStart);
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

	const handleRenameInputBeforeInput = useFn<NonNullable<ComponentProps<"input">["onBeforeInput"]>>((event) => {
		if (!isRenaming) {
			return;
		}

		const nativeEvent = event.nativeEvent as InputEvent;
		if (nativeEvent.isComposing) {
			// Wait for compositionend so IME text normalizes as one completed fragment.
			return;
		}

		const insertedText = nativeEvent.data;
		if (insertedText == null || insertedText === "") {
			// Let non-text beforeinput operations such as deletion use the normal input path.
			return;
		}

		// Replace the browser insertion with our sanitized insertion.
		event.preventDefault();
		clearRenameInputError(event.currentTarget);
		replaceRenameInputSelection(event.currentTarget, insertedText);
	});

	const handleRenameInputPaste = useFn<NonNullable<ComponentProps<"input">["onPaste"]>>((event) => {
		const pastedText = event.clipboardData.getData("text/plain");
		if (pastedText === "") {
			return;
		}

		// Route pasted text through the same insertion helper because it can contain many characters.
		event.preventDefault();
		clearRenameInputError(event.currentTarget);
		replaceRenameInputSelection(event.currentTarget, pastedText);
	});

	const handleRenameInputCompositionEnd = useFn<NonNullable<ComponentProps<"input">["onCompositionEnd"]>>((event) => {
		// Sanitize the whole control after composition mutates the real input.
		clearRenameInputError(event.currentTarget);
		applyRenameInputToControl(event.currentTarget);
	});

	const handleRenameInputChange = useFn<NonNullable<ComponentProps<"input">["onChange"]>>((event) => {
		// Keep onChange as a fallback for browser paths not covered by beforeinput or paste.
		clearRenameInputError(event.currentTarget);
		applyRenameInputToControl(event.currentTarget);
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

	// Keep `.md` outside the initial edit range so ordinary renames preserve the file type.
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
			const selectionEnd =
				kind === "file" ? files_find_file_stem_end_index({ fileName: inputElement.value }) : inputElement.value.length;
			if (selectionEnd > 0 && selectionEnd < inputElement.value.length) {
				inputElement.setSelectionRange(0, selectionEnd);
				return;
			}

			inputElement.select();
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
					<MyInputControl
						{...(isRenaming ? renameInputProps : null)}
						ref={handleRenameInputRef}
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
						onBeforeInput={isRenaming ? handleRenameInputBeforeInput : undefined}
						onChange={isRenaming ? handleRenameInputChange : undefined}
						onCompositionEnd={isRenaming ? handleRenameInputCompositionEnd : undefined}
						onPaste={isRenaming ? handleRenameInputPaste : undefined}
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
	renameError: string | undefined;
	onRenameErrorClear: () => void;
};

const FilesSidebarTreeItemPrimaryContent = memo(function FilesSidebarTreeItemPrimaryContent(
	props: FilesSidebarTreeItemPrimaryContent_Props,
) {
	const { title, kind, renameInputProps, isRenaming, renameError, onRenameErrorClear } = props;

	return (
		<div className={"FilesSidebarTreeItemPrimaryContent" satisfies FilesSidebarTreeItemPrimaryContent_ClassNames}>
			<FilesSidebarTreeItemIcon kind={kind} />
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
	updatedAt: files_TreeItem["updatedAt"];
	updatedByDisplayName: string;
	isPending: boolean;
	isSelected: boolean;
	isDropZoneIncluded: boolean;
	isTreeDragging: boolean;
	isFocused: boolean;
	ariaLabel: string;
};

const FilesSidebarTreeItemPrimaryAction = memo(function FilesSidebarTreeItemPrimaryAction(
	props: FilesSidebarTreeItemPrimaryAction_Props,
) {
	const {
		itemProps,
		updatedAt,
		updatedByDisplayName,
		isPending,
		isSelected,
		isDropZoneIncluded,
		isTreeDragging,
		isFocused,
		ariaLabel,
	} = props;

	const tooltipContent = `Updated ${format_relative_time(updatedAt, { prefixForDatesPast7Days: "the " })} by ${updatedByDisplayName}`;

	return (
		<MyPrimaryAction
			{...itemProps}
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
	| "FilesSidebarTreeItemSecondaryContent-text";

type FilesSidebarTreeItemSecondaryContent_Props = {
	secondaryText: string;
};

const FilesSidebarTreeItemSecondaryContent = memo(function FilesSidebarTreeItemSecondaryContent(
	props: FilesSidebarTreeItemSecondaryContent_Props,
) {
	const { secondaryText } = props;

	return (
		<div className={"FilesSidebarTreeItemSecondaryContent" satisfies FilesSidebarTreeItemSecondaryContent_ClassNames}>
			<div
				className={
					"FilesSidebarTreeItemSecondaryContent-text" satisfies FilesSidebarTreeItemSecondaryContent_ClassNames
				}
			>
				{secondaryText}
			</div>
		</div>
	);
});
// #endregion tree item secondary content

// #region tree item actions
type FilesSidebarTreeItemActions_ClassNames = "FilesSidebarTreeItemActions";

type FilesSidebarTreeItemActions_Props = {
	kind: FilesSidebarTreeItemMoreAction_Props["kind"];
	label: string;
	archiveOperationId: FilesSidebarTreeItemMoreAction_Props["archiveOperationId"];
	isPending: boolean;
	isFocused: boolean;
	canCreateChildren: boolean;
	canRename: FilesSidebarTreeItemMoreAction_Props["canRename"];
	canExpandSubtree: FilesSidebarTreeItemMoreAction_Props["canExpandSubtree"];
	canCollapseSubtree: FilesSidebarTreeItemMoreAction_Props["canCollapseSubtree"];
	expandedFolderActionsVisible: FilesSidebarTreeItemMoreAction_Props["expandedFolderActionsVisible"];
	onCreateFile: FilesSidebarTreeItemSecondaryAction_Props["onClick"];
	onCreateFolder: FilesSidebarTreeItemSecondaryAction_Props["onClick"];
	onCopy: FilesSidebarTreeItemMoreAction_Props["onCopy"];
	onRename: FilesSidebarTreeItemMoreAction_Props["onRename"];
	onExpandSubtree: FilesSidebarTreeItemMoreAction_Props["onExpandSubtree"];
	onCollapseSubtree: FilesSidebarTreeItemMoreAction_Props["onCollapseSubtree"];
	onArchive: FilesSidebarTreeItemMoreAction_Props["onArchive"];
	onUnarchive: FilesSidebarTreeItemMoreAction_Props["onUnarchive"];
};

const FilesSidebarTreeItemActions = memo(function FilesSidebarTreeItemActions(
	props: FilesSidebarTreeItemActions_Props,
) {
	const {
		kind,
		label,
		archiveOperationId,
		isPending,
		isFocused,
		canCreateChildren,
		canRename,
		canExpandSubtree,
		canCollapseSubtree,
		expandedFolderActionsVisible,
		onCreateFile,
		onCreateFolder,
		onCopy,
		onRename,
		onExpandSubtree,
		onCollapseSubtree,
		onArchive,
		onUnarchive,
	} = props;

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
						disabled={isPending}
						onClick={onCreateFile}
					/>
					<FilesSidebarTreeItemSecondaryActionCreateFile
						kind="folder"
						label={label}
						isActive={isFocused}
						disabled={isPending}
						onClick={onCreateFolder}
					/>
				</>
			) : null}
			<FilesSidebarTreeItemMoreAction
				kind={kind}
				label={label}
				archiveOperationId={archiveOperationId}
				isPending={isPending}
				isFocused={isFocused}
				canRename={canRename}
				canExpandSubtree={canExpandSubtree}
				canCollapseSubtree={canCollapseSubtree}
				expandedFolderActionsVisible={expandedFolderActionsVisible}
				onCreateFile={onCreateFile}
				onCreateFolder={onCreateFolder}
				onCopy={onCopy}
				onRename={onRename}
				onExpandSubtree={onExpandSubtree}
				onCollapseSubtree={onCollapseSubtree}
				onArchive={onArchive}
				onUnarchive={onUnarchive}
			/>
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
	expandedFolderActionsVisible: boolean;
	onCreateNode: (parentNodeId: string, kind: files_TreeItem["kind"]) => void;
	onStartRename: (itemId: string) => void;
	onRenameErrorClear: (itemId: string) => void;
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
		expandedFolderActionsVisible,
		onCreateNode,
		onStartRename,
		onRenameErrorClear,
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
	const canRename = files_is_node(itemData);

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

	const updatedByDisplayName = displayNameByUserId.get(itemData.updatedBy) ?? "Unknown";
	const metaText = `${format_relative_time(itemData.updatedAt)} · ${updatedByDisplayName}`;
	const shouldRenderPlaceholder = !isSearchActive && itemData.kind === "folder" && !hasChildren && isExpanded;
	const label = isArchived ? `${itemData.name} archived` : itemData.name;

	const handleCreateFileClick = useFn<FilesSidebarTreeItemSecondaryAction_Props["onClick"]>(() => {
		onCreateNode(itemId, "file");
	});

	const handleCreateFolderClick = useFn<FilesSidebarTreeItemSecondaryAction_Props["onClick"]>(() => {
		onCreateNode(itemId, "folder");
	});

	const handleCopyClick = useFn<FilesSidebarTreeItemMoreAction_Props["onCopy"]>(() => {
		copy_to_clipboard({ text: itemData.path }).catch((error) => {
			console.error("[FilesSidebarTreeItem.handleCopyClick] Failed to copy path", { error, itemId });
		});
	});

	const handleRenameClick = useFn<FilesSidebarTreeItemMoreAction_Props["onRename"]>(() => {
		onStartRename(itemId);
	});

	const handleRenameErrorClear = useFn(() => {
		onRenameErrorClear(itemId);
	});

	const handleExpandSubtreeClick = useFn<FilesSidebarTreeItemMoreAction_Props["onExpandSubtree"]>(() => {
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

	const handleCollapseSubtreeClick = useFn<FilesSidebarTreeItemMoreAction_Props["onCollapseSubtree"]>(() => {
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

	const handleArchiveClick = useFn<FilesSidebarTreeItemMoreAction_Props["onArchive"]>(() => {
		onArchive(itemId);
	});

	const handleUnarchiveClick = useFn<FilesSidebarTreeItemMoreAction_Props["onUnarchive"]>(() => {
		onUnarchive(itemId);
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

	const handleExternalFileDragOverCapture = useFn<ComponentProps<"div">["onDragOverCapture"]>((event) => {
		if (itemData.kind !== "file" || !has_file_drop(event.dataTransfer)) {
			return;
		}

		// Keep external file drops from being reparented to the file's parent by Headless Tree's sibling fallback.
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "none";
	});

	const handleExternalFileDropCapture = useFn<ComponentProps<"div">["onDropCapture"]>((event) => {
		if (itemData.kind !== "file" || !has_file_drop(event.dataTransfer)) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = "none";
		toast.error("Drop files onto a folder or the root.");
	});

	return (
		<>
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
				onDragOverCapture={handleExternalFileDragOverCapture}
				onDropCapture={handleExternalFileDropCapture}
			>
				<FilesSidebarTreeItemPrimaryAction
					itemProps={itemProps}
					updatedAt={itemData.updatedAt}
					updatedByDisplayName={updatedByDisplayName}
					isPending={isPending}
					isSelected={isSelected}
					isDropZoneIncluded={isDropZoneIncluded}
					isTreeDragging={isTreeDragging}
					isFocused={isFocused}
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
					renameError={renameError}
					onRenameErrorClear={handleRenameErrorClear}
				/>

				{itemData.kind === "folder" ? (
					<FilesSidebarTreeItemArrow
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

				<FilesSidebarTreeItemSecondaryContent secondaryText={metaText} />

				<FilesSidebarTreeItemActions
					kind={itemData.kind}
					label={label}
					archiveOperationId={itemData.archiveOperationId}
					isPending={isPending}
					isFocused={isFocused}
					canCreateChildren={itemData.kind === "folder"}
					canRename={canRename}
					canExpandSubtree={canExpandSubtree}
					canCollapseSubtree={canCollapseSubtree}
					expandedFolderActionsVisible={expandedFolderActionsVisible}
					onCreateFile={handleCreateFileClick}
					onCreateFolder={handleCreateFolderClick}
					onCopy={handleCopyClick}
					onRename={handleRenameClick}
					onExpandSubtree={handleExpandSubtreeClick}
					onCollapseSubtree={handleCollapseSubtreeClick}
					onArchive={handleArchiveClick}
					onUnarchive={handleUnarchiveClick}
				/>

				{isNavigated ? (
					<div
						className={"FilesSidebarTreeItemNavigatedRail" satisfies FilesSidebarTreeItem_ClassNames}
						aria-hidden="true"
					/>
				) : null}
			</div>

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
	if (args.isDraggingOverRootZone) {
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
	if (args.isDraggingOverRootZone) {
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
	return {
		isDraggingOverRootZone: false,
		activeExternalFileDropTargetId: hoveredRow?.kind === "folder" ? hoveredRow.id : null,
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
		onArchive,
		onUnarchive,
	} = props;

	const treeContainerProps = tree().getContainerProps("files_nodes");
	const { ref: treeContainerRef, ...treeContainerRest } = treeContainerProps;

	const [expandedFolderActionsVisible, setExpandedFolderActionsVisible] = useState(false);

	const isTreeDragging = (tree().getState().dnd?.draggedItems?.length ?? 0) > 0;
	const renderedTreeItems = tree().getItems();

	const treeRootElementRef = useRef<HTMLDivElement | null>(null);
	const treeRootResizeObserverRef = useRef<ResizeObserver | null>(null);

	const [isDraggingOverRootZone, setIsDraggingOverRootZone] = useState(false);
	const isDraggingOverRootZoneRef = useRef(false);
	// Use undefined to fall back to Headless Tree, and null to suppress stale targets over invalid file rows.
	const [activeExternalFileDropTargetId, setActiveExternalFileDropTargetId] = useState<string | null | undefined>(
		undefined,
	);

	const activeExternalFileDropTargetIdRef = useRef<string | null | undefined>(undefined);
	const headlessActiveDropTargetId = tree().getState().dnd?.draggingOverItem?.getId() ?? null;
	const activeDropTargetId =
		activeExternalFileDropTargetId === undefined ? headlessActiveDropTargetId : activeExternalFileDropTargetId;
	const dropZoneRows = renderedTreeItems.map((item) => {
		const itemData = item.getItemData();

		return {
			id: item.getId(),
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
					{renderedTreeItems.map((item) => {
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
								expandedFolderActionsVisible={expandedFolderActionsVisible}
								onCreateNode={onCreateNode}
								onStartRename={onStartRename}
								onRenameErrorClear={onRenameErrorClear}
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
	onSearchQueryChange: (searchQuery: string) => void;
};

const FilesSidebarSearch = memo(function FilesSidebarSearch(props: FilesSidebarSearch_Props) {
	const { onSearchQueryChange } = props;

	const [searchQuery, setSearchQuery] = useState("");
	const searchQueryDebounced = useDebounce(searchQuery, 300);

	const handleInputChange = useFn<ComponentProps<typeof MyInputControl>["onChange"]>((event) => {
		setSearchQuery(event.target.value);
	});

	useEffect(() => {
		onSearchQueryChange(searchQueryDebounced);
	}, [searchQueryDebounced]);

	return (
		<MyInput className={cn("FilesSidebarSearch" satisfies FilesSidebarSearch_ClassNames)}>
			<MyInputBackground />
			<MyInputArea>
				<MyInputIcon>
					<Search />
				</MyInputIcon>
				<MyInputControl placeholder="Search files" value={searchQuery} onChange={handleInputChange} />
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

	const { workspaceName, projectName } = AppTenantProvider.useContext();

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
							to="/w/$workspaceName/$projectName/files"
							params={{ workspaceName, projectName }}
							search={{ nodeId: files_ROOT_ID, view }}
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
		<MyMenu>
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
				placement="bottom-end"
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
	onClose: () => void;
	onSearchQueryChange: (searchQuery: string) => void;
	onExpandTopFilesClick: () => void;
	onCollapseAllClick: () => void;
	onClearSelectionClick: () => void;
	onCreateRootFileClick: () => void;
	onCreateRootFolderClick: () => void;
	onArchiveToggleClick: () => void;
	onArchiveSelectionClick: () => void;
	onUploadFileClick: () => void;
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
		onClose,
		onSearchQueryChange,
		onExpandTopFilesClick,
		onCollapseAllClick,
		onClearSelectionClick,
		onCreateRootFileClick,
		onCreateRootFolderClick,
		onArchiveToggleClick,
		onArchiveSelectionClick,
		onUploadFileClick,
	} = props;

	const archivedCount =
		treeItemsList?.filter((item) => files_is_node(item) && item.archiveOperationId !== undefined).length ?? 0;

	return (
		<div className={cn("FilesSidebarTopSection" satisfies FilesSidebarTopSection_ClassNames)}>
			<FilesSidebarHeader view={view} onClose={onClose} />

			<FilesSidebarSearch onSearchQueryChange={onSearchQueryChange} />

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
								variant="secondary"
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

	useEffect(() => {
		setFilename(draft?.filename ?? "");
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

	const handleFilenameChange = useFn<ComponentProps<typeof MyInputControl>["onChange"]>((event) => {
		setFilename(event.currentTarget.value);
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
							className={cn(
								showAttentionState &&
									("FilesSidebarUploadConflictModal-name-field-state-attention" satisfies FilesSidebarUploadConflictModal_ClassNames),
							)}
							displayValidationMessage={invalidFilenameMessage}
						>
							<MyInputBackground />
							<MyInputArea>
								<MyInputControl
									autoFocus
									aria-label="Filename"
									autoComplete="off"
									value={filename}
									disabled={isUploading}
									validationMessage={invalidFilenameMessage}
									onChange={handleFilenameChange}
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

async function get_single_dropped_file(dataTransfer: DataTransfer) {
	if (!has_file_drop(dataTransfer)) {
		return Result({ _nay: { name: "nay", message: "Drop a file to upload." } });
	}

	let files: FileWithPath[];
	try {
		const droppedItems = await fromEvent({ dataTransfer, type: "drop" });
		files = droppedItems.filter((item): item is FileWithPath => item instanceof File);
	} catch (error) {
		console.error("[FilesSidebar.getSingleDroppedFile] Failed to read dropped file", { error });
		return Result({ _nay: { name: "nay", message: "Failed to read dropped file.", cause: error } });
	}

	if (
		files.some((file) => {
			const plainFilePath = `./${file.name}`;

			// Treat any file-selector path beyond the bare file name as a nested directory drop.
			return (
				(file.path !== undefined && file.path !== plainFilePath) ||
				(file.relativePath !== undefined && file.relativePath !== plainFilePath)
			);
		})
	) {
		return Result({ _nay: { name: "nay", message: "Folder uploads are not supported yet." } });
	}
	if (files.length === 0) {
		return Result({ _nay: { name: "nay", message: "Drop a file to upload." } });
	}
	if (files.length > 1) {
		return Result({ _nay: { name: "nay", message: "Drop one file at a time." } });
	}

	return Result({ _yay: files[0] });
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

function is_selection_context_target(target: EventTarget | null) {
	if (!(target instanceof Element)) {
		return false;
	}

	return Boolean(target.closest(`[${"data-files-sidebar-tree-context" satisfies keyof CustomAttributes}]`));
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

type FilesSidebar_ClassNames = "FilesSidebar" | "FilesSidebar-content";

export type FilesSidebar_Props = {
	selectedNodeId: string | null;
	view: files_EditorView;
	onClose: () => void;
	onArchive: (itemId: string) => void;
	onPrimaryAction: (itemId: string, itemType: string) => void;
};

export const FilesSidebar = memo(function FilesSidebar(props: FilesSidebar_Props) {
	const { selectedNodeId, view, onClose, onArchive, onPrimaryAction } = props;

	const navigate = useNavigate();
	const convex = useConvex();
	const { membershipId, workspaceName, projectName } = AppTenantProvider.useContext();

	const [searchQuery, setSearchQuery] = useState("");
	const searchQueryDeferred = useDeferredValue(searchQuery);
	const isSearchActive = searchQueryDeferred.trim().length > 0;

	const [showArchived, setShowArchived] = useState(false);

	const [isCreatingFile, setIsCreatingFile] = useState(false);
	const [isArchivingSelection, setIsArchivingSelection] = useState(false);
	const [isUploadingFile, setIsUploadingFile] = useState(false);
	const [uploadDraft, setUploadDraft] = useState<FilesSidebarUploadDraft | null>(null);
	const [pendingActionNodeIds, setPendingActionNodeIds] = useState<Set<string>>(new Set());
	const [renamingItem, setRenamingItem] = useState<string | null | undefined>(undefined);
	const [renameErrorByNodeId, setRenameErrorByNodeId] = useState<Map<string, string>>(new Map());
	const isBusy = isCreatingFile || isArchivingSelection;
	const uploadInputRef = useRef<HTMLInputElement | null>(null);

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

		// Collect all items from the list to the maps
		for (const item of treeItemsList) {
			if (!files_is_node(item) || (item.archiveOperationId !== undefined && !showArchived)) {
				continue;
			}

			let siblingsIds = result.itemsIdsByParentId.get(item.parentId);
			if (!siblingsIds) {
				siblingsIds = new Set();
				result.itemsIdsByParentId.set(item.parentId, siblingsIds);
			}

			let sortedSiblingsIds = result.sortedItemsIdsByParentId.get(item.parentId);
			if (!sortedSiblingsIds) {
				sortedSiblingsIds = [];
				result.sortedItemsIdsByParentId.set(item.parentId, sortedSiblingsIds);
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
	 * Filtered items ids from search query
	 */
	const visibleFileIds = useMemo(() => {
		if (!treeItems) {
			return new Set<string>();
		}

		if (searchQueryDeferred.trim().length === 0) {
			return treeItems.itemsIds;
		}

		const searchQueryNormalized = searchQueryDeferred.trim().toLowerCase();

		const result = new Set<string>();
		for (const item of treeItems.list ?? []) {
			if (!treeItems.itemById.has(item._id)) {
				continue;
			}

			// If item does not match search query, skip
			if (!item.name.toLowerCase().includes(searchQueryNormalized)) {
				continue;
			}

			result.add(item._id);

			// If we are at the root, skip the ancestors step
			if (item._id === files_ROOT_ID) {
				continue;
			}

			// Add all ancestors of a matching item to the visible items set
			let currentParentId = item.parentId;
			while (currentParentId) {
				const parentItem = treeItems.itemById.get(currentParentId);
				if (!parentItem || result.has(currentParentId)) {
					break;
				}

				result.add(currentParentId);
				if (parentItem._id === files_ROOT_ID) {
					break;
				}

				currentParentId = parentItem.parentId;
			}
		}

		return result;
	}, [searchQueryDeferred, treeItems]);

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
			setIsUploadingFile(true);
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
					setIsUploadingFile(false);
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

	const canDragForeignDragObjectOver = useFn<
		NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["canDragForeignDragObjectOver"]>
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
				isUploadingFile,
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
				isUploadingFile,
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
				isUploadingFile,
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

		const uploadFileDrop = await get_single_dropped_file(dataTransfer);
		if (uploadFileDrop._nay) {
			toast.error(uploadFileDrop._nay.message ?? "Failed to read dropped file.");
			return;
		}

		const targetParentId = target.item.getId();
		uploadBrowserFile({
			file: uploadFileDrop._yay,
			parentId: targetParentId === files_ROOT_ID ? files_ROOT_ID : (targetParentId as app_convex_Id<"files_nodes">),
		});
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
							(treeItem): treeItem is files_VisibleTreeNode =>
								files_is_node(treeItem) && treeItem._id === itemId,
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
					renameValidation.cacheValidationMessage(result._nay.message);
					setRenameError(itemId, result._nay.message);
					console.error("[FilesSidebar.handleRename] Failed to rename node", { result });
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
			// Keep multi-selection scoped to tree work; outside context returns the sidebar to the route-owned row.
			if (is_selection_context_target(event.target)) {
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
				: convex.action(app_convex_api.files_nodes.create_markdown_node, {
						membershipId,
						parentId: parentNodeId === files_ROOT_ID ? files_ROOT_ID : (parentNodeId as app_convex_Id<"files_nodes">),
						path: nextNodeName,
					});

		createNodePromise
			.then((result) => {
				if (result._nay) {
					const createNodeValidation = files_get_node_path_validation({
						scopeId: membershipId,
						fileNodesList: treeItems.list,
						parentId: parentNodeId === files_ROOT_ID ? files_ROOT_ID : (parentNodeId as app_convex_Id<"files_nodes">),
						kind,
						nameOrPath: nextNodeName,
					});
					createNodeValidation.cacheValidationMessage(result._nay.message);
					console.error("[FilesSidebar.handleCreateNodeClick] Failed to create node", {
						result,
					});
					return;
				}

				// Mirror non-modifier tree clicks so programmatic create moves the visible selection too.
				tree().setSelectedItems([result._yay.nodeId]);
				tree().getDataRef<SelectionDataRef>().current.selectUpToAnchorId = result._yay.nodeId;

				return navigate({
					to: "/w/$workspaceName/$projectName/files",
					params: { workspaceName, projectName },
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

	const handleUploadFileChange = useFn<React.ComponentProps<"input">["onChange"]>((event) => {
		const file = event.currentTarget.files?.[0];
		event.currentTarget.value = "";
		if (!file || !treeItems) {
			return;
		}

		const selectedItem = selectedNodeId ? treeItems.itemById.get(selectedNodeId) : null;
		const parentId =
			selectedItem &&
			selectedItem._id !== files_ROOT_ID &&
			selectedItem.kind === "folder" &&
			selectedItem.archiveOperationId === undefined
				? selectedItem._id
				: files_ROOT_ID;

		uploadBrowserFile({
			file,
			parentId: parentId === files_ROOT_ID ? files_ROOT_ID : (parentId as app_convex_Id<"files_nodes">),
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

	return (
		<aside className={"FilesSidebar" satisfies FilesSidebar_ClassNames}>
			<input
				ref={uploadInputRef}
				type="file"
				aria-hidden="true"
				tabIndex={-1}
				style={{ display: "none" }}
				onChange={handleUploadFileChange}
			/>
			<FilesSidebarUploadConflictModal
				draft={uploadDraft}
				isUploading={isUploadingFile}
				onClose={handleUploadDraftClose}
				onRename={handleUploadDraftRename}
				onReplace={handleUploadDraftReplace}
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
				onClose={onClose}
				onSearchQueryChange={setSearchQuery}
				onExpandTopFilesClick={handleExpandTopFilesClick}
				onCollapseAllClick={handleCollapseAllClick}
				onClearSelectionClick={handleClearSelectionClick}
				onCreateRootFileClick={handleCreateRootFileClick}
				onCreateRootFolderClick={handleCreateRootFolderClick}
				onArchiveToggleClick={handleArchiveToggleClick}
				onArchiveSelectionClick={handleArchiveSelectionClick}
				onUploadFileClick={handleUploadFileClick}
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
					onArchive={handleArchive}
					onUnarchive={handleUnarchive}
				/>
			</div>
		</aside>
	);
});
// #endregion root

// #region tests
if (import.meta.vitest) {
	const { describe, test, expect } = import.meta.vitest;

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
			workspaceId: "workspace" as app_convex_Id<"workspaces">,
			projectId: "project" as app_convex_Id<"workspaces_projects">,
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
		kind: files_TreeItem["kind"];
		depth: number;
		hasPlaceholderRow?: boolean;
	}): DropZoneRow => {
		return {
			id: args.id,
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

		test("accepts exactly one dropped file", async () => {
			const file = test_file();
			const result = await get_single_dropped_file(
				test_data_transfer({
					files: [file],
				}),
			);

			expect(result).toEqual({
				_yay: file,
			});
		});

		test("rejects missing files, multiple files, and folders", async () => {
			await expect(get_single_dropped_file(test_data_transfer({ files: [] }))).resolves.toMatchObject({
				_nay: { message: "Drop a file to upload." },
			});
			await expect(
				get_single_dropped_file(
					test_data_transfer({
						files: [test_file("one.pdf"), test_file("two.pdf")],
					}),
				),
			).resolves.toMatchObject({
				_nay: { message: "Drop one file at a time." },
			});
			await expect(
				get_single_dropped_file(
					test_data_transfer({
						files: [test_file_from_directory()],
					}),
				),
			).resolves.toMatchObject({
				_nay: { message: "Folder uploads are not supported yet." },
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

	describe("is_selection_context_target", () => {
		test("keeps marked elements and their descendants inside selection context", () => {
			const element = document.createElement("div");
			const child = document.createElement("button");
			element.setAttribute("data-files-sidebar-tree-context" satisfies keyof CustomAttributes, "");
			element.append(child);

			expect(is_selection_context_target(element)).toBe(true);
			expect(is_selection_context_target(child)).toBe(true);
		});

		test("treats tree whitespace as outside selection context", () => {
			const treeElement = document.createElement("div");
			const whitespaceChild = document.createElement("div");
			treeElement.className = "FilesSidebarTree" satisfies FilesSidebarTree_ClassNames;
			treeElement.append(whitespaceChild);

			expect(is_selection_context_target(treeElement)).toBe(false);
			expect(is_selection_context_target(whitespaceChild)).toBe(false);
		});

		test("treats unrelated sidebar and page interactions as outside selection context", () => {
			const searchInput = document.createElement("input");
			searchInput.className = "FilesSidebarSearch" satisfies FilesSidebarSearch_ClassNames;
			const pageElement = document.createElement("main");

			expect(is_selection_context_target(searchInput)).toBe(false);
			expect(is_selection_context_target(pageElement)).toBe(false);
			expect(is_selection_context_target(null)).toBe(false);
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
			test_drop_zone_row({ id: "folder-b", kind: "folder", depth: 1 }),
			test_drop_zone_row({ id: "file-b", kind: "file", depth: 2 }),
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

		test("re-arms a folder target after hovering over an invalid child file row", () => {
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
				activeExternalFileDropTargetId: null,
			});
			expect(get_external_file_hover_state("folder-b")).toEqual({
				isDraggingOverRootZone: false,
				activeExternalFileDropTargetId: "folder-b",
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
