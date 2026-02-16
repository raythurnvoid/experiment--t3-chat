import "./pages-sidebar.css";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	Archive,
	ArchiveRestore,
	ChevronDown,
	ChevronRight,
	ChevronsDown,
	ChevronsUp,
	EllipsisVertical,
	Edit2,
	FileText,
	Menu,
	Plus,
	Search,
	X,
} from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import {
	dragAndDropFeature,
	expandAllFeature,
	hotkeysCoreFeature,
	renamingFeature,
	selectionFeature,
	syncDataLoaderFeature,
	type TreeInstance,
} from "@headless-tree/core";
import { AssistiveTreeDescription } from "@headless-tree/react";
import { useTree } from "@headless-tree/react/react-compiler";
import { useNavigate } from "@tanstack/react-router";
import { MySidebar, MySidebarContent, MySidebarHeader, type MySidebar_Props } from "@/components/my-sidebar.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { MyInput, MyInputArea, MyInputBox, MyInputControl, MyInputIcon } from "@/components/my-input.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyLink } from "@/components/my-link.tsx";
import { MyPrimaryAction } from "@/components/my-action.tsx";
import {
	MyMenu,
	MyMenuItem,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	MyMenuPopover,
	MyMenuPopoverContent,
	MyMenuTrigger,
} from "@/components/my-menu.tsx";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, cn, sx } from "@/lib/utils.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { useUiInteractedOutside } from "@/lib/ui.tsx";
import {
	pages_ROOT_ID,
	pages_create_tree_placeholder_child,
	type pages_EditorView,
	type pages_TreeItem,
} from "@/lib/pages.ts";
import { format_relative_time } from "@/lib/date.ts";

// #region helpers
type PagesSidebar_CollectionItem = {
	index: string;
	data: pages_TreeItem;
	children: string[];
};

type PagesSidebar_Collection = Record<string, PagesSidebar_CollectionItem>;

function pages_sidebar_to_page_id(pageId: string) {
	return pageId as app_convex_Id<"pages">;
}

function pages_sidebar_to_parent_id(parentId: string) {
	return (parentId === pages_ROOT_ID ? pages_ROOT_ID : pages_sidebar_to_page_id(parentId)) as
		| app_convex_Id<"pages">
		| typeof pages_ROOT_ID;
}

function sort_children(args: { children: string[]; collection: PagesSidebar_Collection }) {
	return [...args.children].sort((a, b) => {
		const itemA = args.collection[a];
		const itemB = args.collection[b];
		if (!itemA || !itemB) {
			return 0;
		}
		if (itemA.data.type === "placeholder") return 1;
		if (itemB.data.type === "placeholder") return -1;

		const titleA = itemA.data.title || "";
		const titleB = itemB.data.title || "";
		return titleA.localeCompare(titleB, undefined, {
			numeric: true,
			sensitivity: "base",
		});
	});
}

function create_collection(args: { treeItemsList: pages_TreeItem[] | undefined; showArchived: boolean }) {
	const rootItem = args.treeItemsList?.find((item) => item.type === "root") ?? {
		type: "root" as const,
		index: pages_ROOT_ID,
		parentId: "",
		title: "Pages",
		isArchived: false,
		updatedAt: Date.now(),
		updatedBy: "system",
		_id: null,
	};

	const collection: PagesSidebar_Collection = {
		[pages_ROOT_ID]: {
			index: pages_ROOT_ID,
			data: rootItem,
			children: [],
		},
	};

	const pageItems = args.treeItemsList?.filter((item) => item.type === "page") ?? [];
	for (const pageItem of pageItems) {
		if (pageItem.isArchived && !args.showArchived) {
			continue;
		}

		collection[pageItem.index] = {
			index: pageItem.index,
			data: pageItem,
			children: [],
		};
	}

	for (const pageItem of pageItems) {
		if (pageItem.isArchived && !args.showArchived) {
			continue;
		}
		if (!collection[pageItem.index]) {
			continue;
		}

		const parentId = pageItem.parentId && collection[pageItem.parentId] ? pageItem.parentId : pages_ROOT_ID;
		collection[parentId]?.children.push(pageItem.index);
	}

	const reachablePageIds = new Set<string>();
	const reachableStack = [...(collection[pages_ROOT_ID]?.children ?? [])];
	while (reachableStack.length > 0) {
		const currentId = reachableStack.pop();
		if (!currentId || reachablePageIds.has(currentId)) {
			continue;
		}
		reachablePageIds.add(currentId);

		const current = collection[currentId];
		if (!current || current.data.type !== "page") {
			continue;
		}

		reachableStack.push(...current.children);
	}

	const detachedPageIds = Object.keys(collection).filter((itemId) => {
		const current = collection[itemId];
		if (!current || current.data.type !== "page") {
			return false;
		}
		return !reachablePageIds.has(itemId);
	});
	if (detachedPageIds.length > 0) {
		collection[pages_ROOT_ID]?.children.push(...detachedPageIds);
	}

	for (const key of Object.keys(collection)) {
		const current = collection[key];
		if (!current || current.data.type === "placeholder") {
			continue;
		}

		current.children = sort_children({
			children: current.children,
			collection,
		});
	}

	for (const key of Object.keys(collection)) {
		const current = collection[key];
		if (!current || current.data.type !== "page") {
			continue;
		}
		if (current.children.length > 0) {
			continue;
		}

		const placeholder = pages_create_tree_placeholder_child(current.index);
		collection[placeholder.index] = {
			index: placeholder.index,
			data: placeholder,
			children: [],
		};
		current.children.push(placeholder.index);
	}

	return collection;
}

