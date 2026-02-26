import "./pages-sidebar.css";
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
import { MySidebar, MySidebarContent, MySidebarHeader, type MySidebar_Props } from "@/components/my-sidebar.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { MyInput, MyInputArea, MyInputBox, MyInputControl, MyInputIcon } from "@/components/my-input.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon, type MyIconButton_Props } from "@/components/my-icon-button.tsx";
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
	type MyMenuItem_Props,
} from "@/components/my-menu.tsx";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID, cn, should_never_happen, sx } from "@/lib/utils.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import { useUiInteractedOutside } from "@/lib/ui.tsx";
import { useDebounce, useFn, useVal } from "@/hooks/utils-hooks.ts";
import { pages_ROOT_ID, pages_create_tree_root, type pages_EditorView, type pages_TreeItem } from "@/lib/pages.ts";
import { format_relative_time } from "@/lib/date.ts";
import type { FunctionReturnType } from "convex/server";

type PagesSidebarTree_Shared = () => TreeInstance<pages_TreeItem>;
type PagesSidebarTreeItem_Instance = ReturnType<TreeInstance<pages_TreeItem>["getItemInstance"]>;

// #region helpers
type PagesSidebar_TreeItems = {
	list: pages_TreeItem[] | undefined;
	itemsIds: Set<string>;
	itemsIdsByParentId: Map<string, Set<string>>;
	sortedItemsIdsByParentId: Map<string, string[]>;
	itemById: Map<string, pages_TreeItem>;
};

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

