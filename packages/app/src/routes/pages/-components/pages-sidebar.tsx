import "./pages-sidebar.css";
import React, { useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { useConvex, useQuery } from "convex/react";
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
import { MyIconButton, MyIconButtonIcon, type MyIconButton_Props } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyLink } from "@/components/my-link.tsx";
import { MyPrimaryAction, type MyPrimaryAction_Props } from "@/components/my-action.tsx";
import {
	MyMenu,
	MyMenuItem,
	MyMenuItemContent,
	MyMenuItemContentIcon,
	MyMenuItemContentPrimary,
	MyMenuPopover,
	MyMenuPopoverContent,
	MyMenuTrigger,
	type MyMenuItem_Props,
} from "@/components/my-menu.tsx";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, cn, sx } from "@/lib/utils.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { useUiInteractedOutside } from "@/lib/ui.tsx";
import { useDebounce, useFn, useVal } from "@/hooks/utils-hooks.ts";
import {
	pages_ROOT_ID,
	pages_create_tree_placeholder_child,
	type pages_EditorView,
	type pages_TreeItem,
} from "@/lib/pages.ts";
import { format_relative_time } from "@/lib/date.ts";

type PagesSidebarTree_Shared = () => TreeInstance<pages_TreeItem>;
type PagesSidebarTreeItem_Instance = ReturnType<TreeInstance<pages_TreeItem>["getItemInstance"]>;

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

function pages_sidebar_normalize_parent_id(parentId: string) {
	return parentId.endsWith("-placeholder") ? parentId.slice(0, -"-placeholder".length) : parentId;
}

function pages_sidebar_to_parent_id(parentId: string) {
	const normalizedParentId = pages_sidebar_normalize_parent_id(parentId);

	return (normalizedParentId === pages_ROOT_ID ? pages_ROOT_ID : pages_sidebar_to_page_id(normalizedParentId)) as
		| app_convex_Id<"pages">
		| typeof pages_ROOT_ID;
}