function pages_sidebar_are_tree_items_lists_equal(
	left: pages_TreeItem[] | undefined,
	right: pages_TreeItem[] | undefined,
	options?: {
		fields: Array<keyof pages_TreeItem>;
	},
) {
	if (left === right) {
		return true;
	}
	if (!left || !right) {
		return false;
	}
	if (left.length !== right.length) {
		return false;
	}

	const fields =
		options?.fields ??
		(["index", "parentId", "title", "isArchived", "updatedAt", "updatedBy"] satisfies Array<keyof pages_TreeItem>);

	const rightById = new Map<string, pages_TreeItem>();
	for (const item of right) {
		if (rightById.has(item.index)) {
			return false;
		}
		rightById.set(item.index, item);
	}

	if (rightById.size !== right.length) {
		return false;
	}

	const leftIds = new Set<string>();
	for (const leftItem of left) {
		if (leftIds.has(leftItem.index)) {
			return false;
		}
		leftIds.add(leftItem.index);

		const rightItem = rightById.get(leftItem.index);
		if (!rightItem) {
			return false;
		}

		for (const field of fields) {
			const leftValue = field === "updatedBy" ? (leftItem.updatedBy ?? "") : leftItem[field];
			const rightValue = field === "updatedBy" ? (rightItem.updatedBy ?? "") : rightItem[field];
			if (leftValue !== rightValue) {
				return false;
			}
		}
	}

	return true;
}
// #endregion helpers

// #region tree item icon
type PagesSidebarTreeItemIcon_ClassNames = "PagesSidebarTreeItemIcon";

function PagesSidebarTreeItemIcon() {
	return (
		<MyIcon className={"PagesSidebarTreeItemIcon" satisfies PagesSidebarTreeItemIcon_ClassNames}>
			<FileText />
		</MyIcon>
	);
}
// #endregion tree item icon

// #region tree item primary action content
type PagesSidebarTreeItemPrimaryActionContent_ClassNames = "PagesSidebarTreeItemPrimaryActionContent";

type PagesSidebarTreeItemPrimaryActionContent_Props = {
	title: React.ReactNode;
};

function PagesSidebarTreeItemPrimaryActionContent(props: PagesSidebarTreeItemPrimaryActionContent_Props) {
	return (
		<div
			className={
				"PagesSidebarTreeItemPrimaryActionContent" satisfies PagesSidebarTreeItemPrimaryActionContent_ClassNames
			}
		>
			<PagesSidebarTreeItemIcon />
			<div className="PagesSidebarTreeItemPrimaryActionContent-title-container">
				<div className="PagesSidebarTreeItemPrimaryActionContent-title">{props.title}</div>
			</div>
		</div>
	);
}
// #endregion tree item primary action content

// #region tree item action icon button
type PagesSidebarTreeItemActionIconButton_ClassNames = "PagesSidebarTreeItemActionIconButton";

type PagesSidebarTreeItemActionIconButton_Props = {
	children: React.ReactNode;
	tooltip: string;
	isActive: boolean;
	disabled?: boolean;
	onClick: () => void;
};

function PagesSidebarTreeItemActionIconButton(props: PagesSidebarTreeItemActionIconButton_Props) {
	return (
		<MyIconButton
			variant="ghost-highlightable"
			className={cn("PagesSidebarTreeItemActionIconButton" satisfies PagesSidebarTreeItemActionIconButton_ClassNames)}
			tooltip={props.tooltip}
			side="bottom"
			tabIndex={props.isActive ? 0 : -1}
			onClick={props.onClick}
			disabled={props.disabled}
		>
			<MyIconButtonIcon>{props.children}</MyIconButtonIcon>
		</MyIconButton>
	);
}
// #endregion tree item action icon button

type PagesSidebarTree_Shared = () => TreeInstance<pages_TreeItem>;

// #region tree item arrow
type PagesSidebarTreeItemArrow_ClassNames = "PagesSidebarTreeItemArrow";

type PagesSidebarTreeItemArrow_Props = {
	itemId: string;
	tree: PagesSidebarTree_Shared;
	isPending: boolean;
	isTabbable: boolean;
};

function PagesSidebarTreeItemArrow(props: PagesSidebarTreeItemArrow_Props) {
	const item = props.tree().getItemInstance(props.itemId);
	const isExpanded = props.tree().getState().expandedItems.includes(props.itemId);

	return (
		<div className={"PagesSidebarTreeItemArrow" satisfies PagesSidebarTreeItemArrow_ClassNames}>
			{item.isFolder() ? (
				<MyIconButton
					className={"PagesSidebarTreeItemArrow" satisfies PagesSidebarTreeItemArrow_ClassNames}
					tooltip={isExpanded ? "Collapse page" : "Expand page"}
					side="bottom"
					variant="ghost-highlightable"
					tabIndex={props.isTabbable ? 0 : -1}
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						if (isExpanded) {
							item.collapse();
						} else {
							item.expand();
						}
					}}
					disabled={props.isPending}
				>
					<MyIconButtonIcon>{isExpanded ? <ChevronDown /> : <ChevronRight />}</MyIconButtonIcon>
				</MyIconButton>
			) : null}
		</div>
	);
}
// #endregion tree item arrow

// #region tree rename input
type PagesSidebarTreeRenameInput_ClassNames = "PagesSidebarTreeRenameInput" | "PagesSidebarTreeRenameInput-input";