function pages_sidebar_get_default_page_name(args: { parentId: string; treeItems: PagesSidebar_TreeItems }) {
	const normalizedParentId = pages_sidebar_normalize_parent_id(args.parentId);
	const siblingIds = args.treeItems.sortedItemsIdsByParentId.get(normalizedParentId) ?? [];
	const activeSiblingNames = new Set<string>();

	for (const siblingId of siblingIds) {
		const siblingItem = args.treeItems.itemById.get(siblingId);
		if (!siblingItem || siblingItem.type !== "page") {
			continue;
		}
		if (siblingItem.archiveOperationId !== undefined) {
			continue;
		}

		activeSiblingNames.add(siblingItem.title.trim().toLowerCase());
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

function sort_children(args: { children: string[]; itemById: Map<string, pages_TreeItem> }) {
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
type PagesSidebarTreeItemIcon_ClassNames = "PagesSidebarTreeItemIcon";

const PagesSidebarTreeItemIcon = memo(function PagesSidebarTreeItemIcon() {
	return (
		<MyIcon className={"PagesSidebarTreeItemIcon" satisfies PagesSidebarTreeItemIcon_ClassNames}>
			<FileText />
		</MyIcon>
	);
});
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

const PagesSidebarTreeItemSecondaryAction = memo(function PagesSidebarTreeItemSecondaryAction(
	props: PagesSidebarTreeItemSecondaryAction_Props,
) {
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
});
// #endregion tree item secondary action

// #region tree item secondary action create page
type PagesSidebarTreeItemSecondaryActionCreatePage_ClassNames = "PagesSidebarTreeItemSecondaryActionCreatePage";

type PagesSidebarTreeItemSecondaryActionCreatePage_Props = {
	isActive: boolean;
	disabled?: boolean;
	onClick: () => void;
};

const PagesSidebarTreeItemSecondaryActionCreatePage = memo(function PagesSidebarTreeItemSecondaryActionCreatePage(
	props: PagesSidebarTreeItemSecondaryActionCreatePage_Props,
) {
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
});
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

const PagesSidebarTreeItemMoreAction = memo(function PagesSidebarTreeItemMoreAction(
	props: PagesSidebarTreeItemMoreAction_Props,
) {
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
});
// #endregion tree item more action

// #region tree item arrow
type PagesSidebarTreeItemArrow_ClassNames = "PagesSidebarTreeItemArrow" | "PagesSidebarTreeItemArrow-icon-button";

type PagesSidebarTreeItemArrow_Props = {
	isExpanded: boolean;
	isPending: boolean;
	isTabbable: boolean;
	onClick: () => void;
};

const PagesSidebarTreeItemArrow = memo(function PagesSidebarTreeItemArrow(props: PagesSidebarTreeItemArrow_Props) {
	const { isExpanded, isPending, isTabbable, onClick } = props;

	return (
		<div className={"PagesSidebarTreeItemArrow" satisfies PagesSidebarTreeItemArrow_ClassNames}>
			<MyIconButton
				className={"PagesSidebarTreeItemArrow-icon-button" satisfies PagesSidebarTreeItemArrow_ClassNames}
				tooltip={isExpanded ? "Collapse page" : "Expand page"}
				side="bottom"
				variant="ghost-highlightable"
				tabIndex={isTabbable ? 0 : -1}
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
type PagesSidebarTreeItemTitle_ClassNames = "PagesSidebarTreeItemTitle" | "PagesSidebarTreeItemTitle-input";

type PagesSidebarTreeItemTitle_Props = {
	renameInputProps: ReturnType<PagesSidebarTreeItem_Instance["getRenameInputProps"]>;
	isRenaming: boolean;
	title: string;
};

const PagesSidebarTreeItemTitle = memo(function PagesSidebarTreeItemTitle(props: PagesSidebarTreeItemTitle_Props) {
	const { renameInputProps, isRenaming, title } = props;

	const value = isRenaming ? (renameInputProps.value ?? "") : title;

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
				value={value}
			/>
		</MyInput>
	);
});
// #endregion tree item title

// #region tree item primary content
type PagesSidebarTreeItemPrimaryContent_ClassNames = "PagesSidebarTreeItemPrimaryContent";

type PagesSidebarTreeItemPrimaryContent_Props = {
	title: string;
	renameInputProps: ReturnType<PagesSidebarTreeItem_Instance["getRenameInputProps"]>;
	isRenaming: boolean;
};

const PagesSidebarTreeItemPrimaryContent = memo(function PagesSidebarTreeItemPrimaryContent(
	props: PagesSidebarTreeItemPrimaryContent_Props,
) {
	const { title, renameInputProps, isRenaming } = props;

	return (
		<div className={"PagesSidebarTreeItemPrimaryContent" satisfies PagesSidebarTreeItemPrimaryContent_ClassNames}>
			<PagesSidebarTreeItemIcon />
			<PagesSidebarTreeItemTitle renameInputProps={renameInputProps} isRenaming={isRenaming} title={title} />
		</div>
	);
});
// #endregion tree item primary content

// #region tree item primary action
type PagesSidebarTreeItemPrimaryAction_ClassNames = "PagesSidebarTreeItemPrimaryAction";

type PagesSidebarTreeItemPrimaryAction_Props = {
	itemProps: ReturnType<PagesSidebarTreeItem_Instance["getProps"]>;
	title: string;
	updatedAt: pages_TreeItem["updatedAt"];
	updatedBy: pages_TreeItem["updatedBy"];
	isPending: boolean;
	isSelected: boolean;
	isTreeDragging: boolean;
};

const PagesSidebarTreeItemPrimaryAction = memo(function PagesSidebarTreeItemPrimaryAction(
	props: PagesSidebarTreeItemPrimaryAction_Props,
) {
	const { itemProps, title, updatedAt, updatedBy, isPending, isSelected, isTreeDragging } = props;

	const tooltipContent = `Updated ${format_relative_time(updatedAt, { prefixForDatesPast7Days: "the " })} by ${updatedBy || "Unknown"}`;

	return (
		<MyPrimaryAction
			{...itemProps}
			className={"PagesSidebarTreeItemPrimaryAction" satisfies PagesSidebarTreeItemPrimaryAction_ClassNames}
			selected={isSelected}
			disabled={isPending}
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
type PagesSidebarTreeItemMetaLabel_ClassNames = "PagesSidebarTreeItemMetaLabel" | "PagesSidebarTreeItemMetaLabel-text";

type PagesSidebarTreeItemMetaLabel_Props = {
	metaText: string;
};

const PagesSidebarTreeItemMetaLabel = memo(function PagesSidebarTreeItemMetaLabel(
	props: PagesSidebarTreeItemMetaLabel_Props,
) {
	const { metaText } = props;

	return (
		<div className={"PagesSidebarTreeItemMetaLabel" satisfies PagesSidebarTreeItemMetaLabel_ClassNames}>
			<div className={"PagesSidebarTreeItemMetaLabel-text" satisfies PagesSidebarTreeItemMetaLabel_ClassNames}>
				{metaText}
			</div>
		</div>
	);
});
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

const PagesSidebarTreeItemActions = memo(function PagesSidebarTreeItemActions(
	props: PagesSidebarTreeItemActions_Props,
) {
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
});
// #endregion tree item actions

// #region tree item track
type PagesSidebarTreeItemTrack_ClassNames =
	| "PagesSidebarTreeItemTrack"
	| "PagesSidebarTreeItemTrack-guide"
	| "PagesSidebarTreeItemTrack-guide-depth-zero"
	| "PagesSidebarTreeItemTrack-guide-active";

type PagesSidebarTreeItemTrack_Props = {
	trackPagesIds: string[];
	trackActivePagesIds: Set<string>;
};

const PagesSidebarTreeItemTrack = memo(function PagesSidebarTreeItemTrack(props: PagesSidebarTreeItemTrack_Props) {
	const { trackPagesIds, trackActivePagesIds } = props;

	return (
		<div className={"PagesSidebarTreeItemTrack" satisfies PagesSidebarTreeItemTrack_ClassNames} aria-hidden="true">
			{trackPagesIds.map((ancestorId, ancestorIndex) => (
				<span
					key={ancestorId}
					className={cn(
						"PagesSidebarTreeItemTrack-guide" satisfies PagesSidebarTreeItemTrack_ClassNames,
						ancestorIndex === 0 &&
							("PagesSidebarTreeItemTrack-guide-depth-zero" satisfies PagesSidebarTreeItemTrack_ClassNames),
						trackActivePagesIds.has(ancestorId) &&
							("PagesSidebarTreeItemTrack-guide-active" satisfies PagesSidebarTreeItemTrack_ClassNames),
					)}
				/>
			))}
		</div>
	);
});
// #endregion tree item track

// #region tree item placeholder
type PagesSidebarTreeItemPlaceholder_ClassNames = "PagesSidebarTreeItemPlaceholder";

type PagesSidebarTreeItemPlaceholder_CssVars = {
	"--PagesSidebarTreeItemPlaceholder-depth": number;
};

type PagesSidebarTreeItemPlaceholder_Props = {
	itemId: string;
	ancestorIds: string[];
	trackActivePagesIds: Set<string>;
	onDragEnter: ComponentProps<"div">["onDragEnter"];
	onDragOver: ComponentProps<"div">["onDragOver"];
	onDragLeave: ComponentProps<"div">["onDragLeave"];
	onDrop: ComponentProps<"div">["onDrop"];
};

const PagesSidebarTreeItemPlaceholder = memo(function PagesSidebarTreeItemPlaceholder(
	props: PagesSidebarTreeItemPlaceholder_Props,
) {
	const { itemId, ancestorIds, trackActivePagesIds, onDragEnter, onDragOver, onDragLeave, onDrop } = props;

	const trackPagesIds = [...ancestorIds, itemId];
	const placeholderDepth = trackPagesIds.length;

	return (
		<div
			className={"PagesSidebarTreeItemPlaceholder" satisfies PagesSidebarTreeItemPlaceholder_ClassNames}
			style={sx({
				"--PagesSidebarTreeItemPlaceholder-depth": placeholderDepth,
			} satisfies Partial<PagesSidebarTreeItemPlaceholder_CssVars>)}
			onDragEnter={onDragEnter}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			<div
				className={"PagesSidebarTreeItemPrimaryContent" satisfies PagesSidebarTreeItemPrimaryContent_ClassNames}
				aria-hidden="true"
			>
				<PagesSidebarTreeItemIcon />
				<span>No pages inside</span>
			</div>
			<PagesSidebarTreeItemTrack trackPagesIds={trackPagesIds} trackActivePagesIds={trackActivePagesIds} />
		</div>
	);
});
// #endregion tree item placeholder

// #region tree item
type PagesSidebarTreeItem_ClassNames =
	| "PagesSidebarTreeItem"
	| "PagesSidebarTreeItem-content-navigated"
	| "PagesSidebarTreeItem-content-dragging-target"
	| "PagesSidebarTreeItem-content-archived";

type PagesSidebarTreeItem_CustomAttributes = {
	"data-item-id": string;
	"data-page-id": string;
};

type PagesSidebar_CssVars = {
	"--PagesSidebarTreeItem-content-depth": number;
};

type PagesSidebarTreeItem_Props = {
	tree: PagesSidebarTree_Shared;
	item: PagesSidebarTreeItem_Instance;
	trackActivePagesIds: Set<string>;
	selectedPageId: string | null;
	isSelected: boolean;
	isSearchActive: boolean;
	isBusy: boolean;
	pendingActionPageIds: Set<string>;
	isTreeDragging: boolean;
	onCreatePage: (parentPageId: string) => void;
	onStartRename: (itemId: string) => void;
	onArchive: (pageId: string) => void;
	onUnarchive: (pageId: string) => void;
};

const PagesSidebarTreeItem = memo(function PagesSidebarTreeItem(props: PagesSidebarTreeItem_Props) {
	const {
		tree,
		item,
		trackActivePagesIds,
		selectedPageId,
		isSelected,
		isSearchActive,
		isBusy,
		pendingActionPageIds,
		isTreeDragging,
		onCreatePage,
		onStartRename,
		onArchive,
		onUnarchive,
	} = props;

	const itemId = useVal(() => item.getId());
	const itemData = useVal(() => item.getItemData());
	const itemProps = useVal(() => item.getProps());
	const renameInputProps = useVal(() => item.getRenameInputProps());
	const isRenaming = useVal(() => item.isRenaming());
	const isArchived = itemData.archiveOperationId !== undefined;
	const isNavigated = selectedPageId === itemId;
	const isPending = isBusy || pendingActionPageIds.has(itemId);
	const isTabbableRow = useVal(() => item.isFocused());
	const depth = useVal(() => item.getItemMeta().level);
	const pageIdForDebug = itemId;
	const isDragTarget = useVal(() => item.isDraggingOver());
	const hasChildren = useVal(() => item.getChildren().length > 0);
	const isExpanded = useVal(() => tree().getState().expandedItems.includes(itemId));
	const ancestorIds = useVal(() => {
		const result: string[] = [];
		let parent = undefined;
		do {
			parent = (parent ?? item).getParent();

			if (parent && parent.getId() !== pages_ROOT_ID) {
				result.push(parent.getId());
			}
		} while (parent);

		return result.reverse();
	});

	const metaText = `${format_relative_time(itemData.updatedAt)} ${itemData.updatedBy || "Unknown"}`;
	const shouldRenderPlaceholder = !isSearchActive && itemData.type === "page" && !hasChildren && isExpanded;

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
					"PagesSidebarTreeItem" satisfies PagesSidebarTreeItem_ClassNames,
					isNavigated && ("PagesSidebarTreeItem-content-navigated" satisfies PagesSidebarTreeItem_ClassNames),
					isDragTarget && ("PagesSidebarTreeItem-content-dragging-target" satisfies PagesSidebarTreeItem_ClassNames),
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
				<PagesSidebarTreeItemPrimaryAction
					itemProps={itemProps}
					title={itemData.title}
					updatedAt={itemData.updatedAt}
					updatedBy={itemData.updatedBy}
					isPending={isPending}
					isSelected={isSelected}
					isTreeDragging={isTreeDragging}
				/>

				<PagesSidebarTreeItemPrimaryContent
					title={itemData.title}
					renameInputProps={renameInputProps}
					isRenaming={isRenaming}
				/>

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

				<PagesSidebarTreeItemTrack trackPagesIds={ancestorIds} trackActivePagesIds={trackActivePagesIds} />
			</div>

			{shouldRenderPlaceholder ? (
				<PagesSidebarTreeItemPlaceholder
					itemId={itemId}
					ancestorIds={ancestorIds}
					trackActivePagesIds={trackActivePagesIds}
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
type PagesSidebarTree_ClassNames =
	| "PagesSidebarTree"
	| "PagesSidebarTree-dragging"
	| "PagesSidebarTree-dragging-root-target"
	| "PagesSidebarTree-empty-state";

type PagesSidebarTree_Props = {
	tree: PagesSidebarTree_Shared;
	isTreeLoading: boolean;
	showEmptyState: boolean;
	isSearchActive: boolean;
	trackActivePagesIds: Set<string>;
	selectedPageId: string | null;
	selectedPageIds: Set<string>;
	isBusy: boolean;
	pendingActionPageIds: Set<string>;
	onCreatePage: (parentPageId: string) => void;
	onStartRename: (itemId: string) => void;
	onArchive: (pageId: string) => void;
	onUnarchive: (pageId: string) => void;
};

type PagesSidebarTree_DivProps = ComponentProps<"div">;

const PagesSidebarTree = memo(function PagesSidebarTree(props: PagesSidebarTree_Props) {
	const {
		tree,
		isTreeLoading,
		showEmptyState,
		isSearchActive,
		trackActivePagesIds,
		selectedPageId,
		selectedPageIds,
		isBusy,
		pendingActionPageIds,
		onCreatePage,
		onStartRename,
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

	const handleBlur: NonNullable<PagesSidebarTree_DivProps["onBlur"]> = (event) => {
		const nextFocusedElement = event.relatedTarget;
		if (event.currentTarget.contains(nextFocusedElement)) {
			return;
		}

		isTreeFocusedRef.current = false;
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

		const hoveredItemElement =
			event.target instanceof Element
				? event.target.closest(".PagesSidebarTreeItem, .PagesSidebarTreeItemPlaceholder")
				: null;
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
				isTreeDragging && ("PagesSidebarTree-dragging" satisfies PagesSidebarTree_ClassNames),
				isDraggingOverRootZone && ("PagesSidebarTree-dragging-root-target" satisfies PagesSidebarTree_ClassNames),
			)}
			{...tree().getContainerProps("Pages")}
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
						.map((item) => {
							const itemId = item.getId();
							return (
								<PagesSidebarTreeItem
									key={itemId}
									tree={tree}
									item={item}
									trackActivePagesIds={trackActivePagesIds}
									selectedPageId={selectedPageId}
									isSelected={selectedPageIds.has(itemId)}
									isSearchActive={isSearchActive}
									isBusy={isBusy}
									pendingActionPageIds={pendingActionPageIds}
									isTreeDragging={isTreeDragging}
									onCreatePage={onCreatePage}
									onStartRename={onStartRename}
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
type PagesSidebarSearch_ClassNames = "PagesSidebarSearch";

type PagesSidebarSearch_Props = {
	onSearchQueryChange: (searchQuery: string) => void;
};

const PagesSidebarSearch = memo(function PagesSidebarSearch(props: PagesSidebarSearch_Props) {
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
});
// #endregion search

// #region header
type PagesSidebarHeader_ClassNames =
	| "PagesSidebarHeader"
	| "PagesSidebarHeader-header"
	| "PagesSidebarHeader-top-section"
	| "PagesSidebarHeader-top-section-left"
	| "PagesSidebarHeader-hamburger-button"
	| "PagesSidebarHeader-title"
	| "PagesSidebarHeader-close-button"
	| "PagesSidebarHeader-actions"
	| "PagesSidebarHeader-actions-group"
	| "PagesSidebarHeader-actions-icon-button"
	| "PagesSidebarHeader-action-new-page"
	| "PagesSidebarHeader-archive-toggle"
	| "PagesSidebarHeader-multi-selection-counter"
	| "PagesSidebarHeader-multi-selection-counter-label";

type PagesSidebarHeader_Props = {
	homePageId: string | undefined;
	view: pages_EditorView;
	selectedPageIdsCount: number;
	isBusy: boolean;
	treeItemsList: FunctionReturnType<typeof app_convex_api.ai_docs_temp.get_tree_items_list> | undefined;
	showArchived: boolean;
	onToggleSidebar: () => void;
	onClose: () => void;
	onSearchQueryChange: (searchQuery: string) => void;
	onExpandAllClick: () => void;
	onCollapseAllClick: () => void;
	onClearSelectionClick: () => void;
	onCreateRootPageClick: () => void;
	onArchiveToggleClick: () => void;
};

const PagesSidebarHeader = memo(function PagesSidebarHeader(props: PagesSidebarHeader_Props) {
	const {
		homePageId,
		view,
		selectedPageIdsCount,
		isBusy,
		treeItemsList,
		showArchived,
		onToggleSidebar,
		onClose,
		onSearchQueryChange,
		onExpandAllClick,
		onCollapseAllClick,
		onClearSelectionClick,
		onCreateRootPageClick,
		onArchiveToggleClick,
	} = props;

	const archivedCount =
		treeItemsList?.filter((item) => item.type === "page" && item.archiveOperationId !== undefined).length ?? 0;

	return (
		<MySidebarHeader
			className={cn(
				"PagesSidebarHeader" satisfies PagesSidebarHeader_ClassNames,
				"PagesSidebarHeader-header" satisfies PagesSidebarHeader_ClassNames,
			)}
		>
			<div className={cn("PagesSidebarHeader-top-section" satisfies PagesSidebarHeader_ClassNames)}>
				<div className={cn("PagesSidebarHeader-top-section-left" satisfies PagesSidebarHeader_ClassNames)}>
					<MyIconButton
						className={"PagesSidebarHeader-hamburger-button" satisfies PagesSidebarHeader_ClassNames}
						variant="ghost"
						tooltip="Main Menu"
						onClick={onToggleSidebar}
					>
						<Menu />
					</MyIconButton>

					<MyLink
						className={cn("PagesSidebarHeader-title" satisfies PagesSidebarHeader_ClassNames)}
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
					className={cn("PagesSidebarHeader-close-button" satisfies PagesSidebarHeader_ClassNames)}
				>
					<MyIconButtonIcon>
						<X />
					</MyIconButtonIcon>
				</MyIconButton>
			</div>

			<PagesSidebarSearch onSearchQueryChange={onSearchQueryChange} />

			<div className={cn("PagesSidebarHeader-actions" satisfies PagesSidebarHeader_ClassNames)}>
				<div className={cn("PagesSidebarHeader-actions-group" satisfies PagesSidebarHeader_ClassNames)}>
					<MyIconButton
						className={cn("PagesSidebarHeader-actions-icon-button" satisfies PagesSidebarHeader_ClassNames)}
						variant="secondary-subtle"
						tooltip="Unfold"
						onClick={onExpandAllClick}
						disabled={isBusy}
					>
						<MyIconButtonIcon>
							<ChevronsDown />
						</MyIconButtonIcon>
					</MyIconButton>

					<MyIconButton
						className={cn("PagesSidebarHeader-actions-icon-button" satisfies PagesSidebarHeader_ClassNames)}
						variant="secondary-subtle"
						tooltip="Fold"
						onClick={onCollapseAllClick}
						disabled={isBusy}
					>
						<MyIconButtonIcon>
							<ChevronsUp />
						</MyIconButtonIcon>
					</MyIconButton>
				</div>

				{selectedPageIdsCount > 1 ? (
					<div className={cn("PagesSidebarHeader-multi-selection-counter" satisfies PagesSidebarHeader_ClassNames)}>
						<span
							className={cn("PagesSidebarHeader-multi-selection-counter-label" satisfies PagesSidebarHeader_ClassNames)}
						>
							{selectedPageIdsCount} items selected
						</span>
						<div className={cn("PagesSidebarHeader-actions-group" satisfies PagesSidebarHeader_ClassNames)}>
							<MyIconButton
								className={cn("PagesSidebarHeader-actions-icon-button" satisfies PagesSidebarHeader_ClassNames)}
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
					<MyButton
						className={cn("PagesSidebarHeader-action-new-page" satisfies PagesSidebarHeader_ClassNames)}
						variant="secondary"
						onClick={onCreateRootPageClick}
						disabled={isBusy}
					>
						<MyButtonIcon>
							<Plus />
						</MyButtonIcon>
						New Page
					</MyButton>
				)}
			</div>

			{archivedCount ? (
				<MyButton
					className={cn("PagesSidebarHeader-archive-toggle" satisfies PagesSidebarHeader_ClassNames)}
					variant="ghost"
					onClick={onArchiveToggleClick}
					disabled={isBusy}
				>
					{showArchived ? `Hide archived (${archivedCount})` : `Show archived (${archivedCount})`}
				</MyButton>
			) : null}
		</MySidebarHeader>
	);
});
// #endregion header

// #region root
type PagesSidebar_ClassNames = "PagesSidebar" | "PagesSidebar-content";

export type PagesSidebar_Props = {
	state: MySidebar_Props["state"];
	selectedPageId: string | null;
	view: pages_EditorView;
	onClose: () => void;
	onArchive: (itemId: string) => void;
	onPrimaryAction: (itemId: string, itemType: string) => void;
};

export const PagesSidebar = memo(function PagesSidebar(props: PagesSidebar_Props) {
	const { selectedPageId, state = "expanded", view, onClose, onArchive, onPrimaryAction } = props;

	const navigate = useNavigate();
	const convex = useConvex();
	const mainAppSidebar = MainAppSidebar.useSidebar();
	const homePageId = useAppGlobalStore((state) => state.pages_home_id);

	const [searchQuery, setSearchQuery] = useState("");
	const searchQueryDeferred = useDeferredValue(searchQuery);
	const isSearchActive = searchQueryDeferred.trim().length > 0;

	const [showArchived, setShowArchived] = useState(false);

	const [isCreatingPage, setIsCreatingPage] = useState(false);
	const [isArchivingSelection, setIsArchivingSelection] = useState(false);
	const [pendingActionPageIds, setPendingActionPageIds] = useState<Set<string>>(new Set());
	const isBusy = isCreatingPage || isArchivingSelection;
	const [expandedItems, setExpandedItems] = useState<string[]>([]);

	const expandedItemsBeforeSearchRef = useRef<Set<string> | null>(null);
	const selectedPagePathAutoExpandedOnMountRef = useRef(false);

	const treeItemsList = useQuery(app_convex_api.ai_docs_temp.get_tree_items_list, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
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
			itemsIds: new Set<string>([pages_ROOT_ID]),
			itemsIdsByParentId: new Map<string, Set<string>>([[pages_ROOT_ID, new Set()]]),
			sortedItemsIdsByParentId: new Map<string, string[]>([[pages_ROOT_ID, []]]),
			itemById: new Map<string, pages_TreeItem>([[pages_ROOT_ID, rootItem]]),
		} satisfies PagesSidebar_TreeItems;

		// Collect all items from the list to the maps
		for (const item of treeItemsList) {
			if (item.type !== "page" || (item.archiveOperationId !== undefined && !showArchived)) {
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

	/**
	 * Filtered items ids from search query
	 */
	const visiblePagesIds = ((/* iife */) => {
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
			if (item.type !== "page") {
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
				if (parentItem.type !== "page") {
					break;
				}

				currentParentId = parentItem.parentId;
			}
		}

		return result;
	})();

	const hasSelectedPageInTree = Boolean(selectedPageId && visiblePagesIds.has(selectedPageId));

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
		if (!treeItems) {
			console.error(should_never_happen("[PagesSidebar.handleDrop] missing deps", { treeItems }));
			return;
		}

		const pageIds = items.map((item) => item.getId());
		const targetParentId = target.item.getId();

		const movedPageIds = pageIds.filter((pageId) => treeItems.itemById.get(pageId)?.type === "page");
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
		const itemId = item.getId();

		if (itemData.type !== "page") {
			console.error("[PagesSidebar.handleRename] item is not a page", { itemId, itemData });
			return;
		}

		if (!trimmedValue || trimmedValue === itemData.title) {
			return;
		}

		item.setFocused();
		markPageAsPending(itemId);
		convex
			.mutation(
				app_convex_api.ai_docs_temp.rename_page,
				{
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					pageId: pages_sidebar_to_page_id(itemId),
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
								if (treeItem._id === itemId) {
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
				unmarkPageAsPending(itemId);
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

	const [clickBehaviorFeature] = useState(
		() =>
			({
				key: "pages-sidebar-click-behavior",

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
			}) satisfies FeatureImplementation<pages_TreeItem>,
	);

	const dataLoader = {
		getItem: (itemId: string) =>
			treeItems?.itemById.get(itemId) ?? treeItems?.itemById.get(pages_ROOT_ID) ?? pages_create_tree_root(),
		getChildren: (itemId: string) => {
			const children = treeItems?.sortedItemsIdsByParentId.get(itemId) ?? [];
			if (!isSearchActive) {
				return children;
			}
			return children.filter((childId) => visiblePagesIds.has(childId));
		},
	} satisfies TreeConfig<pages_TreeItem>["dataLoader"];

	const tree = useTree<pages_TreeItem>({
		rootItemId: pages_ROOT_ID,
		state: {
			expandedItems,
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
		getItemName: (item) => item.getItemData().title,
		isItemFolder: (item) => item.getItemData().type === "page",
		canDrag,
		canDrop,
		onDrop: handleDrop,
		canRename,
		onRename: handleRename,
		onPrimaryAction: handlePrimaryAction,
	});

	const renderedTreeItems = tree().getItems();
	const renderedPageIds = new Set(
		renderedTreeItems.filter((item) => item.getItemData().type === "page").map((item) => item.getId()),
	);

	const selectedPageIds = new Set(
		renderedTreeItems
			.filter((item) => item.isSelected() && item.getItemData().type === "page")
			.map((item) => item.getId()),
	);
	const selectionAnchorPageId = tree().getDataRef<SelectionDataRef>().current.selectUpToAnchorId ?? null;

	/**
	 * The pages ids used as the source for active tree tracks.
	 * In multi-select mode, only the selection anchor drives track highlighting.
	 */
	const trackSourcePageIds = ((/* iife */) => {
		const result = new Set<string>();

		if (selectedPageIds.size > 1) {
			const anchorPageId = selectionAnchorPageId;
			if (anchorPageId && selectedPageIds.has(anchorPageId) && renderedPageIds.has(anchorPageId)) {
				result.add(anchorPageId);
				return result;
			}

			for (const item of renderedTreeItems) {
				const itemId = item.getId();
				if (selectedPageIds.has(itemId)) {
					result.add(itemId);
					break;
				}
			}

			return result;
		}

		if (selectedPageIds.size === 1) {
			const singleSelectedPageId = selectedPageIds.values().next().value;
			if (singleSelectedPageId) {
				result.add(singleSelectedPageId);
			}
			return result;
		}

		if (selectedPageId && renderedPageIds.has(selectedPageId)) {
			result.add(selectedPageId);
		}

		return result;
	})();

	/**
	 * The pages ids with the tracks that needs to highlight
	 * for selected and navigated pages.
	 */
	const trackActivePagesIds = ((/* iife */) => {
		const result = new Set<string>();

		for (const sourcePageId of trackSourcePageIds) {
			const item = tree().getItemInstance(sourcePageId);

			// If the page is expanded, highlight the track inside
			if (item.isFolder() && item.getChildren().length > 0 && item.isExpanded()) {
				result.add(item.getId());
				continue;
			}

			// If the page is not expanded, highlight the track of the parent
			const parent = item.getParent();
			if (parent) {
				result.add(parent.getId());
			}
		}

		return result;
	})();

	const showEmptyState = treeItemsList !== undefined && visiblePagesIds.size <= 1;

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
		if (!treeItems) {
			console.error(should_never_happen("[PagesSidebar.handleCreatePageClick] missing deps", { treeItems }));
			return;
		}

		const nextPageName = pages_sidebar_get_default_page_name({
			parentId: parentPageId,
			treeItems,
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
					console.error("[PagesSidebar.handleCreatePageClick] Failed to create page", {
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
		const shouldArchiveSelectedPages = selectedPageIds.has(pageId);
		const pageIdsToArchive = shouldArchiveSelectedPages ? selectedPageIds : new Set([pageId]);

		if (shouldArchiveSelectedPages) {
			setIsArchivingSelection(true);
		} else {
			markPageAsPending(pageId);
		}

		convex
			.mutation(app_convex_api.ai_docs_temp.archive_pages, {
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageIds: Array.from(pageIdsToArchive),
			})
			.then((result) => {
				if (result._nay) {
					console.error("[PagesSidebar.handleArchive] Failed to archive pages", {
						result,
						pageId,
						pageIdsToArchive,
					});
					return;
				}

				if (selectedPageId && pageIdsToArchive.has(selectedPageId)) {
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
					console.error("[PagesSidebar.handleUnarchive] Failed to unarchive page", { result, pageId });
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

	const handleExpandAllClick = useFn(() => {
		tree()
			.expandAll()
			.catch((error) => {
				console.error("[PagesSidebar.handleExpandAllClick] Failed to expand tree", { error });
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

	// Rebuild tree when visible pages or controlled expansion state changes.
	useLayoutEffect(() => {
		tree().rebuildTree();
	}, [expandedItems, visiblePagesIds]);

	// Auto expand pages on search or mount
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

			nextExpandedItemsSet = new Set<string>([pages_ROOT_ID]);
			for (const pageId of visiblePagesIds) {
				const childrenIds = treeItems.itemsIdsByParentId.get(pageId);
				if (!childrenIds) {
					continue;
				}

				for (const childId of childrenIds) {
					if (visiblePagesIds.has(childId)) {
						nextExpandedItemsSet.add(pageId);
						break;
					}
				}
			}
		}

		// Auto-expand selected-page ancestors once on mount.
		if (!selectedPagePathAutoExpandedOnMountRef.current && selectedPageId && hasSelectedPageInTree) {
			let currentItemId = treeItems.itemById.get(selectedPageId)?.parentId;

			// Walk up the selected page's parent chain and ensure each ancestor is expanded.
			while (currentItemId) {
				if (nextExpandedItemsSet.has(currentItemId)) {
					break;
				} else {
					nextExpandedItemsSet.add(currentItemId);
				}

				currentItemId = treeItems.itemById.get(selectedPageId)?.parentId;
			}
		}

		selectedPagePathAutoExpandedOnMountRef.current = true;

		// Skip state updates when nothing changed to avoid unnecessary rebuilds.
		if (currentExpandedItems.symmetricDifference(nextExpandedItemsSet).size > 0) {
			setExpandedItems([...nextExpandedItemsSet]);
		}
	}, [expandedItems, hasSelectedPageInTree, selectedPageId, setExpandedItems, treeItems, visiblePagesIds]);

	// Auto focus page in tree on page navigation
	useEffect(() => {
		const nextFocusedItemId =
			(selectedPageId && visiblePagesIds.has(selectedPageId) ? selectedPageId : undefined) ??
			treeItems?.sortedItemsIdsByParentId.get(pages_ROOT_ID)?.[0];
		if (!nextFocusedItemId) {
			return;
		}

		tree().getItemInstance(nextFocusedItemId).setFocused();
	}, [visiblePagesIds, selectedPageId]);

	return (
		<MySidebar state={state} className={"PagesSidebar" satisfies PagesSidebar_ClassNames}>
			<PagesSidebarHeader
				homePageId={homePageId}
				view={view}
				selectedPageIdsCount={selectedPageIds.size}
				isBusy={isBusy}
				treeItemsList={treeItemsList}
				showArchived={showArchived}
				onToggleSidebar={mainAppSidebar.toggleSidebar}
				onClose={onClose}
				onSearchQueryChange={setSearchQuery}
				onExpandAllClick={handleExpandAllClick}
				onCollapseAllClick={handleCollapseAllClick}
				onClearSelectionClick={handleClearSelectionClick}
				onCreateRootPageClick={handleCreateRootPageClick}
				onArchiveToggleClick={handleArchiveToggleClick}
			/>

			<MySidebarContent className={cn("PagesSidebar-content" satisfies PagesSidebar_ClassNames)}>
				<PagesSidebarTree
					tree={tree}
					isTreeLoading={treeItemsList === undefined}
					showEmptyState={showEmptyState}
					isSearchActive={isSearchActive}
					trackActivePagesIds={trackActivePagesIds}
					selectedPageId={selectedPageId}
					selectedPageIds={selectedPageIds}
					isBusy={isBusy}
					pendingActionPageIds={pendingActionPageIds}
					onCreatePage={handleCreatePageClick}
					onStartRename={handleStartRename}
					onArchive={handleArchive}
					onUnarchive={handleUnarchive}
				/>
			</MySidebarContent>
		</MySidebar>
	);
});
// #endregion root
