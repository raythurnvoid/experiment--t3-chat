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
import {
	Archive,
	ArchiveRestore,
	ChevronDown,
	ChevronRight,
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
import { useConvex, useQuery } from "convex/react";
import {
	dragAndDropFeature,
	expandAllFeature,
	hotkeysCoreFeature,
	propMemoizationFeature,
	renamingFeature,
	selectionFeature,
	syncDataLoaderFeature,
	type FeatureImplementation,
	type SelectionDataRef,
	type TreeConfig,
	type TreeInstance,
} from "@headless-tree/core";
import { AssistiveTreeDescription } from "@headless-tree/react";
import { useTree } from "@headless-tree/react/react-compiler";
import { useNavigate } from "@tanstack/react-router";
import { MainAppSidebarToggle } from "@/components/main-app-sidebar-toggle.tsx";
import { MyInput, MyInputArea, MyInputBox, MyInputControl, MyInputIcon } from "@/components/my-input.tsx";
import { MyIconButton, MyIconButtonIcon, type MyIconButton_Props } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyLink } from "@/components/my-link.tsx";
import { MySidebarHeader, MySidebarTitle } from "@/components/my-sidebar.tsx";
import { MyTooltip, MyTooltipContent, MyTooltipTrigger } from "@/components/my-tooltip.tsx";
import { MyPrimaryAction } from "@/components/my-action.tsx";
import {
	MyMenu,
	MyMenuCheckboxItem,
	MyMenuCheckboxItemControl,
	MyMenuItem,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	MyMenuPopover,
	MyMenuPopoverContent,
	MyMenuTrigger,
	type MyMenuItem_Props,
} from "@/components/my-menu.tsx";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { cn, forward_ref, should_never_happen, sx } from "@/lib/utils.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { dom_clear_text_selection } from "@/lib/dom-utils.ts";
import { useUiInteractedOutside } from "@/lib/ui.tsx";
import { useDebounce, useFn, useVal } from "@/hooks/utils-hooks.ts";
import {
	files_ROOT_ID,
	files_create_tree_root,
	files_normalize_name_input,
	files_validate_and_normalize_name,
	type files_EditorView,
	type files_TreeItem,
} from "@/lib/files.ts";
import { format_relative_time } from "@/lib/date.ts";
import type { FunctionReturnType } from "convex/server";

type FilesSidebarTree_Shared = () => TreeInstance<files_TreeItem>;
type FilesSidebarTreeItem_Instance = ReturnType<TreeInstance<files_TreeItem>["getItemInstance"]>;

// #region helpers
type FilesSidebar_TreeItems = {
	list: files_TreeItem[] | undefined;
	itemsIds: Set<string>;
	itemsIdsByParentId: Map<string, Set<string>>;
	sortedItemsIdsByParentId: Map<string, string[]>;
	itemById: Map<string, files_TreeItem>;
};

function files_sidebar_to_file_id(nodeId: string) {
	return nodeId as app_convex_Id<"files_nodes">;
}

function files_sidebar_to_parent_id(parentId: string) {
	return (parentId === files_ROOT_ID ? files_ROOT_ID : files_sidebar_to_file_id(parentId)) as
		| app_convex_Id<"files_nodes">
		| typeof files_ROOT_ID;
}

function files_sidebar_get_default_node_name(args: {
	parentId: string;
	kind: files_TreeItem["kind"];
	treeItems: FilesSidebar_TreeItems;
}) {
	const siblingIds = args.treeItems.sortedItemsIdsByParentId.get(args.parentId) ?? [];
	const activeSiblingNames = new Set<string>();

	for (const siblingId of siblingIds) {
		const siblingItem = args.treeItems.itemById.get(siblingId);
		if (!siblingItem || siblingItem.type !== "node") {
			continue;
		}
		if (siblingItem.archiveOperationId !== undefined) {
			continue;
		}

		activeSiblingNames.add(siblingItem.title.trim().toLowerCase());
	}

	const baseName = args.kind === "folder" ? "new-folder" : "new-file.md";
	if (!activeSiblingNames.has(baseName.toLowerCase())) {
		return baseName;
	}

	let suffix = 2;
	for (;;) {
		const candidateName = args.kind === "folder" ? `new-folder-${suffix}` : `new-file-${suffix}.md`;
		if (!activeSiblingNames.has(candidateName.toLowerCase())) {
			return candidateName;
		}
		suffix += 1;
	}
}