type PagesSidebarTreeRenameInput_Props = {
	itemId: string;
	tree: PagesSidebarTree_Shared;
};

function PagesSidebarTreeRenameInput(props: PagesSidebarTreeRenameInput_Props) {
	const item = props.tree().getItemInstance(props.itemId);

	return (
		<form className={"PagesSidebarTreeRenameInput" satisfies PagesSidebarTreeRenameInput_ClassNames}>
			<MyInput>
				<MyInputControl
					{...item.getRenameInputProps()}
					className={"PagesSidebarTreeRenameInput-input" satisfies PagesSidebarTreeRenameInput_ClassNames}
				/>
			</MyInput>
		</form>
	);
}
// #endregion tree rename input

// #region tree item
type PagesSidebarTreeItem_ClassNames =
	| "PagesSidebarTreeItem"
	| "PagesSidebarTreeItem-content-navigated"
	| "PagesSidebarTreeItem-content-dragging-target"
	| "PagesSidebarTreeItem-content-archived"
	| "PagesSidebarTreeItem-content-placeholder"
	| "PagesSidebarTreeItem-primary-action-interactive-area"
	| "PagesSidebarTreeItem-meta-label"
	| "PagesSidebarTreeItem-meta-label-text"
	| "PagesSidebarTreeItem-actions";

type PagesSidebar_CssVars = {
	"--PagesSidebarTreeItem-content-depth": number;
};

type PagesSidebarTreeItem_Props = {
	itemId: string;
	tree: PagesSidebarTree_Shared;
	selectedPageId: string | null;
	isBusy: boolean;
	pendingActionPageIds: Set<string>;
	isTreeDragging: boolean;
	onCreatePage: (parentPageId: string) => void;
	onArchive: (pageId: string) => void;
	onUnarchive: (pageId: string) => void;
	onTreeItemPrimaryClick: (event: React.MouseEvent<HTMLButtonElement>, itemId: string) => void;
};

function PagesSidebarTreeItem(props: PagesSidebarTreeItem_Props) {
	const {
		itemId,
		tree,
		selectedPageId,
		isBusy,
		pendingActionPageIds,
		isTreeDragging,
		onCreatePage,
		onArchive,
		onUnarchive,
		onTreeItemPrimaryClick,
	} = props;

	const item = tree().getItemInstance(itemId);
	const itemData = item.getItemData();
	const isPlaceholder = itemData.type === "placeholder";
	const isArchived = itemData.isArchived;
	const isNavigated = selectedPageId === itemId;
	const isPending = isBusy || pendingActionPageIds.has(itemId);
	const isTabbableRow = item.isFocused();
	const depth = item.getItemMeta().level;

	const isDragTarget = item.isDraggingOver();

	const metaText = isPlaceholder
		? ""
		: `${format_relative_time(itemData.updatedAt)} ${itemData.updatedBy || "Unknown"}`;
	const tooltipContent = isPlaceholder
		? undefined
		: `Updated ${format_relative_time(itemData.updatedAt, { prefixForDatesPast7Days: "the " })} by ${itemData.updatedBy || "Unknown"}`;

	const primaryAction = (
		<MyPrimaryAction
			{...item.getProps()}
			selected={item.isSelected()}
			className={"PagesSidebarTreeItem-primary-action-interactive-area" satisfies PagesSidebarTreeItem_ClassNames}
			disabled={isPending}
			tooltip={isTreeDragging ? undefined : tooltipContent}
			tooltipTimeout={2000}
			onClick={(event) => onTreeItemPrimaryClick(event, itemId)}
		>
			<PagesSidebarTreeItemPrimaryActionContent title={itemData.title} />
		</MyPrimaryAction>
	);

	return (
		<div
			key={itemId}
			className={cn(
				"PagesSidebarTreeItem" satisfies PagesSidebarTreeItem_ClassNames,
				isPlaceholder && ("PagesSidebarTreeItem-content-placeholder" satisfies PagesSidebarTreeItem_ClassNames),
				isNavigated && ("PagesSidebarTreeItem-content-navigated" satisfies PagesSidebarTreeItem_ClassNames),
				!isPlaceholder &&
					isDragTarget &&
					("PagesSidebarTreeItem-content-dragging-target" satisfies PagesSidebarTreeItem_ClassNames),
				isArchived && ("PagesSidebarTreeItem-content-archived" satisfies PagesSidebarTreeItem_ClassNames),
			)}
			style={sx({
				"--PagesSidebarTreeItem-content-depth": depth,
			} satisfies Partial<PagesSidebar_CssVars>)}
		>
			{isPlaceholder ? (
				<PagesSidebarTreeItemPrimaryActionContent title={itemData.title} />
			) : (
				<>
					{item.isRenaming() ? (
						<div
							className={
								"PagesSidebarTreeItem-primary-action-interactive-area" satisfies PagesSidebarTreeItem_ClassNames
							}
						>
							<div
								className={
									"PagesSidebarTreeItemPrimaryActionContent" satisfies PagesSidebarTreeItemPrimaryActionContent_ClassNames
								}
							>
								<PagesSidebarTreeItemIcon />
								<div className="PagesSidebarTreeItemPrimaryActionContent-title-container">
									<PagesSidebarTreeRenameInput itemId={itemId} tree={tree} />
								</div>
							</div>
						</div>
					) : (
						primaryAction
					)}

					<PagesSidebarTreeItemArrow itemId={itemId} tree={tree} isPending={isPending} isTabbable={isTabbableRow} />

					<div className={"PagesSidebarTreeItem-meta-label" satisfies PagesSidebarTreeItem_ClassNames}>
						<div className={"PagesSidebarTreeItem-meta-label-text" satisfies PagesSidebarTreeItem_ClassNames}>
							{metaText}
						</div>
					</div>

					<div className={"PagesSidebarTreeItem-actions" satisfies PagesSidebarTreeItem_ClassNames}>
						<PagesSidebarTreeItemActionIconButton
							tooltip="Add child"
							isActive={isTabbableRow}
							disabled={isPending}
							onClick={() => onCreatePage(itemId)}
						>
							<Plus />
						</PagesSidebarTreeItemActionIconButton>
						<MyMenu>
							<MyMenuTrigger tabIndex={isTabbableRow ? 0 : -1}>
								<MyIconButton
									className={cn(
										"PagesSidebarTreeItemActionIconButton" satisfies PagesSidebarTreeItemActionIconButton_ClassNames,
									)}
									variant="ghost-highlightable"
									tooltip="More actions"
									disabled={isPending}
								>
									<MyIconButtonIcon>
										<EllipsisVertical />
									</MyIconButtonIcon>
								</MyIconButton>
							</MyMenuTrigger>
							<MyMenuPopover>
								<MyMenuPopoverContent>
									<MyMenuItem disabled={isPending} onClick={() => item.startRenaming()}>
										<MyMenuItemContent>
											<MyMenuItemContentIcon>
												<Edit2 />
											</MyMenuItemContentIcon>
											<MyMenuItemContentPrimary>Rename</MyMenuItemContentPrimary>
										</MyMenuItemContent>
									</MyMenuItem>
									<MyMenuItem
										variant={isArchived ? "default" : "destructive"}
										disabled={isPending}
										onClick={() => {
											if (isArchived) {
												onUnarchive(itemId);
											} else {
												onArchive(itemId);
											}
										}}
									>
										<MyMenuItemContent>
											<MyMenuItemContentIcon>{isArchived ? <ArchiveRestore /> : <Archive />}</MyMenuItemContentIcon>
											<MyMenuItemContentPrimary>{isArchived ? "Restore" : "Archive"}</MyMenuItemContentPrimary>
										</MyMenuItemContent>
									</MyMenuItem>
								</MyMenuPopoverContent>
							</MyMenuPopover>
						</MyMenu>
					</div>
				</>
			)}
		</div>
	);
}
// #endregion tree item