function pages_sidebar_get_default_page_name(args: { parentId: string; treeCollection: PagesSidebar_Collection }) {
	const normalizedParentId = pages_sidebar_normalize_parent_id(args.parentId);
	const siblingIds = args.treeCollection[normalizedParentId]?.children ?? [];
	const activeSiblingNames = new Set<string>();

	for (const siblingId of siblingIds) {
		const siblingItem = args.treeCollection[siblingId];
		if (!siblingItem || siblingItem.data.type !== "page") {
			continue;
		}
		if (siblingItem.data.archiveOperationId !== undefined) {
			continue;
		}

		activeSiblingNames.add(siblingItem.data.title.trim().toLowerCase());
	}

	const baseName = "New Page";
	if (!activeSiblingNames.has(baseName.toLowerCase())) {
		return baseName;
	}

	let suffix = 2;
	for (;;) {
		const candidateName = `${baseName} ${suffix}`;
		if (!activeSiblingNames.has(candidateName.toLowerCase())) {
			return candidateName;
		}
		suffix += 1;
	}
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
		archiveOperationId: undefined,
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
	const pageItemsById = new Map(pageItems.map((item) => [item.index, item]));
	for (const pageItem of pageItems) {
		if (pageItem.archiveOperationId !== undefined && !args.showArchived) {
			continue;
		}

		collection[pageItem.index] = {
			index: pageItem.index,
			data: pageItem,
			children: [],
		};
	}

	for (const pageItem of pageItems) {
		if (pageItem.archiveOperationId !== undefined && !args.showArchived) {
			continue;
		}
		if (!collection[pageItem.index]) {
			continue;
		}

		const parentId = pageItem.parentId;
		if (parentId === pages_ROOT_ID) {
			collection[pages_ROOT_ID]?.children.push(pageItem.index);
			continue;
		}

		const visitedParentIds = new Set<string>();
		let resolvedParentId = parentId;
		while (resolvedParentId && resolvedParentId !== pages_ROOT_ID && !collection[resolvedParentId]) {
			if (visitedParentIds.has(resolvedParentId)) {
				resolvedParentId = pages_ROOT_ID;
				break;
			}
			visitedParentIds.add(resolvedParentId);

			const currentParentItem = pageItemsById.get(resolvedParentId);
			if (!currentParentItem) {
				resolvedParentId = pages_ROOT_ID;
				break;
			}

			resolvedParentId = currentParentItem.parentId;
		}

		if (!resolvedParentId || resolvedParentId === pages_ROOT_ID) {
			collection[pages_ROOT_ID]?.children.push(pageItem.index);
			continue;
		}

		collection[resolvedParentId]?.children.push(pageItem.index);
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
		(["index", "parentId", "title", "archiveOperationId", "updatedAt", "updatedBy"] satisfies Array<
			keyof pages_TreeItem
		>);

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

// #region tree item secondary action
type PagesSidebarTreeItemSecondaryAction_ClassNames = "PagesSidebarTreeItemSecondaryAction";

type PagesSidebarTreeItemSecondaryAction_Props = {
	className?: string;
	children: React.ReactNode;
	tooltip: string | undefined;
	isActive: boolean;
	disabled?: boolean;
	onClick: () => void;
};

function PagesSidebarTreeItemSecondaryAction(props: PagesSidebarTreeItemSecondaryAction_Props) {
	const { className, children, tooltip, isActive, disabled, onClick } = props;

	const handleClick = useFn<MyIconButton_Props["onClick"]>(() => {
		onClick();
	});

	return (
		<MyIconButton
			variant="ghost-highlightable"
			className={cn(
				"PagesSidebarTreeItemSecondaryAction" satisfies PagesSidebarTreeItemSecondaryAction_ClassNames,
				className,
			)}
			tooltip={tooltip}
			side="bottom"
			tabIndex={isActive ? 0 : -1}
			onClick={handleClick}
			disabled={disabled}
		>
			<MyIconButtonIcon>{children}</MyIconButtonIcon>
		</MyIconButton>
	);
}
// #endregion tree item secondary action

// #region tree item secondary action create page
type PagesSidebarTreeItemSecondaryActionCreatePage_ClassNames = "PagesSidebarTreeItemSecondaryActionCreatePage";

type PagesSidebarTreeItemSecondaryActionCreatePage_Props = {
	isActive: boolean;
	disabled?: boolean;
	onClick: () => void;
};

function PagesSidebarTreeItemSecondaryActionCreatePage(props: PagesSidebarTreeItemSecondaryActionCreatePage_Props) {
	const { isActive, disabled, onClick } = props;

	return (
		<PagesSidebarTreeItemSecondaryAction
			className={cn(
				"PagesSidebarTreeItemSecondaryActionCreatePage" satisfies PagesSidebarTreeItemSecondaryActionCreatePage_ClassNames,
			)}
			tooltip="Add child"
			isActive={isActive}
			disabled={disabled}
			onClick={onClick}
		>
			<Plus />
		</PagesSidebarTreeItemSecondaryAction>
	);
}
// #endregion tree item secondary action create page

// #region tree item more action
type PagesSidebarTreeItemMoreAction_ClassNames = "PagesSidebarTreeItemMoreAction";

type PagesSidebarTreeItemMoreAction_Props = {
	archiveOperationId: string | undefined;
	isPending: boolean;
	isTabbable: boolean;
	onRename: () => void;
	onArchive: () => void;
	onUnarchive: () => void;
};

function PagesSidebarTreeItemMoreAction(props: PagesSidebarTreeItemMoreAction_Props) {
	const { archiveOperationId, isPending, isTabbable, onRename, onArchive, onUnarchive } = props;
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

	return (
		<MyMenu>
			<MyMenuTrigger tabIndex={isTabbable ? 0 : -1}>
				<MyIconButton
					className={cn("PagesSidebarTreeItemMoreAction" satisfies PagesSidebarTreeItemMoreAction_ClassNames)}
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
					<MyMenuItem disabled={isPending} onClick={handleRenameClick}>
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
}
// #endregion tree item more action

// #region tree item arrow
type PagesSidebarTreeItemArrow_ClassNames = "PagesSidebarTreeItemArrow";

type PagesSidebarTreeItemArrow_Props = {
	isExpanded: boolean;
	isPending: boolean;
	isTabbable: boolean;
	onClick: () => void;
};

function PagesSidebarTreeItemArrow(props: PagesSidebarTreeItemArrow_Props) {
	const { isExpanded, isPending, isTabbable, onClick } = props;

	return (
		<MyIconButton
			className={"PagesSidebarTreeItemArrow" satisfies PagesSidebarTreeItemArrow_ClassNames}
			tooltip={isExpanded ? "Collapse page" : "Expand page"}
			side="bottom"
			variant="ghost-highlightable"
			tabIndex={isTabbable ? 0 : -1}
			onClick={onClick}
			disabled={isPending}
		>
			<MyIconButtonIcon>{isExpanded ? <ChevronDown /> : <ChevronRight />}</MyIconButtonIcon>
		</MyIconButton>
	);
}
// #endregion tree item arrow

// #region tree item title
type PagesSidebarTreeItemTitle_ClassNames = "PagesSidebarTreeItemTitle" | "PagesSidebarTreeItemTitle-input";

type PagesSidebarTreeItemTitle_Props = {
	tree: PagesSidebarTree_Shared;
	item: PagesSidebarTreeItem_Instance;
};

function PagesSidebarTreeItemTitle(props: PagesSidebarTreeItemTitle_Props) {
	const { item } = props;

	const renameInputProps = useVal(() => item.getRenameInputProps());
	const isRenaming = useVal(() => item.isRenaming());
	const itemData = useVal(() => item.getItemData());

	return (
		<MyInput
			className={"PagesSidebarTreeItemTitle" satisfies PagesSidebarTreeItemTitle_ClassNames}
			variant="transparent"
		>
			<MyInputBox />
			<MyInputControl
				{...(isRenaming ? renameInputProps : null)}
				className={"PagesSidebarTreeItemTitle-input" satisfies PagesSidebarTreeItemTitle_ClassNames}
				readOnly={!isRenaming}
				tabIndex={isRenaming ? undefined : -1}
				value={!isRenaming ? itemData.title : undefined}
			/>
		</MyInput>
	);
}
// #endregion tree item title

// #region tree item primary content
type PagesSidebarTreeItemPrimaryContent_ClassNames = "PagesSidebarTreeItemPrimaryContent";

type PagesSidebarTreeItemPrimaryContent_Props = {
	tree: PagesSidebarTree_Shared;
	item: PagesSidebarTreeItem_Instance;
};

function PagesSidebarTreeItemPrimaryContent(props: PagesSidebarTreeItemPrimaryContent_Props) {
	const { tree, item } = props;

	return (
		<div
			className={"PagesSidebarTreeItemPrimaryContent" satisfies PagesSidebarTreeItemPrimaryContent_ClassNames}
			aria-hidden="true"
		>
			<PagesSidebarTreeItemIcon />
			<PagesSidebarTreeItemTitle tree={tree} item={item} />
		</div>
	);
}
// #endregion tree item primary content

// #region tree item primary action
type PagesSidebarTreeItemPrimaryAction_ClassNames = "PagesSidebarTreeItemPrimaryAction";

type PagesSidebarTreeItemPrimaryAction_Props = {
	tree: PagesSidebarTree_Shared;
	item: PagesSidebarTreeItem_Instance;
	isPending: boolean;
	isTreeDragging: boolean;
	onTreeItemPrimaryClick: (event: React.MouseEvent<HTMLButtonElement>, itemId: string) => void;
};

function PagesSidebarTreeItemPrimaryAction(props: PagesSidebarTreeItemPrimaryAction_Props) {
	const { item, isPending, isTreeDragging, onTreeItemPrimaryClick } = props;

	const itemProps = useVal(() => item.getProps());
	const isSelected = useVal(() => item.isSelected());
	const itemData = useVal(() => item.getItemData());

	const handleClick: MyPrimaryAction_Props["onClick"] = (event) => {
		onTreeItemPrimaryClick(event, item.getId());
	};

	return (
		<MyPrimaryAction
			{...itemProps}
			selected={isSelected}
			className={"PagesSidebarTreeItemPrimaryAction" satisfies PagesSidebarTreeItemPrimaryAction_ClassNames}
			disabled={isPending}
			tooltip={
				isTreeDragging
					? undefined
					: `Updated ${format_relative_time(itemData.updatedAt, { prefixForDatesPast7Days: "the " })} by ${itemData.updatedBy || "Unknown"}`
			}
			tooltipTimeout={2000}
			aria-label={itemData.title}
			onClick={handleClick}
		></MyPrimaryAction>
	);
}
// #endregion tree item primary action

// #region tree item meta label
type PagesSidebarTreeItemMetaLabel_ClassNames = "PagesSidebarTreeItemMetaLabel" | "PagesSidebarTreeItemMetaLabel-text";

type PagesSidebarTreeItemMetaLabel_Props = {
	metaText: string;
};

function PagesSidebarTreeItemMetaLabel(props: PagesSidebarTreeItemMetaLabel_Props) {
	const { metaText } = props;

	return (
		<div className={"PagesSidebarTreeItemMetaLabel" satisfies PagesSidebarTreeItemMetaLabel_ClassNames}>
			<div className={"PagesSidebarTreeItemMetaLabel-text" satisfies PagesSidebarTreeItemMetaLabel_ClassNames}>
				{metaText}
			</div>
		</div>
	);
}
// #endregion tree item meta label

// #region tree item actions
type PagesSidebarTreeItemActions_ClassNames = "PagesSidebarTreeItemActions";

type PagesSidebarTreeItemActions_Props = {
	archiveOperationId: PagesSidebarTreeItemMoreAction_Props["archiveOperationId"];
	isPending: boolean;
	isTabbable: boolean;
	onCreatePage: PagesSidebarTreeItemSecondaryAction_Props["onClick"];
	onRename: PagesSidebarTreeItemMoreAction_Props["onRename"];
	onArchive: PagesSidebarTreeItemMoreAction_Props["onArchive"];
	onUnarchive: PagesSidebarTreeItemMoreAction_Props["onUnarchive"];
};

function PagesSidebarTreeItemActions(props: PagesSidebarTreeItemActions_Props) {
	const { archiveOperationId, isPending, isTabbable, onCreatePage, onRename, onArchive, onUnarchive } = props;

	return (
		<div className={"PagesSidebarTreeItemActions" satisfies PagesSidebarTreeItemActions_ClassNames}>
			<PagesSidebarTreeItemSecondaryActionCreatePage
				isActive={isTabbable}
				disabled={isPending}
				onClick={onCreatePage}
			/>
			<PagesSidebarTreeItemMoreAction
				archiveOperationId={archiveOperationId}
				isPending={isPending}
				isTabbable={isTabbable}
				onRename={onRename}
				onArchive={onArchive}
				onUnarchive={onUnarchive}
			/>
		</div>
	);
}
// #endregion tree item actions

// #region tree item
type PagesSidebarTreeItem_ClassNames =
	| "PagesSidebarTreeItem"
	| "PagesSidebarTreeItem-content-navigated"
	| "PagesSidebarTreeItem-content-dragging-target"
	| "PagesSidebarTreeItem-content-archived"
	| "PagesSidebarTreeItem-content-placeholder";

type PagesSidebarTreeItem_CustomAttributes = {
	"data-item-id": string;
	"data-page-id": string;
};

type PagesSidebar_CssVars = {
	"--PagesSidebarTreeItem-content-depth": number;
};

type PagesSidebarTreeItem_Props = {
	itemId: string;
	tree: PagesSidebarTree_Shared;
	item: PagesSidebarTreeItem_Instance;
	selectedPageId: string | null;
	isBusy: boolean;
	pendingActionPageIds: Set<string>;
	isTreeDragging: boolean;
	isHidden: boolean;
	onCreatePage: (parentPageId: string) => void;
	onStartRename: (itemId: string) => void;
	onArchive: (pageId: string) => void;
	onUnarchive: (pageId: string) => void;
	onTreeItemPrimaryClick: (event: React.MouseEvent<HTMLButtonElement>, itemId: string) => void;
};

function PagesSidebarTreeItem(props: PagesSidebarTreeItem_Props) {
	const {
		itemId,
		tree,
		item,
		selectedPageId,
		isBusy,
		pendingActionPageIds,
		isTreeDragging,
		isHidden,
		onCreatePage,
		onStartRename,
		onArchive,
		onUnarchive,
		onTreeItemPrimaryClick,
	} = props;

	const itemData = useVal(() => item.getItemData());
	const isPlaceholder = itemData.type === "placeholder";
	const isArchived = itemData.archiveOperationId !== undefined;
	const isNavigated = selectedPageId === itemId;
	const isPending = isBusy || pendingActionPageIds.has(itemId);
	const isTabbableRow = useVal(() => item.isFocused());
	const depth = useVal(() => item.getItemMeta().level);
	const pageIdForDebug = itemData.type === "placeholder" ? itemData.parentId : itemId;
	const isDragTarget = useVal(() => item.isDraggingOver());

	const shouldRenderMeta = !isPlaceholder;
	const metaText = shouldRenderMeta
		? `${format_relative_time(itemData.updatedAt)} ${itemData.updatedBy || "Unknown"}`
		: "";

	const isExpanded = tree().getState().expandedItems.includes(itemId);

	const handleCreatePageClick = useFn<PagesSidebarTreeItemSecondaryAction_Props["onClick"]>(() => {
		onCreatePage(itemId);
	});

	const handleRenameClick = useFn<PagesSidebarTreeItemMoreAction_Props["onRename"]>(() => {
		onStartRename(itemId);
	});

	const handleArchiveClick = useFn<PagesSidebarTreeItemMoreAction_Props["onArchive"]>(() => {
		onArchive(itemId);
	});

	const handleUnarchiveClick = useFn<PagesSidebarTreeItemMoreAction_Props["onUnarchive"]>(() => {
		onUnarchive(itemId);
	});

	const handleTreeItemArrowClick = useFn<PagesSidebarTreeItemArrow_Props["onClick"]>(() => {
		if (isExpanded) {
			item.collapse();
		} else {
			item.expand();
		}
	});

	return (
		<div
			hidden={isHidden}
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
			{...({
				"data-item-id": itemId,
				"data-page-id": pageIdForDebug,
			} satisfies Partial<PagesSidebarTreeItem_CustomAttributes>)}
		>
			{isPlaceholder ? (
				<PagesSidebarTreeItemPrimaryContent tree={tree} item={item} />
			) : (
				<>
					<PagesSidebarTreeItemPrimaryAction
						tree={tree}
						item={item}
						isPending={isPending}
						isTreeDragging={isTreeDragging}
						onTreeItemPrimaryClick={onTreeItemPrimaryClick}
					/>

					<PagesSidebarTreeItemPrimaryContent tree={tree} item={item} />

					<PagesSidebarTreeItemArrow
						isExpanded={isExpanded}
						isPending={isPending}
						isTabbable={isTabbableRow}
						onClick={handleTreeItemArrowClick}
					/>

					<PagesSidebarTreeItemMetaLabel metaText={metaText} />

					<PagesSidebarTreeItemActions
						archiveOperationId={itemData.archiveOperationId}
						isPending={isPending}
						isTabbable={isTabbableRow}
						onCreatePage={handleCreatePageClick}
						onRename={handleRenameClick}
						onArchive={handleArchiveClick}
						onUnarchive={handleUnarchiveClick}
					/>
				</>
			)}
		</div>
	);
}
// #endregion tree item

// #region search
type PagesSidebarSearch_ClassNames = "PagesSidebarSearch";

type PagesSidebarSearch_Props = {
	onSearchQueryChange: (searchQuery: string) => void;
};

function PagesSidebarSearch(props: PagesSidebarSearch_Props) {
	const { onSearchQueryChange } = props;

	const [searchQuery, setSearchQuery] = useState("");
	const searchQueryDebounced = useDebounce(searchQuery, 300);

	const handleInputChange = useFn<React.ComponentProps<typeof MyInputControl>["onChange"]>((event) => {
		setSearchQuery(event.target.value);
	});

	useEffect(() => {
		onSearchQueryChange(searchQueryDebounced);
	}, [searchQueryDebounced]);

	return (
		<MyInput className={cn("PagesSidebarSearch" satisfies PagesSidebarSearch_ClassNames)} variant="surface">
			<MyInputArea>
				<MyInputBox />
				<MyInputIcon>
					<Search />
				</MyInputIcon>
				<MyInputControl placeholder="Search pages" value={searchQuery} onChange={handleInputChange} />
			</MyInputArea>
		</MyInput>
	);
}
// #endregion search

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
	isSearchActive: boolean;
	treeItemIds: string[];
	visibleTreeItemIds: Set<string>;
	visibleIds: Set<string> | null;
	selectedPageId: string | null;
	isBusy: boolean;
	pendingActionPageIds: Set<string>;
	onCreatePage: (parentPageId: string) => void;
	onStartRename: (itemId: string) => void;
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
		isSearchActive,
		visibleTreeItemIds,
		visibleIds,
		selectedPageId,
		isBusy,
		pendingActionPageIds,
		onCreatePage,
		onStartRename,
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
		onStartRename(focusedItem.getId());
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
			) : (
				<>
					{showEmptyState ? (
						<div className={cn("PagesSidebarTree-empty-state" satisfies PagesSidebarTree_ClassNames)}>
							{isSearchActive ? "No pages match your search." : "No pages yet."}
						</div>
					) : null}
					{tree()
						.getItems()
						.map((item) => (
							<PagesSidebarTreeItem
								key={item.getId()}
								itemId={item.getId()}
								tree={tree}
								item={item}
								selectedPageId={selectedPageId}
								isBusy={isBusy}
								pendingActionPageIds={pendingActionPageIds}
								isTreeDragging={isTreeDragging}
								isHidden={!visibleTreeItemIds.has(item.getId()) || (!!visibleIds && !visibleIds.has(item.getId()))}
								onCreatePage={onCreatePage}
								onStartRename={onStartRename}
								onArchive={onArchive}
								onUnarchive={onUnarchive}
								onTreeItemPrimaryClick={onTreeItemPrimaryClick}
							/>
						))}
				</>
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
	const convex = useConvex();
	const { toggleSidebar } = MainAppSidebar.useSidebar();
	const homePageId = useAppGlobalStore((state) => state.pages_home_id);

	const queriedTreeItemsList = useQuery(app_convex_api.ai_docs_temp.get_tree_items_list, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
	});
	const [resolvedTreeItemsList, setResolvedTreeItemsList] = useState<typeof queriedTreeItemsList>(undefined);
	const treeItemsList = queriedTreeItemsList ?? resolvedTreeItemsList;

	const [searchQuery, setSearchQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const [isCreatingPage, setIsCreatingPage] = useState(false);
	const [isArchivingSelection, setIsArchivingSelection] = useState(false);
	const [pendingActionPageIds, setPendingActionPageIds] = useState<Set<string>>(new Set());

	const lastTreeItemsListRef = useRef<typeof treeItemsList>(undefined);
	const expandedItemsBeforeSearchRef = useRef<string[] | null>(null);

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
		return treeItemsList.filter((item) => item.type === "page" && item.archiveOperationId !== undefined).length;
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

	const canDrag = useFn<NonNullable<Parameters<typeof useTree<pages_TreeItem>>[0]["canDrag"]>>((items) => {
		return items.every((item) => item.getItemData().type === "page");
	});

	const canDrop = useFn<NonNullable<Parameters<typeof useTree<pages_TreeItem>>[0]["canDrop"]>>((items, target) => {
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
	});

	const handleDrop = useFn<NonNullable<Parameters<typeof useTree<pages_TreeItem>>[0]["onDrop"]>>((items, target) => {
		const pageIds = items.map((item) => item.getId());
		const targetParentId = target.item.getId();

		const movedPageIds = pageIds.filter((pageId) => treeCollection[pageId]?.data.type === "page");
		if (movedPageIds.length === 0) {
			return;
		}

		return convex
			.mutation(app_convex_api.ai_docs_temp.move_pages, {
				itemIds: movedPageIds.map((itemId) => pages_sidebar_to_page_id(itemId)),
				targetParentId: pages_sidebar_to_parent_id(targetParentId),
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
			})
			.then((result) => {
				if (result._nay) {
					console.error("[PagesSidebar.movePagesToParent] Failed to move pages", { result });
					return;
				}
			})
			.catch((error) => console.error("[PagesSidebar.movePagesToParent] Error moving pages", { error }));
	});

	const canRename = useFn<NonNullable<Parameters<typeof useTree<pages_TreeItem>>[0]["canRename"]>>((item) => {
		return item.getItemData().type === "page";
	});

	const handleRename = useFn<NonNullable<Parameters<typeof useTree<pages_TreeItem>>[0]["onRename"]>>((item, value) => {
		const trimmedValue = value.trim();
		const itemData = item.getItemData();
		console.info("[PagesSidebarRenameDebug.onRename]", {
			itemId: item.getId(),
			value,
			trimmedValue,
			currentTitle: itemData.title,
		});
		if (itemData.type !== "page") {
			return;
		}
		if (!trimmedValue || trimmedValue === itemData.title) {
			return;
		}

		markPageAsPending(item.getId());
		convex
			.mutation(
				app_convex_api.ai_docs_temp.rename_page,
				{
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					pageId: pages_sidebar_to_page_id(item.getId()),
					name: trimmedValue,
				},
				{
					optimisticUpdate: (localStore, args) => {
						const treeItemsList = localStore.getQuery(app_convex_api.ai_docs_temp.get_tree_items_list, {
							workspaceId: ai_chat_HARDCODED_ORG_ID,
							projectId: ai_chat_HARDCODED_PROJECT_ID,
						});
						if (!treeItemsList) {
							return;
						}
						localStore.setQuery(
							app_convex_api.ai_docs_temp.get_tree_items_list,
							{
								workspaceId: ai_chat_HARDCODED_ORG_ID,
								projectId: ai_chat_HARDCODED_PROJECT_ID,
							},
							treeItemsList.map((treeItem) => {
								if (treeItem._id === item.getId()) {
									return {
										...treeItem,
										title: args.name,
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
					console.error("[PagesSidebar.handleRename] Failed to rename page", { result });
				}
			})
			.catch((error) => {
				console.error("[PagesSidebar.handleRename] Error on rename page", { error });
			})
			.finally(() => {
				unmarkPageAsPending(item.getId());
			});
	});

	const handlePrimaryAction = useFn<NonNullable<Parameters<typeof useTree<pages_TreeItem>>[0]["onPrimaryAction"]>>(
		(item) => {
			const itemData = item.getItemData();
			if (itemData.type === "page") {
				onPrimaryAction(item.getId(), itemData.type);
			}
		},
	);

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
		canDrag,
		canDrop,
		onDrop: handleDrop,
		canRename,
		onRename: handleRename,
		onPrimaryAction: handlePrimaryAction,
	});

	const hasSelectedPageInTree = !!(selectedPageId && treeCollection[selectedPageId]);

	const treeItems = tree().getItems();
	const visibleTreeItemIds = new Set(
		treeItems
			.map((item) => item.getId())
			.filter((itemId) => {
				return itemId !== pages_ROOT_ID;
			}),
	);

	const searchQueryDeferred = useDeferredValue(searchQuery);

	const searchFilter = ((/* iife */) => {
		const searchQueryNormalized = searchQueryDeferred.trim().toLowerCase();
		if (!searchQueryNormalized) {
			return null;
		}

		const visibleIds = new Set<string>();
		const expandedIds = new Set<string>([pages_ROOT_ID]);
		const isVisible = (id: string): boolean => {
			const current = treeCollection[id];
			if (!current) {
				return false;
			}
			if (current.data.type === "placeholder") {
				return false;
			}

			const selfMatch = current.data.title.toLowerCase().includes(searchQueryNormalized);
			let childMatch = false;
			for (const childId of current.children) {
				if (isVisible(childId)) {
					childMatch = true;
					expandedIds.add(id);
				}
			}

			const visible = selfMatch || childMatch;
			if (visible) {
				visibleIds.add(id);
			}
			return visible;
		};

		isVisible(pages_ROOT_ID);
		return {
			visibleIds,
			expandedIds: [...expandedIds],
		};
	})();

	const visibleIds = searchFilter?.visibleIds ?? null;
	const isSearchActive = searchQueryDeferred.trim().length > 0;

	const selectedPageIds = treeItems
		.filter((item) => item.isSelected() && item.getItemData().type === "page")
		.map((item) => item.getId());

	const multiSelectionCount = selectedPageIds.length;
	const isBusy = isCreatingPage || isArchivingSelection;
	const isTreeLoading = treeItemsList === undefined;
	const treeItemIds = ((/* iife */) => {
		const allItemIds: string[] = [];
		const visitedIds = new Set<string>();

		const visit = (itemId: string) => {
			const childrenIds = treeCollection[itemId]?.children ?? [];
			for (const childId of childrenIds) {
				if (childId === pages_ROOT_ID || visitedIds.has(childId)) {
					continue;
				}

				visitedIds.add(childId);
				allItemIds.push(childId);
				visit(childId);
			}
		};

		visit(pages_ROOT_ID);
		return allItemIds;
	})();
	const visibleTreeItemCount = treeItemIds.filter((itemId) => {
		if (!visibleTreeItemIds.has(itemId)) {
			return false;
		}
		return !isSearchActive || !visibleIds || visibleIds.has(itemId);
	}).length;
	const showEmptyState = !isTreeLoading && visibleTreeItemCount === 0;

	const startRename = useFn((itemId: string) => {
		const item = tree().getItemInstance(itemId);
		if (item.getItemData().type !== "page") {
			return;
		}

		item.setFocused();
		item.startRenaming();
	});

	const handleStartRename = useFn<PagesSidebarTree_Props["onStartRename"]>((itemId) => {
		startRename(itemId);
	});

	const handleCreatePageClick = useFn<PagesSidebarTree_Props["onCreatePage"]>((parentPageId) => {
		const nextPageName = pages_sidebar_get_default_page_name({
			parentId: parentPageId,
			treeCollection,
		});

		setIsCreatingPage(true);
		convex
			.mutation(app_convex_api.ai_docs_temp.create_page, {
				parentId: pages_sidebar_to_parent_id(parentPageId),
				name: nextPageName,
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
			})
			.then((result) => {
				if (result._nay) {
					console.error("[PagesSidebar.handleCreatePageClick] Error creating page", {
						result,
					});
					return;
				}

				return navigate({
					to: "/pages",
					search: { pageId: result._yay.pageId, view },
				}).then(() => {
					return startRename(result._yay.pageId);
				});
			})
			.catch((error) => {
				console.error("[PagesSidebar.handleCreatePageClick] Error creating page", { error });
			})
			.finally(() => {
				setIsCreatingPage(false);
			});
	});

	const handleArchive = useFn<PagesSidebarTree_Props["onArchive"]>((pageId) => {
		const shouldArchiveSelectedPages = selectedPageIds.length > 1 && selectedPageIds.includes(pageId);
		const pageIdsToArchive = shouldArchiveSelectedPages ? selectedPageIds : [pageId];

		if (shouldArchiveSelectedPages) {
			setIsArchivingSelection(true);
		} else {
			markPageAsPending(pageId);
		}

		convex
			.mutation(app_convex_api.ai_docs_temp.archive_pages, {
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
			.catch((error) => {
				console.error("[PagesSidebar.handleArchive] Error archiving pages", {
					error,
					pageIdsToArchive,
				});
			})
			.finally(() => {
				if (shouldArchiveSelectedPages) {
					tree().setSelectedItems([]);
					setIsArchivingSelection(false);
					return;
				}

				unmarkPageAsPending(pageId);
			});
	});

	const handleUnarchive = useFn<PagesSidebarTree_Props["onUnarchive"]>((pageId) => {
		markPageAsPending(pageId);
		convex
			.mutation(app_convex_api.ai_docs_temp.unarchive_pages, {
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageIds: [pages_sidebar_to_page_id(pageId)],
			})
			.then((result) => {
				if (result._nay) {
					console.error("[PagesSidebar.handleUnarchive] Error unarchiving page", { result, pageId });
					return;
				}
			})
			.catch((error) => {
				console.error("[PagesSidebar.handleUnarchive] Error unarchiving page", { error, pageId });
			})
			.finally(() => {
				unmarkPageAsPending(pageId);
			});
	});

	const handleTreeItemPrimaryClick = useFn<PagesSidebarTree_Props["onTreeItemPrimaryClick"]>((event, itemId) => {
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
	});

	const handleExpandAllClick = useFn(() => {
		tree()
			.expandAll()
			.catch((error) => {
				console.error("[PagesSidebar.handleExpandAllClick] Error expanding tree", { error });
			});
	});

	const handleCollapseAllClick = useFn(() => {
		tree().collapseAll();
	});

	const handleClearSelectionClick = useFn(() => {
		tree().setSelectedItems([]);
	});

	const handleCreateRootPageClick = useFn(() => {
		handleCreatePageClick(pages_ROOT_ID);
	});

	const handleArchiveToggleClick = useFn(() => {
		setShowArchived((oldValue) => !oldValue);
	});

	useLayoutEffect(() => {
		const shouldRebuild =
			lastIsArchivedShownRef.current !== isArchivedShown ||
			!pages_sidebar_are_tree_items_lists_equal(lastTreeItemsListRef.current, treeItemsList, {
				fields: ["type", "index", "parentId", "title", "archiveOperationId"],
			});

		lastIsArchivedShownRef.current = isArchivedShown;
		lastTreeItemsListRef.current = treeItemsList;

		if (!shouldRebuild) {
			return;
		}

		tree().rebuildTree();
	}, [isArchivedShown, treeItemsList]);

	useEffect(() => {
		if (queriedTreeItemsList === undefined) {
			return;
		}
		setResolvedTreeItemsList((currentValue) => {
			if (
				pages_sidebar_are_tree_items_lists_equal(currentValue, queriedTreeItemsList, {
					fields: ["index", "parentId", "title", "archiveOperationId", "updatedAt", "updatedBy"],
				})
			) {
				return currentValue;
			}
			return queriedTreeItemsList;
		});
	}, [queriedTreeItemsList]);

	useLayoutEffect(() => {
		const treeInstance = tree();
		const searchExpandedIds = searchFilter?.expandedIds;
		if (!searchExpandedIds) {
			const expandedItemsBeforeSearch = expandedItemsBeforeSearchRef.current;
			if (!expandedItemsBeforeSearch) {
				return;
			}
			const currentExpandedItems = treeInstance.getState().expandedItems;
			const hasSameExpandedItems =
				currentExpandedItems.length === expandedItemsBeforeSearch.length &&
				currentExpandedItems.every((itemId) => expandedItemsBeforeSearch.includes(itemId));

			expandedItemsBeforeSearchRef.current = null;
			if (hasSameExpandedItems) {
				return;
			}
			treeInstance.applySubStateUpdate("expandedItems", [...expandedItemsBeforeSearch]);
			treeInstance.scheduleRebuildTree();
			return;
		}

		if (!expandedItemsBeforeSearchRef.current) {
			expandedItemsBeforeSearchRef.current = [...treeInstance.getState().expandedItems];
		}

		const currentExpandedItems = treeInstance.getState().expandedItems;
		const nextExpandedItemsSet = new Set(currentExpandedItems);
		let hasNewExpandedItem = false;
		for (const itemId of searchExpandedIds) {
			if (nextExpandedItemsSet.has(itemId)) {
				continue;
			}
			nextExpandedItemsSet.add(itemId);
			hasNewExpandedItem = true;
		}
		if (!hasNewExpandedItem) {
			return;
		}

		treeInstance.applySubStateUpdate("expandedItems", [...nextExpandedItemsSet]);
		treeInstance.scheduleRebuildTree();
	}, [searchFilter, tree]);

	useEffect(() => {
		if (!selectedPageId || !hasSelectedPageInTree) {
			return;
		}
		tree().getItemInstance(selectedPageId).setFocused();
	}, [hasSelectedPageInTree, selectedPageId]);

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

					<PagesSidebarSearch onSearchQueryChange={setSearchQuery} />

					<div className={cn("PagesSidebar-actions" satisfies PagesSidebar_ClassNames)}>
						<div className={cn("PagesSidebar-actions-group" satisfies PagesSidebar_ClassNames)}>
							<MyIconButton
								className={cn("PagesSidebar-actions-icon-button" satisfies PagesSidebar_ClassNames)}
								variant="secondary-subtle"
								tooltip="Unfold"
								onClick={handleExpandAllClick}
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
								onClick={handleCollapseAllClick}
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
										onClick={handleClearSelectionClick}
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
								onClick={handleCreateRootPageClick}
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
							onClick={handleArchiveToggleClick}
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
						isSearchActive={isSearchActive}
						treeItemIds={treeItemIds}
						visibleTreeItemIds={visibleTreeItemIds}
						visibleIds={visibleIds}
						selectedPageId={selectedPageId}
						isBusy={isBusy}
						pendingActionPageIds={pendingActionPageIds}
						onCreatePage={handleCreatePageClick}
						onStartRename={handleStartRename}
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