function files_sidebar_get_protected_markdown_extension_start(args: {
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

function files_sidebar_normalize_rename_input_value(args: { kind: files_TreeItem["kind"]; value: string }) {
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

function sort_children(args: { children: string[]; itemById: Map<string, files_TreeItem> }) {
	return [...args.children].sort((a, b) => {
		const itemA = args.itemById.get(a);
		const itemB = args.itemById.get(b);
		if (!itemA || !itemB) {
			return 0;
		}

		const titleA = itemA.title || "";
		const titleB = itemB.title || "";
		return titleA.localeCompare(titleB, undefined, {
			numeric: true,
			sensitivity: "base",
		});
	});
}

// #endregion helpers

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
	className?: string;
	children: React.ReactNode;
	tooltip: string | undefined;
	isActive: boolean;
	disabled?: boolean;
	onClick: () => void;
};

const FilesSidebarTreeItemSecondaryAction = memo(function FilesSidebarTreeItemSecondaryAction(
	props: FilesSidebarTreeItemSecondaryAction_Props,
) {
	const { className, children, tooltip, isActive, disabled, onClick } = props;

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
			onClick={handleClick}
			disabled={disabled}
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
	isActive: boolean;
	disabled?: boolean;
	onClick: () => void;
};

const FilesSidebarTreeItemSecondaryActionCreateFile = memo(function FilesSidebarTreeItemSecondaryActionCreateFile(
	props: FilesSidebarTreeItemSecondaryActionCreateFile_Props,
) {
	const { kind, isActive, disabled, onClick } = props;

	return (
		<FilesSidebarTreeItemSecondaryAction
			className={cn(
				"FilesSidebarTreeItemSecondaryActionCreateFile" satisfies FilesSidebarTreeItemSecondaryActionCreateFile_ClassNames,
			)}
			tooltip={kind === "folder" ? "Add folder" : "Add file"}
			isActive={isActive}
			disabled={disabled}
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
	kind: files_TreeItem["kind"];
	archiveOperationId: string | undefined;
	isPending: boolean;
	isFocused: boolean;
	canExpandSubtree: boolean;
	canCollapseSubtree: boolean;
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
		archiveOperationId,
		isPending,
		isFocused,
		canExpandSubtree,
		canCollapseSubtree,
		onRename,
		onExpandSubtree,
		onCollapseSubtree,
		onArchive,
		onUnarchive,
	} = props;
	const isArchived = archiveOperationId !== undefined;

	const handleRenameClick = useFn<MyMenuItem_Props["onClick"]>(() => {
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

	const handleExpandSubtreeClick = useFn<MyMenuItem_Props["onClick"]>(() => {
		onExpandSubtree();
	});

	const handleCollapseSubtreeClick = useFn<MyMenuItem_Props["onClick"]>(() => {
		onCollapseSubtree();
	});

	return (
		<MyMenu>
			<MyMenuTrigger tabIndex={isFocused ? 0 : -1}>
				<MyIconButton
					className={cn("FilesSidebarTreeItemMoreAction" satisfies FilesSidebarTreeItemMoreAction_ClassNames)}
					variant="ghost-highlightable"
					tooltip={"More actions"}
					disabled={isPending}
				>
					<MyIconButtonIcon>
						<EllipsisVertical />
					</MyIconButtonIcon>
				</MyIconButton>
			</MyMenuTrigger>
			<MyMenuPopover unmountOnHide>
				<MyMenuPopoverContent>
					<MyMenuItem hideOnClick onClick={handleRenameClick}>
						<MyMenuItemContent>
							<MyMenuItemContentIcon>
								<Edit2 />
							</MyMenuItemContentIcon>
							<MyMenuItemContentPrimary>Rename</MyMenuItemContentPrimary>
						</MyMenuItemContent>
					</MyMenuItem>
					{kind === "folder" && (
						<>
							<MyMenuItem disabled={!canExpandSubtree} hideOnClick onClick={handleExpandSubtreeClick}>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>
										<CopyPlus />
									</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>Expand subtree</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
							<MyMenuItem disabled={!canCollapseSubtree} hideOnClick onClick={handleCollapseSubtreeClick}>
								<MyMenuItemContent>
									<MyMenuItemContentIcon>
										<CopyMinus />
									</MyMenuItemContentIcon>
									<MyMenuItemContentPrimary>Collapse subtree</MyMenuItemContentPrimary>
								</MyMenuItemContent>
							</MyMenuItem>
						</>
					)}
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
				</MyMenuPopoverContent>
			</MyMenuPopover>
		</MyMenu>
	);
});
// #endregion tree item more action

// #region tree item arrow
type FilesSidebarTreeItemArrow_ClassNames = "FilesSidebarTreeItemArrow" | "FilesSidebarTreeItemArrow-icon-button";

type FilesSidebarTreeItemArrow_Props = {
	isExpanded: boolean;
	isPending: boolean;
	isFocused: boolean;
	onClick: () => void;
};

const FilesSidebarTreeItemArrow = memo(function FilesSidebarTreeItemArrow(props: FilesSidebarTreeItemArrow_Props) {
	const { isExpanded, isPending, isFocused, onClick } = props;

	return (
		<div className={"FilesSidebarTreeItemArrow" satisfies FilesSidebarTreeItemArrow_ClassNames}>
			<MyIconButton
				className={"FilesSidebarTreeItemArrow-icon-button" satisfies FilesSidebarTreeItemArrow_ClassNames}
				tooltip={isExpanded ? "Collapse folder" : "Expand folder"}
				tooltipSide="bottom"
				variant="ghost-highlightable"
				tabIndex={isFocused ? 0 : -1}
				onClick={onClick}
				disabled={isPending}
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
		const nextTextEnd = files_sidebar_get_protected_markdown_extension_start({
			kind,
			value: element.value,
			selectionStart,
			selectionEnd,
		});
		const replacementEnd =
			kind === "file" && selectionEnd === nextTextEnd && insertedText.includes(".") ? element.value.length : selectionEnd;
		// Let full file names such as `foo/bar.md` replace the protected `.md` instead of appending another suffix.
		// Normalize only the inserted fragment, using the surrounding text for separator adjacency.
		const normalizedInsertedText = files_normalize_name_input({
			kind,
			previousText: element.value.slice(0, selectionStart),
			insertedText,
			nextText: element.value.slice(selectionEnd, nextTextEnd),
		});
		// Rebuild the full control value with the sanitized replacement.
		const nextValue = element.value.slice(0, selectionStart) + normalizedInsertedText + element.value.slice(replacementEnd);
		if (nextValue === element.value) {
			return;
		}

		// Place the caret at the end of the inserted normalized fragment.
		syncRenameInputValue(element, nextValue, selectionStart + normalizedInsertedText.length);
	});

	const applyRenameInputToControl = useFn((element: HTMLInputElement) => {
		// Preserve the current caret as closely as possible when the fallback sanitizer rewrites the value.
		const selectionStart = element.selectionStart ?? element.value.length;
		const nextValue = files_sidebar_normalize_rename_input_value({
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

		// Use native validity for :invalid styling while keeping the app tooltip as the visible message.
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
			if (kind === "file" && inputElement.value.endsWith(".md")) {
				const selectionEnd = inputElement.value.length - ".md".length;
				if (selectionEnd > 0) {
					inputElement.setSelectionRange(0, selectionEnd);
					return;
				}
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

	const input = (
		<MyInput
			className={"FilesSidebarTreeItemTitle" satisfies FilesSidebarTreeItemTitle_ClassNames}
			variant="transparent"
		>
			<MyInputBox />
			<MyInputControl
				{...(isRenaming ? renameInputProps : null)}
				ref={handleRenameInputRef}
				className={"FilesSidebarTreeItemTitle-input" satisfies FilesSidebarTreeItemTitle_ClassNames}
				onBlur={handleRenameInputBlur}
				onBeforeInput={isRenaming ? handleRenameInputBeforeInput : undefined}
				onChange={isRenaming ? handleRenameInputChange : undefined}
				onCompositionEnd={isRenaming ? handleRenameInputCompositionEnd : undefined}
				onPaste={isRenaming ? handleRenameInputPaste : undefined}
				readOnly={!isRenaming}
				tabIndex={isRenaming ? undefined : -1}
				value={value}
			/>
		</MyInput>
	);

	return (
		<MyTooltip open={isRenaming && Boolean(renameError)} placement="bottom-start">
			<MyTooltipTrigger>{input}</MyTooltipTrigger>
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
type FilesSidebarTreeItemPrimaryAction_ClassNames = "FilesSidebarTreeItemPrimaryAction";

type FilesSidebarTreeItemPrimaryAction_Props = {
	itemProps: ReturnType<FilesSidebarTreeItem_Instance["getProps"]>;
	title: string;
	updatedAt: files_TreeItem["updatedAt"];
	updatedBy: files_TreeItem["updatedBy"];
	isPending: boolean;
	isSelected: boolean;
	isTreeDragging: boolean;
	isFocused: boolean;
};

const FilesSidebarTreeItemPrimaryAction = memo(function FilesSidebarTreeItemPrimaryAction(
	props: FilesSidebarTreeItemPrimaryAction_Props,
) {
	const { itemProps, title, updatedAt, updatedBy, isPending, isSelected, isTreeDragging, isFocused } = props;

	const tooltipContent = `Updated ${format_relative_time(updatedAt, { prefixForDatesPast7Days: "the " })} by ${updatedBy || "Unknown"}`;

	return (
		<MyPrimaryAction
			{...itemProps}
			className={"FilesSidebarTreeItemPrimaryAction" satisfies FilesSidebarTreeItemPrimaryAction_ClassNames}
			selected={isSelected}
			disabled={isPending && !isFocused}
			tooltip={tooltipContent}
			tooltipTimeout={2000}
			tooltipDisabled={isTreeDragging}
			aria-label={title}
			aria-selected={isSelected ? "true" : "false"}
		></MyPrimaryAction>
	);
});
// #endregion tree item primary action

// #region tree item meta label
type FilesSidebarTreeItemMetaLabel_ClassNames = "FilesSidebarTreeItemMetaLabel" | "FilesSidebarTreeItemMetaLabel-text";

type FilesSidebarTreeItemMetaLabel_Props = {
	metaText: string;
};

const FilesSidebarTreeItemMetaLabel = memo(function FilesSidebarTreeItemMetaLabel(
	props: FilesSidebarTreeItemMetaLabel_Props,
) {
	const { metaText } = props;

	return (
		<div className={"FilesSidebarTreeItemMetaLabel" satisfies FilesSidebarTreeItemMetaLabel_ClassNames}>
			<div className={"FilesSidebarTreeItemMetaLabel-text" satisfies FilesSidebarTreeItemMetaLabel_ClassNames}>
				{metaText}
			</div>
		</div>
	);
});
// #endregion tree item meta label

// #region tree item actions
type FilesSidebarTreeItemActions_ClassNames = "FilesSidebarTreeItemActions";

type FilesSidebarTreeItemActions_Props = {
	kind: FilesSidebarTreeItemMoreAction_Props["kind"];
	archiveOperationId: FilesSidebarTreeItemMoreAction_Props["archiveOperationId"];
	isPending: boolean;
	isFocused: boolean;
	canCreateChildren: boolean;
	canExpandSubtree: FilesSidebarTreeItemMoreAction_Props["canExpandSubtree"];
	canCollapseSubtree: FilesSidebarTreeItemMoreAction_Props["canCollapseSubtree"];
	onCreateFile: FilesSidebarTreeItemSecondaryAction_Props["onClick"];
	onCreateFolder: FilesSidebarTreeItemSecondaryAction_Props["onClick"];
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
		archiveOperationId,
		isPending,
		isFocused,
		canCreateChildren,
		canExpandSubtree,
		canCollapseSubtree,
		onCreateFile,
		onCreateFolder,
		onRename,
		onExpandSubtree,
		onCollapseSubtree,
		onArchive,
		onUnarchive,
	} = props;

	return (
		<div className={"FilesSidebarTreeItemActions" satisfies FilesSidebarTreeItemActions_ClassNames}>
			{canCreateChildren ? (
				<>
					<FilesSidebarTreeItemSecondaryActionCreateFile
						kind="file"
						isActive={isFocused}
						disabled={isPending}
						onClick={onCreateFile}
					/>
					<FilesSidebarTreeItemSecondaryActionCreateFile
						kind="folder"
						isActive={isFocused}
						disabled={isPending}
						onClick={onCreateFolder}
					/>
				</>
			) : null}
			<FilesSidebarTreeItemMoreAction
				kind={kind}
				archiveOperationId={archiveOperationId}
				isPending={isPending}
				isFocused={isFocused}
				canExpandSubtree={canExpandSubtree}
				canCollapseSubtree={canCollapseSubtree}
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
	| "FilesSidebarTreeItemTrack-guide-active";

type FilesSidebarTreeItemTrack_Props = {
	trackFileIds: string[];
	trackActiveFileIds: Set<string>;
};

const FilesSidebarTreeItemTrack = memo(function FilesSidebarTreeItemTrack(props: FilesSidebarTreeItemTrack_Props) {
	const { trackFileIds, trackActiveFileIds } = props;

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
	onDragEnter: ComponentProps<"div">["onDragEnter"];
	onDragOver: ComponentProps<"div">["onDragOver"];
	onDragLeave: ComponentProps<"div">["onDragLeave"];
	onDrop: ComponentProps<"div">["onDrop"];
};

const FilesSidebarTreeItemPlaceholder = memo(function FilesSidebarTreeItemPlaceholder(
	props: FilesSidebarTreeItemPlaceholder_Props,
) {
	const { itemId, ancestorIds, trackActiveFileIds, onDragEnter, onDragOver, onDragLeave, onDrop } = props;

	const trackFileIds = [...ancestorIds, itemId];
	const placeholderDepth = trackFileIds.length;

	return (
		<div
			className={"FilesSidebarTreeItemPlaceholder" satisfies FilesSidebarTreeItemPlaceholder_ClassNames}
			style={sx({
				"--FilesSidebarTreeItemPlaceholder-depth": placeholderDepth,
			} satisfies Partial<FilesSidebarTreeItemPlaceholder_CssVars>)}
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
			<FilesSidebarTreeItemTrack trackFileIds={trackFileIds} trackActiveFileIds={trackActiveFileIds} />
		</div>
	);
});
// #endregion tree item placeholder

// #region tree item
type FilesSidebarTreeItem_ClassNames =
	| "FilesSidebarTreeItem"
	| "FilesSidebarTreeItem-content-navigated"
	| "FilesSidebarTreeItem-content-dragging-target"
	| "FilesSidebarTreeItem-content-archived"
	| "FilesSidebarTreeItem-content-renaming";

type FilesSidebarTreeItem_CustomAttributes = {
	"data-file-id": string;
};

type FilesSidebar_CssVars = {
	"--FilesSidebarTreeItem-content-depth": number;
};

type FilesSidebarTreeItem_Props = {
	/** Necessary to ensure the item is re-rendered when the tree is updated */
	tree: FilesSidebarTree_Shared;
	item: FilesSidebarTreeItem_Instance;
	trackActiveFileIds: Set<string>;
	selectedNodeId: string | null;
	isSelected: boolean;
	isSearchActive: boolean;
	isBusy: boolean;
	pendingActionNodeIds: Set<string>;
	renameError: string | undefined;
	isTreeDragging: boolean;
	onCreateNode: (parentNodeId: string, kind: files_TreeItem["kind"]) => void;
	onStartRename: (itemId: string) => void;
	onRenameErrorClear: (itemId: string) => void;
	onArchive: (nodeId: string) => void;
	onUnarchive: (nodeId: string) => void;
};

const FilesSidebarTreeItem = memo(function FilesSidebarTreeItem(props: FilesSidebarTreeItem_Props) {
	const {
		item,
		trackActiveFileIds,
		selectedNodeId,
		isSelected,
		isSearchActive,
		isBusy,
		pendingActionNodeIds,
		renameError,
		isTreeDragging,
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
	const isDragTarget = useVal(() => item.isDraggingOver());
	const isExpanded = useVal(() => item.isExpanded());

	const depth = useVal(() => item.getItemMeta().level);

	const hasChildren = useVal(() => item.getChildren().length > 0);

	const canExpandSubtree = useVal(
		() => itemData.kind === "folder" && (!isExpanded || item.getChildren().some((child) => !child.isExpanded())),
	);
	const canCollapseSubtree = useVal(
		() => itemData.kind === "folder" && isExpanded && item.getChildren().some((child) => child.isExpanded()),
	);

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

	const metaText = `${format_relative_time(itemData.updatedAt)} ${itemData.updatedBy || "Unknown"}`;
	const shouldRenderPlaceholder = !isSearchActive && itemData.kind === "folder" && !hasChildren && isExpanded;

	const handleCreateFileClick = useFn<FilesSidebarTreeItemSecondaryAction_Props["onClick"]>(() => {
		onCreateNode(itemId, "file");
	});

	const handleCreateFolderClick = useFn<FilesSidebarTreeItemSecondaryAction_Props["onClick"]>(() => {
		onCreateNode(itemId, "folder");
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

	return (
		<>
			<div
				className={cn(
					"FilesSidebarTreeItem" satisfies FilesSidebarTreeItem_ClassNames,
					isNavigated && ("FilesSidebarTreeItem-content-navigated" satisfies FilesSidebarTreeItem_ClassNames),
					isDragTarget && ("FilesSidebarTreeItem-content-dragging-target" satisfies FilesSidebarTreeItem_ClassNames),
					isArchived && ("FilesSidebarTreeItem-content-archived" satisfies FilesSidebarTreeItem_ClassNames),
					isRenaming && ("FilesSidebarTreeItem-content-renaming" satisfies FilesSidebarTreeItem_ClassNames),
				)}
				style={sx({
					"--FilesSidebarTreeItem-content-depth": depth,
				} satisfies Partial<FilesSidebar_CssVars>)}
				{...({
					"data-file-id": itemId,
				} satisfies Partial<FilesSidebarTreeItem_CustomAttributes>)}
			>
				<FilesSidebarTreeItemPrimaryAction
					itemProps={itemProps}
					title={itemData.title}
					updatedAt={itemData.updatedAt}
					updatedBy={itemData.updatedBy}
					isPending={isPending}
					isSelected={isSelected}
					isTreeDragging={isTreeDragging}
					isFocused={isFocused}
				/>

				<FilesSidebarTreeItemPrimaryContent
					title={itemData.title}
					kind={itemData.kind}
					renameInputProps={renameInputProps}
					isRenaming={isRenaming}
					renameError={renameError}
					onRenameErrorClear={handleRenameErrorClear}
				/>

				{itemData.kind === "folder" ? (
					<FilesSidebarTreeItemArrow
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

				<FilesSidebarTreeItemMetaLabel metaText={metaText} />

				<FilesSidebarTreeItemActions
					kind={itemData.kind}
					archiveOperationId={itemData.archiveOperationId}
					isPending={isPending}
					isFocused={isFocused}
					canCreateChildren={itemData.kind === "folder"}
					canExpandSubtree={canExpandSubtree}
					canCollapseSubtree={canCollapseSubtree}
					onCreateFile={handleCreateFileClick}
					onCreateFolder={handleCreateFolderClick}
					onRename={handleRenameClick}
					onExpandSubtree={handleExpandSubtreeClick}
					onCollapseSubtree={handleCollapseSubtreeClick}
					onArchive={handleArchiveClick}
					onUnarchive={handleUnarchiveClick}
				/>

				<FilesSidebarTreeItemTrack trackFileIds={ancestorIds} trackActiveFileIds={trackActiveFileIds} />
			</div>

			{shouldRenderPlaceholder ? (
				<FilesSidebarTreeItemPlaceholder
					itemId={itemId}
					ancestorIds={ancestorIds}
					trackActiveFileIds={trackActiveFileIds}
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

// #region tree
type FilesSidebarTree_ClassNames =
	| "FilesSidebarTree"
	| "FilesSidebarTree-dragging"
	| "FilesSidebarTree-dragging-root-target"
	| "FilesSidebarTree-empty-state";

type FilesSidebarTree_Props = {
	tree: FilesSidebarTree_Shared;
	isTreeLoading: boolean;
	showEmptyState: boolean;
	isSearchActive: boolean;
	trackActiveFileIds: Set<string>;
	selectedNodeId: string | null;
	selectedNodeIds: Set<string>;
	isBusy: boolean;
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
		trackActiveFileIds,
		selectedNodeId,
		selectedNodeIds,
		isBusy,
		pendingActionNodeIds,
		renameErrorByNodeId,
		onCreateNode,
		onStartRename,
		onRenameErrorClear,
		onArchive,
		onUnarchive,
	} = props;
	const isTreeDragging = (tree().getState().dnd?.draggedItems?.length ?? 0) > 0;

	const [treeElement, setTreeElement] = useState<HTMLDivElement | null>(null);
	const isTreeFocusedRef = useRef(false);
	const [isDraggingOverRootZone, setIsDraggingOverRootZone] = useState(false);
	const isDraggingOverRootZoneRef = useRef(false);

	useUiInteractedOutside(treeElement, () => {
		if (!isTreeFocusedRef.current) {
			return;
		}
		tree().setSelectedItems([]);
	});

	const handleFocus = () => {
		isTreeFocusedRef.current = true;
	};

	const handleBlur: NonNullable<FilesSidebarTree_DivProps["onBlur"]> = (event) => {
		const nextFocusedElement = event.relatedTarget;
		if (event.currentTarget.contains(nextFocusedElement)) {
			return;
		}

		isTreeFocusedRef.current = false;
	};

	const handleSetIsDraggingOverRootZone = (nextValue: FilesSidebarTree_Props["isBusy"]) => {
		if (isDraggingOverRootZoneRef.current === nextValue) {
			return;
		}

		isDraggingOverRootZoneRef.current = nextValue;
		setIsDraggingOverRootZone(nextValue);
	};

	const handleUpdateRootZoneFromDragEvent: NonNullable<FilesSidebarTree_DivProps["onDragOverCapture"]> = (event) => {
		const draggedItems = tree().getState().dnd?.draggedItems ?? [];
		if (draggedItems.length === 0) {
			handleSetIsDraggingOverRootZone(false);
			return;
		}

		const hoveredItemElement =
			event.target instanceof Element
				? event.target.closest(".FilesSidebarTreeItem, .FilesSidebarTreeItemPlaceholder")
				: null;
		const treeRootElement = event.currentTarget;

		const isPointerOverTreeItem = hoveredItemElement instanceof Element && treeRootElement.contains(hoveredItemElement);
		handleSetIsDraggingOverRootZone(!isPointerOverTreeItem);
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
	};

	const handleDragEndCapture = () => {
		handleSetIsDraggingOverRootZone(false);
	};

	const handleDropCapture = () => {
		handleSetIsDraggingOverRootZone(false);
	};

	useEffect(() => {
		if (isTreeDragging) {
			return;
		}

		handleSetIsDraggingOverRootZone(false);
	}, [isTreeDragging]);

	return (
		<div
			ref={setTreeElement}
			className={cn(
				"FilesSidebarTree" satisfies FilesSidebarTree_ClassNames,
				isTreeDragging && ("FilesSidebarTree-dragging" satisfies FilesSidebarTree_ClassNames),
				isDraggingOverRootZone && ("FilesSidebarTree-dragging-root-target" satisfies FilesSidebarTree_ClassNames),
			)}
			{...tree().getContainerProps("files_nodes")}
			onFocus={handleFocus}
			onBlur={handleBlur}
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
					{tree()
						.getItems()
						.map((item) => {
							const itemId = item.getId();
							return (
								<FilesSidebarTreeItem
									key={itemId}
									tree={tree}
									item={item}
									trackActiveFileIds={trackActiveFileIds}
									selectedNodeId={selectedNodeId}
									isSelected={selectedNodeIds.has(itemId)}
									isSearchActive={isSearchActive}
									isBusy={isBusy}
									pendingActionNodeIds={pendingActionNodeIds}
									renameError={renameErrorByNodeId.get(itemId)}
									isTreeDragging={isTreeDragging}
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
		<MyInput className={cn("FilesSidebarSearch" satisfies FilesSidebarSearch_ClassNames)} variant="surface">
			<MyInputArea>
				<MyInputBox />
				<MyInputIcon>
					<Search />
				</MyInputIcon>
				<MyInputControl placeholder="Search files" value={searchQuery} onChange={handleInputChange} />
			</MyInputArea>
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
	homeNodeId: string | undefined;
	view: files_EditorView;
	onClose: () => void;
};

const FilesSidebarHeader = memo(function FilesSidebarHeader(props: FilesSidebarHeader_Props) {
	const { homeNodeId, view, onClose } = props;

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
							search={{ nodeId: homeNodeId, view }}
						>
							<MySidebarTitle>Files</MySidebarTitle>
						</MyLink>
					</MyTooltipTrigger>
					<MyTooltipContent>Open Home</MyTooltipContent>
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
	className?: string;
	isBusy: boolean;
	archivedCount: number;
	showArchived: boolean;
	onArchiveToggleClick: () => void;
};

const FilesSidebarTopSectionMoreAction = memo(function FilesSidebarTopSectionMoreAction(
	props: FilesSidebarTopSectionMoreAction_Props,
) {
	const { className, isBusy, archivedCount, showArchived, onArchiveToggleClick } = props;

	const archivedItemsLabel = `${showArchived ? "Hide" : "Show"} ${archivedCount} ${
		archivedCount === 1 ? "item" : "items"
	} archived`;

	const handleArchiveToggleClick = useFn(() => {
		onArchiveToggleClick();
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
			<MyMenuPopover placement="bottom-end" unmountOnHide>
				<MyMenuPopoverContent>
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
					<MyMenuItem disabled>
						<MyMenuItemContent>
							<MyMenuItemContentIcon>
								<Upload />
							</MyMenuItemContentIcon>
							<MyMenuItemContentPrimary>Upload file</MyMenuItemContentPrimary>
						</MyMenuItemContent>
					</MyMenuItem>
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
	homeNodeId: string | undefined;
	view: files_EditorView;
	selectedNodeIdsCount: number;
	isBusy: boolean;
	canExpandAll: boolean;
	canCollapseAll: boolean;
	treeItemsList: FunctionReturnType<typeof app_convex_api.files_nodes.get_tree_nodes_list> | undefined;
	showArchived: boolean;
	onClose: () => void;
	onSearchQueryChange: (searchQuery: string) => void;
	onExpandTopFilesClick: () => void;
	onCollapseAllClick: () => void;
	onClearSelectionClick: () => void;
	onCreateRootFileClick: () => void;
	onCreateRootFolderClick: () => void;
	onArchiveToggleClick: () => void;
};

const FilesSidebarTopSection = memo(function FilesSidebarTopSection(props: FilesSidebarTopSection_Props) {
	const {
		homeNodeId,
		view,
		selectedNodeIdsCount,
		isBusy,
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
	} = props;

	const archivedCount =
		treeItemsList?.filter((item) => item.type === "node" && item.archiveOperationId !== undefined).length ?? 0;

	return (
		<div className={cn("FilesSidebarTopSection" satisfies FilesSidebarTopSection_ClassNames)}>
			<FilesSidebarHeader homeNodeId={homeNodeId} view={view} onClose={onClose} />

			<FilesSidebarSearch onSearchQueryChange={onSearchQueryChange} />

			<div className={cn("FilesSidebarTopSection-actions" satisfies FilesSidebarTopSection_ClassNames)}>
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
						archivedCount={archivedCount}
						showArchived={showArchived}
						onArchiveToggleClick={onArchiveToggleClick}
					/>
				</div>
			</div>
		</div>
	);
});
// #endregion top section

// #region root
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

	const homeNodeId = useAppGlobalStore((state) => state.files_home_id_by_membership_id[membershipId] ?? "");

	const [searchQuery, setSearchQuery] = useState("");
	const searchQueryDeferred = useDeferredValue(searchQuery);
	const isSearchActive = searchQueryDeferred.trim().length > 0;

	const [showArchived, setShowArchived] = useState(false);

	const [isCreatingFile, setIsCreatingFile] = useState(false);
	const [isArchivingSelection, setIsArchivingSelection] = useState(false);
	const [pendingActionNodeIds, setPendingActionNodeIds] = useState<Set<string>>(new Set());
	const [renamingItem, setRenamingItem] = useState<string | null | undefined>(undefined);
	const [renameErrorByNodeId, setRenameErrorByNodeId] = useState<Map<string, string>>(new Map());
	const isBusy = isCreatingFile || isArchivingSelection;

	const [expandedItems, setExpandedItems] = useState<string[]>([]);
	const canCollapseAll = expandedItems.length > 1;

	const expandedItemsBeforeSearchRef = useRef<Set<string> | null>(null);
	const selectedFilePathAutoExpandedOnMountRef = useRef(false);

	const treeItemsList = useQuery(app_convex_api.files_nodes.get_tree_nodes_list, {
		membershipId,
	});

	// For some reason the compiler is not auto memoizing this so we need `useMemo`
	const treeItems = useMemo(() => {
		if (!treeItemsList) {
			return undefined;
		}

		const rootItem = treeItemsList.find((item) => item.type === "root");
		if (!rootItem) {
			return undefined;
		}

		const result = {
			list: treeItemsList,
			itemsIds: new Set<string>([files_ROOT_ID]),
			itemsIdsByParentId: new Map<string, Set<string>>([[files_ROOT_ID, new Set()]]),
			sortedItemsIdsByParentId: new Map<string, string[]>([[files_ROOT_ID, []]]),
			itemById: new Map<string, files_TreeItem>([[files_ROOT_ID, rootItem]]),
		} satisfies FilesSidebar_TreeItems;

		// Collect all items from the list to the maps
		for (const item of treeItemsList) {
			if (item.type !== "node" || (item.archiveOperationId !== undefined && !showArchived)) {
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

			siblingsIds.add(item.index);
			sortedSiblingsIds.push(item.index);
			result.itemById.set(item.index, item);
			result.itemsIds.add(item.index);
			if (!result.itemsIdsByParentId.has(item.index)) {
				result.itemsIdsByParentId.set(item.index, new Set());
			}
			if (!result.sortedItemsIdsByParentId.has(item.index)) {
				result.sortedItemsIdsByParentId.set(item.index, []);
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
	const visibleFileIds = ((/* iife */) => {
		if (!treeItems) {
			return new Set<string>();
		}

		if (searchQueryDeferred.trim().length === 0) {
			return treeItems.itemsIds;
		}

		const searchQueryNormalized = searchQueryDeferred.trim().toLowerCase();

		const result = new Set<string>();
		for (const item of treeItems.list ?? []) {
			if (!treeItems.itemById.has(item.index)) {
				continue;
			}

			// If item does not match search query, skip
			if (!item.title.toLowerCase().includes(searchQueryNormalized)) {
				continue;
			}

			result.add(item.index);

			// If we are at the root, skip the ancestors step
			if (item.type !== "node") {
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
				if (parentItem.type !== "node") {
					break;
				}

				currentParentId = parentItem.parentId;
			}
		}

		return result;
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
		return items.every((item) => item.getItemData().type === "node");
	});

	const canDrop = useFn<NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["canDrop"]>>((items, target) => {
		const targetId = target.item.getId();
		const targetData = target.item.getItemData();
		if (targetId !== files_ROOT_ID && targetData.kind !== "folder") {
			return false;
		}

		return items.every((item) => {
			if (item.getItemData().type !== "node") {
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

		const movedNodeIds = nodeIds.filter((nodeId) => treeItems.itemById.get(nodeId)?.type === "node");
		if (movedNodeIds.length === 0) {
			return;
		}

		return convex
			.mutation(app_convex_api.files_nodes.move_nodes, {
				membershipId,
				itemIds: movedNodeIds.map((itemId) => files_sidebar_to_file_id(itemId)),
				targetParentId: files_sidebar_to_parent_id(targetParentId),
			})
			.then((result) => {
				if (result._nay) {
					console.error("[FilesSidebar.moveNodesToParent] Failed to move nodes", { result });
					return;
				}
			})
			.catch((error) => console.error("[FilesSidebar.moveNodesToParent] Error moving nodes", { error }));
	});

	const canRename = useFn<NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["canRename"]>>((item) => {
		return item.getItemData().type === "node";
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

		if (itemData.type !== "node") {
			console.error("[FilesSidebar.handleRename] item is not a node", { itemId, itemData });
			return;
		}

		if (!trimmedValue) {
			return;
		}

		const normalizedNameResult = files_validate_and_normalize_name(itemData.kind, trimmedValue);
		if (normalizedNameResult._nay) {
			console.error("[FilesSidebar.handleRename] Invalid rename value", { result: normalizedNameResult, itemId });
			return;
		}
		const normalizedName = normalizedNameResult._yay;

		if (normalizedName === itemData.title) {
			return;
		}

		clearRenameError(itemId);
		item.setFocused();
		markFileAsPending(itemId);
		// Send the lowercase Markdown-safe name; Convex remains responsible for final special casing.
		convex
			.mutation(
				app_convex_api.files_nodes.rename_node,
				{
					membershipId,
					nodeId: files_sidebar_to_file_id(itemId),
					name: normalizedName.toLowerCase(),
				},
				{
					optimisticUpdate: (localStore) => {
						const treeItemsList = localStore.getQuery(app_convex_api.files_nodes.get_tree_nodes_list, {
							membershipId,
						});
						if (!treeItemsList) {
							return;
						}
						localStore.setQuery(
							app_convex_api.files_nodes.get_tree_nodes_list,
							{
								membershipId,
							},
							treeItemsList.map((treeItem) => {
								if (treeItem._id === itemId) {
									return {
										...treeItem,
										title: normalizedName,
									};
								}
								return treeItem;
							}),
						);
					},
				},
			)
			.then((result) => {
				if (result._nay) {
					console.error("[FilesSidebar.handleRename] Failed to rename node", { result });
				}
			})
			.catch((error) => {
				console.error("[FilesSidebar.handleRename] Error on rename node", { error });
			})
			.finally(() => {
				unmarkFileAsPending(itemId);
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
		if (itemData.type === "node" && trimmedValue) {
			const normalizedNameResult = files_validate_and_normalize_name(itemData.kind, trimmedValue);
			if (normalizedNameResult._nay) {
				event.preventDefault();
				setRenameError(itemId, normalizedNameResult._nay.message);
				item.setFocused();
				return;
			}
		}

		clearRenameError(itemId);
		currentTree.completeRenaming();
	});

	const handlePrimaryAction = useFn<NonNullable<Parameters<typeof useTree<files_TreeItem>>[0]["onPrimaryAction"]>>(
		(item) => {
			const itemData = item.getItemData();
			if (itemData.type === "node") {
				if (itemData.kind === "folder") {
					const readmeId = treeItems?.sortedItemsIdsByParentId
						.get(item.getId())
						?.map((childId) => treeItems.itemById.get(childId))
						.find(
							(child) =>
								child?.kind === "file" &&
								child.archiveOperationId === undefined &&
								child.title.toLowerCase() === "readme.md",
						)?._id;
					onPrimaryAction(readmeId ?? item.getId(), readmeId ? "file" : "folder");
					return;
				}

				onPrimaryAction(item.getId(), itemData.kind);
			}
		},
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
			treeItems?.itemById.get(itemId) ?? treeItems?.itemById.get(files_ROOT_ID) ?? files_create_tree_root(),
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
		getItemName: (item) => item.getItemData().title,
		isItemFolder: (item) => item.getItemData().kind === "folder",
		canDrag,
		canDrop,
		setRenamingItem: handleRenamingItemChange,
		onDrop: handleDrop,
		canRename,
		onRename: handleRename,
		onPrimaryAction: handlePrimaryAction,
	});

	const renderedTreeItems = tree().getItems();
	const renderedNodeIds = new Set(
		renderedTreeItems.filter((item) => item.getItemData().type === "node").map((item) => item.getId()),
	);

	const selectedNodeIds = new Set(
		renderedTreeItems
			.filter((item) => item.isSelected() && item.getItemData().type === "node")
			.map((item) => item.getId()),
	);
	const selectionAnchorNodeId = tree().getDataRef<SelectionDataRef>().current.selectUpToAnchorId ?? null;

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
		if (item.getItemData().type !== "node") {
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

		const nextNodeName = files_sidebar_get_default_node_name({
			parentId: parentNodeId,
			kind,
			treeItems,
		});

		setIsCreatingFile(true);
		convex
			.mutation(app_convex_api.files_nodes.create_node, {
				membershipId,
				parentId: files_sidebar_to_parent_id(parentNodeId),
				name: nextNodeName,
				kind,
			})
			.then((result) => {
				if (result._nay) {
					console.error("[FilesSidebar.handleCreateNodeClick] Failed to create node", {
						result,
					});
					return;
				}

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

	const handleUnarchive = useFn<FilesSidebarTree_Props["onUnarchive"]>((nodeId) => {
		markFileAsPending(nodeId);
		convex
			.mutation(app_convex_api.files_nodes.unarchive_nodes, {
				membershipId,
				nodeIds: [files_sidebar_to_file_id(nodeId)],
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

	// Rebuild tree when visible files or controlled expansion state changes.
	useLayoutEffect(() => {
		tree().rebuildTree();
	}, [expandedItems, visibleFileIds]);

	// Auto expand files on search or mount
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

		// Auto-expand selected-file ancestors once on mount.
		if (!selectedFilePathAutoExpandedOnMountRef.current && selectedNodeId && hasSelectedFileInTree) {
			let currentItemId = treeItems.itemById.get(selectedNodeId)?.parentId;

			// Walk up the selected file's parent chain and ensure each ancestor is expanded.
			while (currentItemId) {
				if (nextExpandedItemsSet.has(currentItemId)) {
					break;
				} else {
					nextExpandedItemsSet.add(currentItemId);
				}

				currentItemId = treeItems.itemById.get(selectedNodeId)?.parentId;
			}
		}

		selectedFilePathAutoExpandedOnMountRef.current = true;

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

	return (
		<aside className={"FilesSidebar" satisfies FilesSidebar_ClassNames}>
			<FilesSidebarTopSection
				homeNodeId={homeNodeId}
				view={view}
				selectedNodeIdsCount={selectedNodeIds.size}
				isBusy={isBusy}
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
			/>

			<div className={cn("FilesSidebar-content" satisfies FilesSidebar_ClassNames)}>
				<FilesSidebarTree
					tree={tree}
					isTreeLoading={treeItemsList === undefined}
					showEmptyState={showEmptyState}
					isSearchActive={isSearchActive}
					trackActiveFileIds={trackActiveFileIds}
					selectedNodeId={selectedNodeId}
					selectedNodeIds={selectedNodeIds}
					isBusy={isBusy}
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