// #region tree
type PagesSidebarTree_ClassNames =
	| "PagesSidebarTree"
	| "PagesSidebarTree-focused"
	| "PagesSidebarTree-dragging"
	| "PagesSidebarTree-dragging-root-target"
	| "PagesSidebarTree-empty-state";

type PagesSidebarTree_Props = {
	tree: PagesSidebarTree_Shared;
	isTreeLoading: boolean;
	showEmptyState: boolean;
	searchQuery: string;
	renderedTreeItemIds: string[];
	selectedPageId: string | null;
	isBusy: boolean;
	pendingActionPageIds: Set<string>;
	onCreatePage: (parentPageId: string) => void;
	onArchive: (pageId: string) => void;
	onUnarchive: (pageId: string) => void;
	onTreeItemPrimaryClick: (event: React.MouseEvent<HTMLButtonElement>, itemId: string) => void;
};

type PagesSidebarTree_DivProps = React.ComponentProps<"div">;

function PagesSidebarTree(props: PagesSidebarTree_Props) {
	const {
		tree,
		isTreeLoading,
		showEmptyState,
		searchQuery,
		renderedTreeItemIds,
		selectedPageId,
		isBusy,
		pendingActionPageIds,
		onCreatePage,
		onArchive,
		onUnarchive,
		onTreeItemPrimaryClick,
	} = props;
	const isTreeDragging = (tree().getState().dnd?.draggedItems?.length ?? 0) > 0;

	const [treeElement, setTreeElement] = useState<HTMLDivElement | null>(null);
	const [isTreeFocused, setIsTreeFocused] = useState(false);
	const [isDraggingOverRootZone, setIsDraggingOverRootZone] = useState(false);
	const isDraggingOverRootZoneRef = useRef(false);

	useUiInteractedOutside(
		treeElement,
		() => {
			tree().setSelectedItems([]);
		},
		{ enable: isTreeFocused },
	);

	const handleFocus = () => {
		setIsTreeFocused(true);
	};

	const handleBlur: NonNullable<PagesSidebarTree_DivProps["onBlur"]> = (event) => {
		const nextFocusedElement = event.relatedTarget;
		if (event.currentTarget.contains(nextFocusedElement)) {
			return;
		}

		setIsTreeFocused(false);
	};

	const handleKeyDown: NonNullable<PagesSidebarTree_DivProps["onKeyDown"]> = (event) => {
		if (event.key !== "F2") {
			return;
		}

		const focusedItem = tree().getFocusedItem();
		if (focusedItem.getItemData().type !== "page") {
			return;
		}

		event.preventDefault();
		focusedItem.startRenaming();
	};

	const handleSetIsDraggingOverRootZone = (nextValue: PagesSidebarTree_Props["isBusy"]) => {
		if (isDraggingOverRootZoneRef.current === nextValue) {
			return;
		}

		isDraggingOverRootZoneRef.current = nextValue;
		setIsDraggingOverRootZone(nextValue);
	};

	const handleUpdateRootZoneFromDragEvent: NonNullable<PagesSidebarTree_DivProps["onDragOverCapture"]> = (event) => {
		const draggedItems = tree().getState().dnd?.draggedItems ?? [];
		if (draggedItems.length === 0) {
			handleSetIsDraggingOverRootZone(false);
			return;
		}

		const hoveredItemElement = event.target instanceof Element ? event.target.closest(".PagesSidebarTreeItem") : null;
		const treeRootElement = event.currentTarget;

		const isPointerOverTreeItem = hoveredItemElement instanceof Element && treeRootElement.contains(hoveredItemElement);
		handleSetIsDraggingOverRootZone(!isPointerOverTreeItem);
	};

	const handleDragEnterCapture: NonNullable<PagesSidebarTree_DivProps["onDragEnterCapture"]> = (event) => {
		handleUpdateRootZoneFromDragEvent(event);
	};

	const handleDragOverCapture: NonNullable<PagesSidebarTree_DivProps["onDragOverCapture"]> = (event) => {
		handleUpdateRootZoneFromDragEvent(event);
	};

	const handleDragLeaveCapture: NonNullable<PagesSidebarTree_DivProps["onDragLeaveCapture"]> = (event) => {
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
				"PagesSidebarTree" satisfies PagesSidebarTree_ClassNames,
				isTreeFocused && ("PagesSidebarTree-focused" satisfies PagesSidebarTree_ClassNames),
				isTreeDragging && ("PagesSidebarTree-dragging" satisfies PagesSidebarTree_ClassNames),
				isDraggingOverRootZone && ("PagesSidebarTree-dragging-root-target" satisfies PagesSidebarTree_ClassNames),
			)}
			{...tree().getContainerProps("Pages")}
			onFocus={handleFocus}
			onBlur={handleBlur}
			onKeyDown={handleKeyDown}
			onDragEnterCapture={handleDragEnterCapture}
			onDragOverCapture={handleDragOverCapture}
			onDragLeaveCapture={handleDragLeaveCapture}
			onDragEndCapture={handleDragEndCapture}
			onDropCapture={handleDropCapture}
		>
			<AssistiveTreeDescription tree={tree()} />

			{isTreeLoading ? (
				<div className={cn("PagesSidebarTree-empty-state" satisfies PagesSidebarTree_ClassNames)}>Loading pages...</div>
			) : showEmptyState ? (
				<div className={cn("PagesSidebarTree-empty-state" satisfies PagesSidebarTree_ClassNames)}>
					{searchQuery.trim() ? "No pages match your search." : "No pages yet."}
				</div>
			) : (
				renderedTreeItemIds.map((itemId) => (
					<PagesSidebarTreeItem
						key={itemId}
						itemId={itemId}
						tree={tree}
						selectedPageId={selectedPageId}
						isBusy={isBusy}
						pendingActionPageIds={pendingActionPageIds}
						isTreeDragging={isTreeDragging}
						onCreatePage={onCreatePage}
						onArchive={onArchive}
						onUnarchive={onUnarchive}
						onTreeItemPrimaryClick={onTreeItemPrimaryClick}
					/>
				))
			)}
		</div>
	);
}
// #endregion tree

// #region root
type PagesSidebar_ClassNames =
	| "PagesSidebar"
	| "PagesSidebar-header"
	| "PagesSidebar-top-section"
	| "PagesSidebar-top-section-left"
	| "PagesSidebar-hamburger-button"
	| "PagesSidebar-title"
	| "PagesSidebar-close-button"
	| "PagesSidebar-search"
	| "PagesSidebar-actions"
	| "PagesSidebar-actions-group"
	| "PagesSidebar-actions-icon-button"
	| "PagesSidebar-action-new-page"
	| "PagesSidebar-archive-toggle"
	| "PagesSidebar-multi-selection-counter"
	| "PagesSidebar-multi-selection-counter-label"
	| "PagesSidebar-content";

export type PagesSidebar_Props = {
	state: MySidebar_Props["state"];
	selectedPageId: string | null;
	view: pages_EditorView;
	onClose: () => void;
	onArchive: (itemId: string) => void;
	onPrimaryAction: (itemId: string, itemType: string) => void;
};

export function PagesSidebar(props: PagesSidebar_Props) {
	const { selectedPageId, state = "expanded", view, onClose, onArchive, onPrimaryAction } = props;

	const navigate = useNavigate();
	const { toggleSidebar } = MainAppSidebar.useSidebar();
	const homePageId = useAppGlobalStore((state) => state.pages_home_id);

	const queriedTreeItemsList = useQuery(app_convex_api.ai_docs_temp.get_tree_items_list, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
	});
	const [resolvedTreeItemsList, setResolvedTreeItemsList] = useState<typeof queriedTreeItemsList>(undefined);
	const treeItemsList = queriedTreeItemsList ?? resolvedTreeItemsList;

	const movePages = useMutation(app_convex_api.ai_docs_temp.move_pages);
	const renamePage = useMutation(app_convex_api.ai_docs_temp.rename_page);
	const createPage = useMutation(app_convex_api.ai_docs_temp.create_page);
	const archivePages = useMutation(app_convex_api.ai_docs_temp.archive_pages);
	const unarchivePage = useMutation(app_convex_api.ai_docs_temp.unarchive_pages);

	const [searchQuery, setSearchQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const [isCreatingPage, setIsCreatingPage] = useState(false);
	const [isArchivingSelection, setIsArchivingSelection] = useState(false);
	const [pendingRenamePageId, setPendingRenamePageId] = useState<string | null>(null);
	const [pendingActionPageIds, setPendingActionPageIds] = useState<Set<string>>(new Set());
	const [, setTreeRebuildVersion] = useState(0);

	const lastTreeItemsListRef = useRef<typeof treeItemsList>(undefined);

	const baseTreeCollection = ((/* iife */) => {
		return create_collection({
			treeItemsList,
			showArchived,
		});
	})();

	const archivedCount = ((/* iife */) => {
		if (!treeItemsList) {
			return 0;
		}
		return treeItemsList.filter((item) => item.type === "page" && item.isArchived).length;
	})();

	const shouldForceShowArchived =
		!showArchived && archivedCount > 0 && (baseTreeCollection[pages_ROOT_ID]?.children.length ?? 0) === 0;

	const treeCollection = ((/* iife */) => {
		if (!shouldForceShowArchived) {
			return baseTreeCollection;
		}

		return create_collection({
			treeItemsList,
			showArchived: true,
		});
	})();

	const isArchivedShown = showArchived || shouldForceShowArchived;
	const lastIsArchivedShownRef = useRef(isArchivedShown);

	const dataLoader = {
		getItem: (itemId: string) =>
			treeCollection[itemId]?.data ?? pages_create_tree_placeholder_child(itemId.replace("-placeholder", "")),
		getChildren: (itemId: string) => treeCollection[itemId]?.children ?? [],
	};

	const markPageAsPending = (pageId: string) => {
		setPendingActionPageIds((oldValue) => {
			const nextValue = new Set(oldValue);
			nextValue.add(pageId);
			return nextValue;
		});
	};

	const unmarkPageAsPending = (pageId: string) => {
		setPendingActionPageIds((oldValue) => {
			const nextValue = new Set(oldValue);
			nextValue.delete(pageId);
			return nextValue;
		});
	};

	const movePagesToParent = (args: { pageIds: string[]; targetParentId: string }) => {
		const movedPageIds = args.pageIds.filter((pageId) => treeCollection[pageId]?.data.type === "page");
		if (movedPageIds.length === 0) {
			return Promise.resolve();
		}

		return movePages({
			itemIds: movedPageIds.map((itemId) => pages_sidebar_to_page_id(itemId)),
			targetParentId: pages_sidebar_to_parent_id(args.targetParentId),
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
		}).then((result) => {
			if (result._nay) {
				throw new Error("[PagesSidebar.movePagesToParent] Error moving pages", { cause: result._nay });
			}
		});
	};

	const tree = useTree<pages_TreeItem>({
		rootItemId: pages_ROOT_ID,
		initialState: {
			expandedItems: [pages_ROOT_ID],
		},
		canReorder: false,
		dataLoader,
		features: [
			syncDataLoaderFeature,
			selectionFeature,
			hotkeysCoreFeature,
			dragAndDropFeature,
			renamingFeature,
			expandAllFeature,
		],
		getItemName: (item) => item.getItemData().title,
		isItemFolder: (item) => item.getItemData().type !== "placeholder",
		canDrag: (items) => {
			return items.every((item) => item.getItemData().type === "page");
		},
		canDrop: (items, target) => {
			const targetId = target.item.getId();
			const targetData = target.item.getItemData();
			if (targetId !== pages_ROOT_ID && targetData.type !== "page") {
				return false;
			}

			return items.every((item) => {
				if (item.getItemData().type !== "page") {
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
		},
		onDrop: (items, target) => {
			movePagesToParent({
				pageIds: items.map((item) => item.getId()),
				targetParentId: target.item.getId(),
			}).catch(console.error);
		},
		canRename: (item) => item.getItemData().type === "page",
		onRename: (item, value) => {
			const trimmedValue = value.trim();
			const itemData = item.getItemData();
			if (itemData.type !== "page") {
				return;
			}
			if (!trimmedValue || trimmedValue === itemData.title) {
				return;
			}

			markPageAsPending(item.getId());
			renamePage({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId: pages_sidebar_to_page_id(item.getId()),
				name: trimmedValue,
			})
				.then((result) => {
					if (result._nay) {
						throw new Error("[PagesSidebar.onRename] Error renaming page", { cause: result._nay });
					}
				})
				.catch(console.error)
				.finally(() => {
					unmarkPageAsPending(item.getId());
				});
		},
		onPrimaryAction: (item) => {
			const itemData = item.getItemData();
			if (itemData.type === "page") {
				onPrimaryAction(item.getId(), itemData.type);
			}
		},
	});

	const hasSelectedPageInTree = !!(selectedPageId && treeCollection[selectedPageId]);
	const hasPendingRenamePageInTree = !!(pendingRenamePageId && treeCollection[pendingRenamePageId]);

	const treeItems = tree().getItems();

	const visibleIds = ((/* iife */) => {
		const searchTerm = searchQuery.trim().toLowerCase();
		if (!searchTerm) {
			return null;
		}

		const result = new Set<string>();
		const isVisible = (id: string): boolean => {
			const current = treeCollection[id];
			if (!current) {
				return false;
			}
			if (current.data.type === "placeholder") {
				return false;
			}

			const selfMatch = current.data.title.toLowerCase().includes(searchTerm);
			let childMatch = false;
			for (const childId of current.children) {
				if (isVisible(childId)) {
					childMatch = true;
				}
			}

			const visible = selfMatch || childMatch;
			if (visible) {
				result.add(id);
			}
			return visible;
		};

		isVisible(pages_ROOT_ID);
		return result;
	})();

	const selectedPageIds = treeItems
		.filter((item) => item.isSelected() && item.getItemData().type === "page")
		.map((item) => item.getId());

	const multiSelectionCount = selectedPageIds.length;
	const isBusy = isCreatingPage || isArchivingSelection;
	const isTreeLoading = treeItemsList === undefined;
	const renderedTreeItemIds = treeItems
		.map((item) => item.getId())
		.filter((itemId) => {
			if (itemId === pages_ROOT_ID) {
				return false;
			}
			if (visibleIds && !visibleIds.has(itemId)) {
				return false;
			}
			return true;
		});
	const showEmptyState = !isTreeLoading && renderedTreeItemIds.length === 0;

	const handleCreatePageClick: PagesSidebarTree_Props["onCreatePage"] = (parentPageId) => {
		setIsCreatingPage(true);
		createPage({
			parentId: pages_sidebar_to_parent_id(parentPageId),
			name: "New Page",
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
		})
			.then((result) => {
				if (result._nay) {
					throw new Error("[PagesSidebar.handleCreatePageClick] Error creating page", {
						cause: result._nay,
					});
				}
				setPendingRenamePageId(result._yay.pageId);
				return navigate({
					to: "/pages",
					search: { pageId: result._yay.pageId, view },
				});
			})
			.catch(console.error)
			.finally(() => {
				setIsCreatingPage(false);
			});
	};

	const handleArchive: PagesSidebarTree_Props["onArchive"] = (pageId) => {
		const shouldArchiveSelectedPages = selectedPageIds.length > 1 && selectedPageIds.includes(pageId);
		const pageIdsToArchive = shouldArchiveSelectedPages ? selectedPageIds : [pageId];

		if (shouldArchiveSelectedPages) {
			setIsArchivingSelection(true);
		} else {
			markPageAsPending(pageId);
		}

		archivePages({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageIds: pageIdsToArchive.map((currentPageId) => pages_sidebar_to_page_id(currentPageId)),
		})
			.then(() => {
				if (selectedPageId && pageIdsToArchive.includes(selectedPageId)) {
					onArchive(selectedPageId);
					return;
				}

				if (!shouldArchiveSelectedPages) {
					onArchive(pageId);
				}
			})
			.catch(console.error)
			.finally(() => {
				if (shouldArchiveSelectedPages) {
					tree().setSelectedItems([]);
					setIsArchivingSelection(false);
					return;
				}

				unmarkPageAsPending(pageId);
			});
	};

	const handleUnarchive: PagesSidebarTree_Props["onUnarchive"] = (pageId) => {
		markPageAsPending(pageId);
		unarchivePage({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId: pages_sidebar_to_page_id(pageId),
		})
			.then((result) => {
				if (result._nay) {
					throw new Error("[PagesSidebar.handleUnarchive] Error unarchiving page", { cause: result._nay });
				}
			})
			.catch(console.error)
			.finally(() => {
				unmarkPageAsPending(pageId);
			});
	};

	const handleTreeItemPrimaryClick: PagesSidebarTree_Props["onTreeItemPrimaryClick"] = (event, itemId) => {
		const item = tree().getItemInstance(itemId);
		const isModifierClick = event.shiftKey || event.ctrlKey || event.metaKey;

		if (event.shiftKey) {
			item.selectUpTo(event.ctrlKey || event.metaKey);
		} else if (event.ctrlKey || event.metaKey) {
			item.toggleSelect();
		} else {
			tree().setSelectedItems([itemId]);
		}

		if (!event.shiftKey) {
			const dataRef = tree().getDataRef() as { current: { selectUpToAnchorId?: string } };
			dataRef.current.selectUpToAnchorId = itemId;
		}

		item.setFocused();
		if (isModifierClick) {
			return;
		}

		const itemData = item.getItemData();
		if (itemData.type === "page") {
			onPrimaryAction(itemId, itemData.type);
		}
	};

	useLayoutEffect(() => {
		const shouldRebuild =
			lastIsArchivedShownRef.current !== isArchivedShown ||
			!pages_sidebar_are_tree_items_lists_equal(lastTreeItemsListRef.current, treeItemsList, {
				fields: ["type", "index", "parentId", "title", "isArchived"],
			});

		lastIsArchivedShownRef.current = isArchivedShown;
		lastTreeItemsListRef.current = treeItemsList;

		if (!shouldRebuild) {
			return;
		}

		tree().scheduleRebuildTree();
		setTreeRebuildVersion((oldValue) => oldValue + 1);
	}, [isArchivedShown, treeItemsList]);

	useEffect(() => {
		if (queriedTreeItemsList === undefined) {
			return;
		}
		setResolvedTreeItemsList((currentValue) => {
			if (
				pages_sidebar_are_tree_items_lists_equal(currentValue, queriedTreeItemsList, {
					fields: ["index", "parentId", "title", "isArchived", "updatedAt", "updatedBy"],
				})
			) {
				return currentValue;
			}
			return queriedTreeItemsList;
		});
	}, [queriedTreeItemsList]);

	useEffect(() => {
		if (!selectedPageId || !hasSelectedPageInTree) {
			return;
		}
		tree().getItemInstance(selectedPageId).setFocused();
	}, [hasSelectedPageInTree, selectedPageId]);

	useEffect(() => {
		if (!pendingRenamePageId || !hasPendingRenamePageInTree) {
			return;
		}
		tree().getItemInstance(pendingRenamePageId).startRenaming();
		setPendingRenamePageId(null);
	}, [hasPendingRenamePageInTree, pendingRenamePageId]);

	return (
		<MySidebar state={state} className={"PagesSidebar" satisfies PagesSidebar_ClassNames}>
			<div className={cn("PagesSidebar" satisfies PagesSidebar_ClassNames)}>
				<MySidebarHeader className={cn("PagesSidebar-header" satisfies PagesSidebar_ClassNames)}>
					<div className={cn("PagesSidebar-top-section" satisfies PagesSidebar_ClassNames)}>
						<div className={cn("PagesSidebar-top-section-left" satisfies PagesSidebar_ClassNames)}>
							<MyIconButton
								className={"PagesSidebar-hamburger-button" satisfies PagesSidebar_ClassNames}
								variant="ghost"
								tooltip="Main Menu"
								onClick={toggleSidebar}
							>
								<Menu />
							</MyIconButton>

							<MyLink
								className={cn("PagesSidebar-title" satisfies PagesSidebar_ClassNames)}
								variant="button-tertiary"
								to="/pages"
								search={{ pageId: homePageId, view }}
							>
								Pages
							</MyLink>
						</div>

						<MyIconButton
							variant="ghost"
							onClick={onClose}
							tooltip="Close"
							className={cn("PagesSidebar-close-button" satisfies PagesSidebar_ClassNames)}
						>
							<MyIconButtonIcon>
								<X />
							</MyIconButtonIcon>
						</MyIconButton>
					</div>

					<MyInput className={cn("PagesSidebar-search" satisfies PagesSidebar_ClassNames)} variant="surface">
						<MyInputArea>
							<MyInputBox />
							<MyInputIcon>
								<Search />
							</MyInputIcon>
							<MyInputControl
								placeholder="Search pages"
								value={searchQuery}
								onChange={(event) => setSearchQuery(event.target.value)}
							/>
						</MyInputArea>
					</MyInput>

					<div className={cn("PagesSidebar-actions" satisfies PagesSidebar_ClassNames)}>
						<div className={cn("PagesSidebar-actions-group" satisfies PagesSidebar_ClassNames)}>
							<MyIconButton
								className={cn("PagesSidebar-actions-icon-button" satisfies PagesSidebar_ClassNames)}
								variant="secondary-subtle"
								tooltip="Unfold"
								onClick={() => tree().expandAll().catch(console.error)}
								disabled={isBusy}
							>
								<MyIconButtonIcon>
									<ChevronsDown />
								</MyIconButtonIcon>
							</MyIconButton>

							<MyIconButton
								className={cn("PagesSidebar-actions-icon-button" satisfies PagesSidebar_ClassNames)}
								variant="secondary-subtle"
								tooltip="Fold"
								onClick={() => tree().collapseAll()}
								disabled={isBusy}
							>
								<MyIconButtonIcon>
									<ChevronsUp />
								</MyIconButtonIcon>
							</MyIconButton>
						</div>

						{multiSelectionCount > 1 ? (
							<div className={cn("PagesSidebar-multi-selection-counter" satisfies PagesSidebar_ClassNames)}>
								<span className={cn("PagesSidebar-multi-selection-counter-label" satisfies PagesSidebar_ClassNames)}>
									{multiSelectionCount} items selected
								</span>
								<div className={cn("PagesSidebar-actions-group" satisfies PagesSidebar_ClassNames)}>
									<MyIconButton
										className={cn("PagesSidebar-actions-icon-button" satisfies PagesSidebar_ClassNames)}
										variant="secondary"
										tooltip="Clear"
										onClick={() => tree().setSelectedItems([])}
										disabled={isBusy}
									>
										<MyIconButtonIcon>
											<X />
										</MyIconButtonIcon>
									</MyIconButton>
								</div>
							</div>
						) : (
							<MyButton
								className={cn("PagesSidebar-action-new-page" satisfies PagesSidebar_ClassNames)}
								variant="secondary"
								onClick={() => handleCreatePageClick(pages_ROOT_ID)}
								disabled={isBusy}
							>
								<MyButtonIcon>
									<Plus />
								</MyButtonIcon>
								New Page
							</MyButton>
						)}
					</div>

					{archivedCount > 0 ? (
						<MyButton
							className={cn("PagesSidebar-archive-toggle" satisfies PagesSidebar_ClassNames)}
							variant="ghost"
							onClick={() => setShowArchived((oldValue) => !oldValue)}
							disabled={isBusy}
						>
							{isArchivedShown ? `Hide archived (${archivedCount})` : `Show archived (${archivedCount})`}
						</MyButton>
					) : null}
				</MySidebarHeader>

				<MySidebarContent className={cn("PagesSidebar-content" satisfies PagesSidebar_ClassNames)}>
					<PagesSidebarTree
						tree={tree}
						isTreeLoading={isTreeLoading}
						showEmptyState={showEmptyState}
						searchQuery={searchQuery}
						renderedTreeItemIds={renderedTreeItemIds}
						selectedPageId={selectedPageId}
						isBusy={isBusy}
						pendingActionPageIds={pendingActionPageIds}
						onCreatePage={handleCreatePageClick}
						onArchive={handleArchive}
						onUnarchive={handleUnarchive}
						onTreeItemPrimaryClick={handleTreeItemPrimaryClick}
					/>
				</MySidebarContent>
			</div>
		</MySidebar>
	);
}
// #endregion root
