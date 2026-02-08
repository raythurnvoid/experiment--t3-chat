import "./pages-sidebar.css";
import React, { useState, createContext, use, useRef, useEffect } from "react";
import {
	FileText,
	Plus,
	Search,
	X,
	ArchiveRestore,
	Edit2,
	ChevronRight,
	ChevronDown,
	ChevronsDown,
	ChevronsUp,
	Menu,
	Archive,
} from "lucide-react";
import { MySidebar, MySidebarContent, MySidebarHeader, type MySidebar_Props } from "@/components/my-sidebar.tsx";
import { MyInput, MyInputBox, MyInputArea, MyInputControl, MyInputIcon } from "@/components/my-input.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import {
	ai_chat_HARDCODED_ORG_ID,
	ai_chat_HARDCODED_PROJECT_ID,
	cn,
	forward_ref,
	generate_id,
	sx,
} from "@/lib/utils.ts";
import {
	UncontrolledTreeEnvironment,
	Tree,
	InteractionMode,
	type TreeRef,
	type TreeItemRenderContext,
	type TreeItem,
	type TreeItemIndex,
	type TreeInformation,
	type TreeDataProvider,
	type UncontrolledTreeEnvironmentProps,
	useTreeEnvironment,
} from "react-complex-tree";
import { useQuery, useMutation } from "convex/react";
import { app_convex_api, app_convex_wait_new_query_value } from "@/lib/app-convex-client.ts";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import {
	pages_create_tree_root,
	pages_create_tree_placeholder_child,
	pages_ROOT_ID,
	type pages_TreeItem,
	type pages_EditorView,
} from "@/lib/pages.ts";
import { format_relative_time } from "@/lib/date.ts";
import { useNavigate } from "@tanstack/react-router";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { MyLink } from "@/components/my-link.tsx";
import { TypedEventTarget } from "@remix-run/interaction";
import { useAsyncEffect, useRenderPromise } from "../../../hooks/utils-hooks.ts";

/**
 * `react-complex-tree` flat data record object
 */
type PagesSidebarTreeCollection = Record<TreeItemIndex, TreeItem<pages_TreeItem>>;

type TypedUncontrolledTreeEnvironmentProps = UncontrolledTreeEnvironmentProps<pages_TreeItem>;

const TREE_ID = "pages-tree";

// #region TreeDataProvider
type PagesSidebarTreeDataProvider_Args = {
	initialData: PagesSidebarTreeCollection;
	workspaceId: string;
	projectId: string;
	movePages: (params: {
		itemIds: string[];
		targetParentId: string;
		workspaceId: string;
		projectId: string;
	}) => Promise<void>;
	renamePage: (params: { workspaceId: string; projectId: string; pageId: string; name: string }) => Promise<void>;
	createPage: (params: {
		pageId: string;
		parentId: string;
		name: string;
		workspaceId: string;
		projectId: string;
	}) => Promise<void>;
};

/**
 * Custom TreeDataProvider
 */
class PagesSidebarTreeDataProvider implements TreeDataProvider<pages_TreeItem> {
	eventTarget = new TypedEventTarget<{
		change: CustomEvent<TreeItemIndex[]>;
	}>();

	data: PagesSidebarTreeCollection;

	args: PagesSidebarTreeDataProvider_Args;

	constructor(args: PagesSidebarTreeDataProvider_Args) {
		this.args = args;
		this.data = { ...args.initialData };
	}

	/**
	 * Method to update tree collection from external source (like Convex query)
	 **/
	updateTreeData(treeItemsList: pages_TreeItem[], options: { showArchived: boolean }) {
		this.data = {};

		for (const item of treeItemsList) {
			if (item.isArchived && !options.showArchived) continue;

			const isPlaceholder = item.type === "placeholder";

			this.data[item.index] = {
				index: item.index,
				children: [],
				data: item,
				isFolder: isPlaceholder ? false : true,
				canMove: !isPlaceholder && item.index !== pages_ROOT_ID,
				canRename: !isPlaceholder && item.index !== pages_ROOT_ID,
			};
		}

		// Calculate `children` arrays based on `parentId`
		for (const item of treeItemsList) {
			if (item.isArchived && !options.showArchived) continue;

			// Find the parent and add this item to its children
			if (item.parentId && this.data[item.parentId]) {
				const parent = this.data[item.parentId];
				if (parent.children) {
					parent.children.push(item.index);
				}
			}
		}

		// Find all items with empty children and add placeholder items
		for (const item of treeItemsList) {
			if (item.isArchived && !options.showArchived) continue;

			const treeItem = this.data[item.index];
			if (treeItem && treeItem.children && treeItem.children.length === 0 && treeItem.isFolder) {
				const placeholderData = pages_create_tree_placeholder_child(item.index);
				const placeholderItem: TreeItem<pages_TreeItem> = {
					index: placeholderData.index,
					children: [],
					data: placeholderData,
					canMove: false,
					canRename: false,
					isFolder: false,
				};

				this.data[placeholderData.index] = placeholderItem;
				treeItem.children.push(placeholderData.index);
			}
		}

		const visibleItemsIds = Object.keys(this.data);
		this.notifyTreeChange(visibleItemsIds);
	}

	async getTreeItem(itemId: TreeItemIndex) {
		const item = this.data[itemId];
		if (!item) {
			throw new Error(`Item ${itemId} not found`);
		}

		return item;
	}

	async onChangeItemChildren(itemId: TreeItemIndex, newChildren: TreeItemIndex[]): Promise<void> {
		if (this.data[itemId]) {
			// Sort the children alphabetically before storing
			const sortedChildren = this.sortChildren(newChildren);

			this.data[itemId] = {
				...this.data[itemId],
				children: sortedChildren,
			};

			this.args
				.movePages({
					itemIds: newChildren.map((id) => id.toString()),
					targetParentId: itemId.toString(),
					workspaceId: this.args.workspaceId,
					projectId: this.args.projectId,
				})
				.catch(console.error);
		}
	}

	onDidChangeTreeData(listener: (changedItemIds: TreeItemIndex[]) => void): { dispose(): void } {
		const abortController = new AbortController();
		this.eventTarget.addEventListener("change", (event) => listener(event.detail), { signal: abortController.signal });

		return {
			dispose: () => {
				abortController.abort();
			},
		};
	}

	async onRenameItem(item: TreeItem<pages_TreeItem>, name: string): Promise<void> {
		const trimmedName = name.trim();
		const originalName = item.data.title?.trim();

		// Don't rename if the name is empty or didn't change
		if (!trimmedName || trimmedName === originalName) {
			return;
		}

		const updatedItem = {
			...item,
			data: { ...item.data, title: trimmedName },
		};
		this.data[item.index] = updatedItem;

		// Find parent and re-sort its children since title changed
		const parentItem = Object.values(this.data).find((parent) => parent.children?.includes(item.index));
		if (parentItem && parentItem.children) {
			const sortedChildren = this.sortChildren(parentItem.children);
			this.data[parentItem.index] = {
				...parentItem,
				children: sortedChildren,
			};
		}

		this.args
			.renamePage({
				workspaceId: this.args.workspaceId,
				projectId: this.args.projectId,
				pageId: item.index.toString(),
				name: trimmedName,
			})
			.catch(console.error);
	}

	createNewItem(parentId: string, title: string = "Untitled"): string {
		const pageId = generate_id("page");
		const parentItem = this.data[parentId];

		if (parentItem) {
			const newItem: TreeItem<pages_TreeItem> = {
				index: pageId,
				children: [],
				data: {
					_id: null,
					type: "page",
					index: pageId,
					parentId: parentId,
					title,
					isArchived: false,
					updatedAt: Date.now(),
					updatedBy: "user",
				},
				canMove: true,
				canRename: true,
				isFolder: true,
			};

			this.data[pageId] = newItem;

			// Check if parent has a placeholder that needs to be replaced
			const placeholderId = `${parentId}-placeholder`;
			const hasPlaceholder = this.data[placeholderId] && parentItem.children?.includes(placeholderId);

			let updatedChildren: TreeItemIndex[];
			if (hasPlaceholder) {
				// Replace placeholder with new item
				updatedChildren = parentItem.children?.map((id) => (id === placeholderId ? pageId : id)) || [pageId];
				delete this.data[placeholderId];
			} else {
				// Just add the new item to existing children
				updatedChildren = [...(parentItem.children || []), pageId];
			}

			// Update parent with new children array
			const updatedParent = {
				...parentItem,
				children: updatedChildren,
				isFolder: true,
			};

			this.data[parentId] = updatedParent;
		}

		this.args
			.createPage({
				pageId: pageId,
				parentId: parentId,
				name: title,
				workspaceId: this.args.workspaceId,
				projectId: this.args.projectId,
			})
			.catch(console.error);

		return pageId;
	}

	private sortChildren(children: TreeItemIndex[]): TreeItemIndex[] {
		return [...children].sort((a, b) => {
			const itemA = this.data[a];
			const itemB = this.data[b];

			if (itemA?.data.type === "placeholder") return 1;
			if (itemB?.data.type === "placeholder") return -1;

			const titleA = itemA?.data.title || "";
			const titleB = itemB?.data.title || "";
			return titleA.localeCompare(titleB, undefined, {
				numeric: true,
				sensitivity: "base",
			});
		});
	}

	private notifyTreeChange(changedItemIds: TreeItemIndex[]): void {
		this.eventTarget.dispatchEvent(new CustomEvent("change", { detail: changedItemIds }));
	}

	updateArchiveStatus(itemId: TreeItemIndex, newIsArchived: boolean): void {
		if (!this.data[itemId]) {
			throw new Error(`Item ${itemId} not found`);
		}

		const item = this.data[itemId];

		// Update the item
		this.data[itemId] = {
			...item,
			data: {
				...item.data,
				isArchived: newIsArchived,
			},
		};
	}

	getAllData(): Record<TreeItemIndex, TreeItem<pages_TreeItem>> {
		return { ...this.data };
	}
}
// #endregion TreeDataProvider

// #region TreeContext
type PagesSidebarTreeContext = {
	dataProvider: PagesSidebarTreeDataProvider;
	treeItems: Record<TreeItemIndex, TreeItem<pages_TreeItem>>;
};

const PagesTreeContext = createContext<PagesSidebarTreeContext | null>(null);
// #endregion TreeContext

// #region TreeItemArrow
type PagesSidebarTreeItemArrow_ClassNames = "PagesSidebarTreeItemArrow";

interface PagesSidebarTreeItemArrow_Props {
	item: TreeItem<pages_TreeItem>;
	context: TreeItemRenderContext;
	info: TreeInformation;
}

function PagesSidebarTreeItemArrow(props: PagesSidebarTreeItemArrow_Props) {
	const { item, context } = props;

	// Only render arrow for folders
	if (!item.isFolder) return null;

	return (
		<MyIconButton
			{...(context.arrowProps as any)}
			className={"PagesSidebarTreeItemArrow" satisfies PagesSidebarTreeItemArrow_ClassNames}
			tooltip={context.isExpanded ? "Collapse page" : "Expand page"}
			side="bottom"
			variant="ghost-highlightable"
		>
			<MyIconButtonIcon>{context.isExpanded ? <ChevronDown /> : <ChevronRight />}</MyIconButtonIcon>
		</MyIconButton>
	);
}
// #endregion TreeItemArrow

// #region TreeItemIcon
type PagesSidebarTreeItemIcon_ClassNames = "PagesSidebarTreeItemIcon";

function PagesSidebarTreeItemIcon() {
	return (
		<MyIcon className={"PagesSidebarTreeItemIcon" satisfies PagesSidebarTreeItemIcon_ClassNames}>
			<FileText />
		</MyIcon>
	);
}
// #endregion TreeItemIcon

// #region TreeItemPrimaryActionContent
type PagesSidebarTreeItemPrimaryActionContent_ClassNames = "PagesSidebarTreeItemPrimaryActionContent";

type PagesSidebarTreeItemPrimaryActionContent_Props = {
	title: React.ReactNode;
};

function PagesSidebarTreeItemPrimaryActionContent(props: PagesSidebarTreeItemPrimaryActionContent_Props) {
	const { title } = props;

	return (
		<div
			className={
				"PagesSidebarTreeItemPrimaryActionContent" satisfies PagesSidebarTreeItemPrimaryActionContent_ClassNames
			}
		>
			<PagesSidebarTreeItemIcon />
			<div className="PagesSidebarTreeItemPrimaryActionContent-title-container">
				<div className="PagesSidebarTreeItemPrimaryActionContent-title">{title}</div>
			</div>
		</div>
	);
}
// #endregion TreeItemPrimaryActionContent

// #region TreeItemNoChildrenPlaceholder
type PagesSidebarTreeItemNoChildrenPlaceholder_ClassNames = "PagesSidebarTreeItemNoChildrenPlaceholder";

type PagesSidebarTreeItemNoChildrenPlaceholder_Props = {
	children: React.ReactNode;
	title: React.ReactNode;
	context: TreeItemRenderContext;
	depth: number;
};

function PagesSidebarTreeItemNoChildrenPlaceholder(props: PagesSidebarTreeItemNoChildrenPlaceholder_Props) {
	const { children, title, context, depth } = props;

	return (
		<li
			{...context.itemContainerWithChildrenProps}
			className={
				"PagesSidebarTreeItemNoChildrenPlaceholder" satisfies PagesSidebarTreeItemNoChildrenPlaceholder_ClassNames
			}
		>
			<div
				{...context.itemContainerWithoutChildrenProps}
				style={sx({ "--PagesSidebarTreeItem-content-depth": depth } satisfies Partial<PagesSidebar_CssVars>)}
				className={cn(
					"PagesSidebarTreeItem-content" satisfies PagesSidebarTreeItem_ClassNames,
					"PagesSidebarTreeItem-content-placeholder" satisfies PagesSidebarTreeItem_ClassNames,
				)}
			>
				<PagesSidebarTreeItemPrimaryActionContent title={title} />
			</div>
			{children}
		</li>
	);
}
// #endregion TreeItemNoChildrenPlaceholder

// #region TreeItemActionIconButton
type PagesSidebarTreeItemActionIconButton_ClassNames = "PagesSidebarTreeItemActionIconButton";

type PagesSidebarTreeItemActionIconButton_Props = {
	className?: string;
	tooltip: string;
	children: React.ReactNode;
	isActive: boolean;
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
};

function PagesSidebarTreeItemActionIconButton(props: PagesSidebarTreeItemActionIconButton_Props) {
	const { className, tooltip, isActive, onClick, children } = props;

	return (
		<MyIconButton
			className={cn(
				"PagesSidebarTreeItemActionIconButton" satisfies PagesSidebarTreeItemActionIconButton_ClassNames,
				className,
			)}
			variant="ghost-highlightable"
			tooltip={tooltip}
			tabIndex={isActive ? 0 : -1}
			onClick={onClick}
		>
			<MyIconButtonIcon>{children}</MyIconButtonIcon>
		</MyIconButton>
	);
}
// #endregion TreeItemActionIconButton

// #region TreeItem
type PagesSidebarTreeItem_ClassNames =
	| "PagesSidebarTreeItem"
	| "PagesSidebarTreeItem-content"
	| "PagesSidebarTreeItem-content-navigated"
	| "PagesSidebarTreeItem-content-selected"
	| "PagesSidebarTreeItem-content-focused"
	| "PagesSidebarTreeItem-content-selected-focused"
	| "PagesSidebarTreeItem-content-dragging-over"
	| "PagesSidebarTreeItem-content-archived"
	| "PagesSidebarTreeItem-content-placeholder"
	| "PagesSidebarTreeItem-primary-action-interactive-area"
	| "PagesSidebarTreeItem-meta-label"
	| "PagesSidebarTreeItem-meta-label-text"
	| "PagesSidebarTreeItem-actions";

type PagesSidebarTreeItem_Props = {
	item: TreeItem<pages_TreeItem>;
	depth: number;
	children: React.ReactNode;
	title: React.ReactNode;
	context: TreeItemRenderContext;
	arrow: React.ReactNode;
	info: TreeInformation;
	selectedPageId: string | null;
	showArchived: boolean;
	isDragging: boolean;
	onAdd: (parentId: string) => void;
	onArchive: (itemId: string) => void;
	onUnarchive: (itemId: string) => void;
};

function PagesSidebarTreeItem(props: PagesSidebarTreeItem_Props) {
	const {
		item,
		depth,
		children,
		title,
		context,
		arrow,
		selectedPageId,
		showArchived,
		isDragging,
		onAdd,
		onArchive,
		onUnarchive,
	} = props;

	const data = item.data as pages_TreeItem;

	// Current selected document
	const isNavigated = selectedPageId === item.index;
	const isPlaceholder = data.type === "placeholder";
	const isArchived = item.data.isArchived;
	const isRenaming = context.isRenaming;

	// Meta text for non-placeholder items
	const metaText = `${format_relative_time(data.updatedAt)} ${data.updatedBy || "Unknown"}`;

	// Tooltip content for non-placeholder items
	const tooltipContent = !isPlaceholder
		? (() => {
				const relativeTime = format_relative_time(data.updatedAt, { prefixForDatesPast7Days: "the " });
				return `Updated ${relativeTime} by ${data.updatedBy || "Unknown"}`;
			})()
		: undefined;

	// Hide archived items when showArchived is false
	if (isArchived && !showArchived) {
		return null;
	}

	// Placeholder items
	if (isPlaceholder) {
		return (
			<PagesSidebarTreeItemNoChildrenPlaceholder children={children} title={title} context={context} depth={depth} />
		);
	}

	// Regular items
	const contentDiv = (
		<div
			{...context.itemContainerWithoutChildrenProps}
			style={sx({ "--PagesSidebarTreeItem-content-depth": depth } satisfies Partial<PagesSidebar_CssVars>)}
			className={cn(
				"PagesSidebarTreeItem-content" satisfies PagesSidebarTreeItem_ClassNames,
				isNavigated && ("PagesSidebarTreeItem-content-navigated" satisfies PagesSidebarTreeItem_ClassNames),
				context.isSelected &&
					!isRenaming &&
					("PagesSidebarTreeItem-content-selected" satisfies PagesSidebarTreeItem_ClassNames),
				context.isFocused &&
					!isRenaming &&
					("PagesSidebarTreeItem-content-focused" satisfies PagesSidebarTreeItem_ClassNames),
				context.isSelected &&
					context.isFocused &&
					!isRenaming &&
					("PagesSidebarTreeItem-content-selected-focused" satisfies PagesSidebarTreeItem_ClassNames),
				context.isDraggingOver &&
					("PagesSidebarTreeItem-content-dragging-over" satisfies PagesSidebarTreeItem_ClassNames),
				isArchived && ("PagesSidebarTreeItem-content-archived" satisfies PagesSidebarTreeItem_ClassNames),
			)}
		>
			{context.isRenaming ? (
				<PagesSidebarTreeItemPrimaryActionContent title={title} />
			) : (
				<button
					{...context.interactiveElementProps}
					type="button"
					className={"PagesSidebarTreeItem-primary-action-interactive-area" satisfies PagesSidebarTreeItem_ClassNames}
				>
					<PagesSidebarTreeItemPrimaryActionContent title={title} />
				</button>
			)}

			{/* Expand/collapse arrow */}
			<div className={"PagesSidebarTreeItemArrow" satisfies PagesSidebarTreeItemArrow_ClassNames}>{arrow}</div>

			{/* Meta label */}
			{metaText ? (
				<div className={"PagesSidebarTreeItem-meta-label" satisfies PagesSidebarTreeItem_ClassNames}>
					<div className={"PagesSidebarTreeItem-meta-label-text" satisfies PagesSidebarTreeItem_ClassNames}>
						{metaText}
					</div>
				</div>
			) : null}

			{/* Second row - action buttons */}
			<div className={"PagesSidebarTreeItem-actions" satisfies PagesSidebarTreeItem_ClassNames}>
				<PagesSidebarTreeItemActionIconButton
					tooltip="Add child"
					isActive={context.isFocused ?? false}
					onClick={() => onAdd(item.index.toString())}
				>
					<Plus />
				</PagesSidebarTreeItemActionIconButton>

				<PagesSidebarTreeItemActionIconButton
					tooltip="Rename"
					isActive={context.isFocused ?? false}
					onClick={() => context.startRenamingItem()}
				>
					<Edit2 />
				</PagesSidebarTreeItemActionIconButton>

				<PagesSidebarTreeItemActionIconButton
					tooltip={isArchived ? "Restore" : "Archive"}
					isActive={context.isFocused ?? false}
					onClick={() => {
						if (isArchived) {
							onUnarchive(item.index.toString());
						} else {
							onArchive(item.index.toString());
						}
					}}
				>
					{isArchived ? <ArchiveRestore /> : <Archive />}
				</PagesSidebarTreeItemActionIconButton>
			</div>
		</div>
	);

	// Wrap with tooltip if content exists
	const wrappedContent = tooltipContent ? (
		<Tooltip delayDuration={2000}>
			<TooltipTrigger asChild>{contentDiv}</TooltipTrigger>
			{!isDragging && (
				<TooltipContent side="bottom" align="center">
					{tooltipContent}
				</TooltipContent>
			)}
		</Tooltip>
	) : (
		contentDiv
	);

	return (
		<li
			{...context.itemContainerWithChildrenProps}
			className={cn("PagesSidebarTreeItem" satisfies PagesSidebarTreeItem_ClassNames)}
		>
			{wrappedContent}
			{children}
		</li>
	);
}
// #endregion TreeItem

// #region TreeRenameInput
type PagesSidebarTreeRenameInput_ClassNames = "PagesSidebarTreeRenameInput" | "PagesSidebarTreeRenameInput-input";

type PagesSidebarTreeRenameInput_Props = {
	item: TreeItem<pages_TreeItem>;
	inputProps: React.InputHTMLAttributes<HTMLInputElement>;
	inputRef: React.Ref<HTMLInputElement>;
	submitButtonProps: React.HTMLProps<any>;
	submitButtonRef: React.Ref<any>;
	formProps: React.FormHTMLAttributes<HTMLFormElement>;
};

function PagesSidebarTreeRenameInput(props: PagesSidebarTreeRenameInput_Props) {
	const { inputProps, inputRef, formProps } = props;

	const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
		e.target.form?.requestSubmit();
	};

	return (
		<form {...formProps} className={"PagesSidebarTreeRenameInput" satisfies PagesSidebarTreeRenameInput_ClassNames}>
			<MyInput>
				<MyInputControl
					{...inputProps}
					ref={inputRef}
					className={"PagesSidebarTreeRenameInput-input" satisfies PagesSidebarTreeRenameInput_ClassNames}
					autoFocus
					required
					onBlur={handleBlur}
				/>
			</MyInput>
		</form>
	);
}
// #endregion TreeRenameInput

// #region Tree
type PagesSidebarTree_Props = {
	ref: React.Ref<TreeRef>;
	selectedPageId: string | null;
	treeItems: Record<TreeItemIndex, TreeItem<pages_TreeItem>>;
	showArchived: boolean;
};

/**
 * Temporary wrapper component to test focusing after tree renders
 */
function PagesSidebarTree(props: PagesSidebarTree_Props) {
	const { ref, selectedPageId, treeItems, showArchived } = props;

	const treeRef = useRef<TreeRef>(null);

	const environment = useTreeEnvironment();

	// Check for rendered items and focus selected one on every render
	useEffect(() => {
		if (!selectedPageId || !treeRef.current) {
			return;
		}

		const navigatedItem = treeItems[selectedPageId];
		if (
			!navigatedItem ||
			navigatedItem.data.type === "placeholder" ||
			(navigatedItem.data.isArchived && !showArchived)
		) {
			return;
		}

		const treeLinearItems = environment.linearItems?.[TREE_ID] ?? [];
		const isRendered = treeLinearItems.some(({ item }) => item === selectedPageId);

		if (!isRendered) {
			return;
		}

		const treeInstance = treeRef.current;
		if (treeInstance && !treeInstance.isFocused) {
			try {
				treeInstance.focusItem(selectedPageId, false);
			} catch (error) {
				console.warn("Error focusing tree item:", error);
			}
		}
	}, [selectedPageId, treeItems, showArchived, environment.linearItems]);

	return (
		<Tree ref={(inst) => forward_ref(inst, ref, treeRef)} treeId={TREE_ID} rootItem={pages_ROOT_ID} treeLabel="Pages" />
	);
}
// #endregion Tree

// #region TreeArea
type PagesSidebarTreeArea_ClassNames =
	| "PagesSidebarTreeArea"
	| "PagesSidebarTreeArea-drag-over"
	| "PagesSidebarTreeArea-container"
	| "PagesSidebarTreeArea-container-focused"
	| "PagesSidebarTreeArea-container-dragging"
	| "PagesSidebar-tree-drag-between-line";

type PagesSidebarTreeArea_Props = {
	ref: React.Ref<TreeRef | null>;
	selectedPageId: string | null;
	searchQuery: string;
	showArchived: boolean;
	onSelectItems: TypedUncontrolledTreeEnvironmentProps["onSelectItems"];
	onArchive: (itemId: string) => void;
	onPrimaryAction: (itemId: string, itemType: string) => void;
	onAddChild: (parentId: string) => void;
};

function PagesSidebarTreeArea(props: PagesSidebarTreeArea_Props) {
	const { ref, selectedPageId, searchQuery, showArchived, onSelectItems, onArchive, onPrimaryAction, onAddChild } =
		props;

	const context = use(PagesTreeContext);
	if (!context) {
		throw new Error(`${PagesSidebarTreeArea.name} must be used within ${PagesTreeContext.name}`);
	}

	const { dataProvider, treeItems } = context;

	const renderPromise = useRenderPromise();

	const treeRef = useRef<TreeRef | null>(null);
	const rootElement = useRef<HTMLDivElement>(null);

	const [isDraggingOverRootArea, setIsDraggingOverRootArea] = useState(false);

	const archiveDocument = useMutation(app_convex_api.ai_docs_temp.archive_pages);
	const unarchivePage = useMutation(app_convex_api.ai_docs_temp.unarchive_pages);

	// Compute visible items when search is active
	let visibleIds: Set<string> | null = null;
	const searchQueryTrimmed = searchQuery.trim();
	const searchQueryTrimmedLowerCase = searchQueryTrimmed.toLowerCase();
	const searchActive = searchQuery.trim().length > 0;
	if (searchActive) {
		visibleIds = new Set<string>();

		const isVisible = (id: string): boolean => {
			const node = treeItems[id];
			if (!node) return false;
			if (node.data.type === "placeholder") return false;
			const isArchived = !!node.data.isArchived;
			if (isArchived && !showArchived) return false;

			const selfMatch = node.data.title.toLowerCase().includes(searchQueryTrimmedLowerCase);

			let anyChildVisible = false;
			const children = node.children ?? [];
			for (const cid of children) {
				if (isVisible(cid as string)) {
					anyChildVisible = true;
				}
			}

			const visible = selfMatch || anyChildVisible;
			if (visible) visibleIds!.add(id);
			return visible;
		};
		isVisible(pages_ROOT_ID); // seeds traversal
	}

	// Set active item when tree items and navigated item are available
	useAsyncEffect(
		async (signal) => {
			if (treeRef.current && selectedPageId && !treeRef.current.isFocused) {
				const navigatedItem = treeItems[selectedPageId];
				if (
					navigatedItem &&
					navigatedItem.data.type !== "placeholder" &&
					(!navigatedItem.data.isArchived || showArchived)
				) {
					try {
						const timeoutSignal = AbortSignal.timeout(1000);
						queueMicrotask(async () => {
							while (true) {
								const isSelectedPageRendered = treeRef.current?.treeEnvironmentContext.linearItems?.[TREE_ID].some(
									(item) => item.item === selectedPageId,
								);

								if (isSelectedPageRendered) {
									treeRef?.current?.focusItem(selectedPageId, false);
									break;
								} else if (timeoutSignal.aborted) {
									break;
								}

								await renderPromise.wait({ signal: AbortSignal.any([signal, timeoutSignal]) });
							}
						});
					} catch (error) {
						console.warn("Error focusing tree item:", error);
					}
				}
			}
		},
		[selectedPageId, treeItems, showArchived],
	);

	const handleArchive = (itemId: string) => {
		// Update local data immediately for better UX
		if (dataProvider) {
			dataProvider.updateArchiveStatus(itemId, true);
		}

		archiveDocument({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId: itemId,
		}).catch(console.error);

		onArchive(itemId);
	};

	const handleUnarchive = (itemId: string) => {
		// Update local data immediately for better UX
		if (dataProvider) {
			dataProvider.updateArchiveStatus(itemId, false);
		}

		unarchivePage({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId: itemId,
		}).catch(console.error);
	};

	const handlePrimaryAction: TypedUncontrolledTreeEnvironmentProps["onPrimaryAction"] = (
		item: TreeItem<pages_TreeItem>,
		treeId: string,
	) => {
		if (item.data.type === "page") {
			onPrimaryAction(item.index.toString(), item.data.type);
		}
	};

	const handleShouldRenderChildren: TypedUncontrolledTreeEnvironmentProps["shouldRenderChildren"] = (
		item: TreeItem<pages_TreeItem>,
		context: any,
	) => {
		// Default behavior for expanded state
		const defaultShouldRender = item.isFolder && context.isExpanded;

		// If not expanded, don't render children
		if (!defaultShouldRender) {
			return false;
		}

		// For placeholder items, always render if expanded
		if (item.data.type === "placeholder") {
			return true;
		}

		return defaultShouldRender;
	};

	const handleDragOverRootArea = (e: React.DragEvent<HTMLDivElement>) => {
		if (e.target === rootElement.current) {
			e.preventDefault();
			setIsDraggingOverRootArea(true);
		} else if (isDraggingOverRootArea) {
			setIsDraggingOverRootArea(false);
		}
	};

	const handleDragLeaveRootArea = (e: React.DragEvent<HTMLDivElement>) => {
		// Only reset if we're leaving the root element itself
		if (e.target === rootElement.current) {
			setIsDraggingOverRootArea(false);
		}
	};

	const handleDragEndRootArea = () => {
		// Always reset when drag ends (including when cancelled with Escape)
		setIsDraggingOverRootArea(false);
	};

	const handleDropOnRootArea = async (e: React.DragEvent<HTMLDivElement>) => {
		setIsDraggingOverRootArea(false);

		if (e.target === rootElement.current) {
			e.preventDefault();

			// Get the currently dragged items from react-complex-tree
			const draggingItems = treeRef.current?.dragAndDropContext.draggingItems;

			if (!draggingItems || draggingItems.length === 0 || !dataProvider) {
				return;
			}

			// ✅ Use currentItems (tree's live state) as source of truth - EXACTLY like internal drop
			const currentItems = treeRef.current?.treeEnvironmentContext.items || {};

			try {
				const provider = dataProvider;
				const itemIds = draggingItems.map((item: any) => item.index as string);

				// ✅ Follow EXACT same pattern as UncontrolledTreeEnvironment's onDrop
				const promises: Promise<void>[] = [];

				// Step 1: Remove items from old parents (same logic as internal drop)
				((/* iife Trick the compiler */) => {
					for (const item of draggingItems) {
						const parent = Object.values(currentItems).find((potentialParent: any) =>
							potentialParent?.children?.includes?.((item as any).index),
						) as any;

						if (!parent) {
							continue;
						}

						// Only remove if not already at root (same check as internal drop)
						if (parent.index !== pages_ROOT_ID) {
							promises.push(
								provider.onChangeItemChildren(
									parent.index,
									parent.children.filter((child: any) => child !== (item as any).index),
								),
							);
						}
					}
				})();

				// Step 2: Add items to root (same logic as internal drop for targetType === 'root')
				promises.push(
					provider.onChangeItemChildren(pages_ROOT_ID, [
						...((/* iife trick the compiler */) => currentItems[pages_ROOT_ID]?.children ?? [])().filter(
							(i: any) => !itemIds.includes(i),
						),
						...itemIds,
					]),
				);

				// Step 3: Wait for all changes (same as internal drop)
				await Promise.all(promises);
			} catch (error) {
				console.error("Error in root drop operation:", error);
			}
		}
	};

	const handleBlur = (e: React.FocusEvent) => {
		const treeContainer = e.currentTarget;
		const relatedTarget = e.relatedTarget as HTMLElement | null;

		// Check if focus moved outside the tree
		if (!relatedTarget || !treeContainer.contains(relatedTarget)) {
			// Clear selection when tree loses focus
			treeRef.current?.selectItems([]);

			// Priority 1: Focus navigated item
			if (selectedPageId) {
				const navigatedItem = treeItems[selectedPageId];
				if (
					navigatedItem &&
					navigatedItem.data.type !== "placeholder" &&
					(!navigatedItem.data.isArchived || showArchived)
				) {
					treeRef.current?.focusItem(selectedPageId, false);
					return;
				}
			}

			// Priority 2: Focus first visible item
			{
				for (const { item: itemId } of treeRef.current?.treeEnvironmentContext.linearItems?.[TREE_ID] ?? []) {
					const item = treeItems[itemId];
					if (item && item.data.type !== "placeholder" && (!item.data.isArchived || showArchived)) {
						treeRef.current?.focusItem(itemId, false);
						return;
					}
				}
			}
		}
	};

	return (
		<div
			ref={rootElement}
			className={cn(
				"PagesSidebarTreeArea" satisfies PagesSidebarTreeArea_ClassNames,
				isDraggingOverRootArea && ("PagesSidebarTreeArea-drag-over" satisfies PagesSidebarTreeArea_ClassNames),
			)}
			onDragOver={handleDragOverRootArea}
			onDragLeave={handleDragLeaveRootArea}
			onDragEnd={handleDragEndRootArea}
			onDrop={handleDropOnRootArea}
		>
			<UncontrolledTreeEnvironment
				viewState={{}}
				dataProvider={dataProvider}
				getItemTitle={(item) => item.data.title}
				canDropAt={(items, target) => {
					return true;
				}}
				canReorderItems={true}
				canDragAndDrop={true}
				canDropOnFolder={true}
				canDropOnNonFolder={false}
				canDropBelowOpenFolders={false}
				defaultInteractionMode={InteractionMode.ClickArrowToExpand}
				canInvokePrimaryActionOnItemContainer={true}
				shouldRenderChildren={handleShouldRenderChildren}
				onPrimaryAction={handlePrimaryAction}
				onSelectItems={onSelectItems}
				renderDragBetweenLine={(props) => {
					return <div {...props.lineProps} className="PagesSidebar-tree-drag-between-line" />;
				}}
				renderRenameInput={(props) => {
					return <PagesSidebarTreeRenameInput {...props} />;
				}}
				renderItemArrow={(props) => <PagesSidebarTreeItemArrow {...props} />}
				renderItem={(props) => {
					if (searchActive && visibleIds && props.item.index !== pages_ROOT_ID) {
						if (!visibleIds.has(props.item.index as string)) return null;
					}

					const isDragging = !!treeRef.current?.dragAndDropContext.draggingItems?.some(
						(draggingItem: any) => draggingItem.index === props.item.index,
					);

					return (
						<PagesSidebarTreeItem
							{...props}
							selectedPageId={selectedPageId}
							showArchived={showArchived}
							isDragging={isDragging}
							onAdd={onAddChild}
							onArchive={handleArchive}
							onUnarchive={handleUnarchive}
						/>
					);
				}}
				renderTreeContainer={(props) => {
					const { children } = props;

					const isDragging = !!treeRef.current?.dragAndDropContext.draggingItems;

					return (
						<div
							{...props.containerProps}
							className={cn(
								"PagesSidebarTreeArea-container" satisfies PagesSidebarTreeArea_ClassNames,
								props.info.isFocused &&
									("PagesSidebarTreeArea-container-focused" satisfies PagesSidebarTreeArea_ClassNames),
								isDragging && ("PagesSidebarTreeArea-container-dragging" satisfies PagesSidebarTreeArea_ClassNames),
							)}
							onBlur={handleBlur}
						>
							{children}
						</div>
					);
				}}
			>
				<PagesSidebarTree
					ref={(inst) => forward_ref(inst, ref, treeRef)}
					selectedPageId={selectedPageId}
					treeItems={treeItems}
					showArchived={showArchived}
				/>
			</UncontrolledTreeEnvironment>
		</div>
	);
}
// #endregion TreeArea

// #region PagesSidebar
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

type PagesSidebar_CssVars = {
	"--PagesSidebarTreeItem-content-depth": number;
};

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

	const renderPromise = useRenderPromise();

	const { toggleSidebar } = MainAppSidebar.useSidebar();

	const treeItemsList = useQuery(app_convex_api.ai_docs_temp.get_tree_items_list, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
	});

	const serverMovePages = useMutation(app_convex_api.ai_docs_temp.move_pages);
	const serverRenamePage = useMutation(app_convex_api.ai_docs_temp.rename_page);
	const serverCreatePage = useMutation(app_convex_api.ai_docs_temp.create_page);

	const root = pages_create_tree_root();
	const dataProvider = new PagesSidebarTreeDataProvider({
		initialData: {
			[root.index]: {
				index: root.index,
				children: [],
				data: root,
				isFolder: true,
				canMove: false,
				canRename: false,
			},
		},
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
		movePages: async (params) => {
			serverMovePages(params).catch((e) => console.error(`Error moving pages:`, e));
		},
		renamePage: async (params) => {
			serverRenamePage(params).catch((e) => console.error(`Error renaming page:`, e));
		},
		createPage: async (params) => {
			serverCreatePage(params).catch((e) => console.error(`Error creating page:`, e));
		},
	});

	// Reactive items state that updates when tree data changes
	const [treeItems, setTreeItems] = useState(() => {
		return dataProvider?.getAllData() || {};
	});

	const [searchQuery, setSearchQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);

	const [multiSelectionCount, setMultiSelectionCount] = useState(0);

	const archivedCount = treeItemsList ? treeItemsList.filter((item) => item.isArchived).length : -1;

	const treeRef = useRef<TreeRef | null>(null);

	// Update local tree data when remote tree data changes
	useEffect(() => {
		if (treeItemsList && dataProvider) {
			dataProvider.updateTreeData(treeItemsList, {
				showArchived,
			});
		}
	}, [treeItemsList, dataProvider, showArchived]);

	useEffect(() => {
		if (!dataProvider) {
			setTreeItems({});
			return;
		}

		setTreeItems(dataProvider.getAllData());

		const disposable = dataProvider.onDidChangeTreeData(() => {
			setTreeItems(dataProvider.getAllData());
		});

		return () => {
			disposable.dispose();
		};
	}, [dataProvider]);

	function createPage(parentPageId: string) {
		const newPageId = dataProvider.createNewItem(parentPageId, "New Page");

		navigate({
			to: "/pages",
			search: { pageId: newPageId, view },
		}).catch(console.error);

		return app_convex_wait_new_query_value(
			app_convex_api.ai_docs_temp.get_tree_items_list,
			{
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
			},
			{
				signal: AbortSignal.timeout(5000),
			},
		)
			.then((result) => {
				if (result._yay) {
					return renderPromise.wait({ signal: AbortSignal.timeout(5000) }).then(() => {
						treeRef.current?.startRenamingItem(newPageId);
					});
				}
			})
			.catch(console.error);
	}

	const handleFold = () => {
		treeRef.current?.collapseAll();
	};

	const handleUnfold = () => {
		treeRef.current?.expandAll();
	};

	const handleNewPage = async () => {
		await createPage(pages_ROOT_ID);
	};

	const handleAddChild = async (parentPageId: string) => {
		await createPage(parentPageId);
	};

	const handleClearSelection = () => {
		// Clear all tree selections
		treeRef.current?.selectItems([]);
	};

	const handleArchiveAll = () => {
		handleClearSelection();
	};

	const handleSelectItems: PagesSidebarTreeArea_Props["onSelectItems"] = (items, treeId) => {
		setMultiSelectionCount(items.length);
	};

	const handleToggleArchive = () => {
		setShowArchived((oldValue) => !oldValue);
	};

	const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setSearchQuery(e.target.value);
	};

	return (
		<PagesTreeContext.Provider
			value={{
				dataProvider,
				treeItems,
			}}
		>
			<MySidebar state={state} className={"PagesSidebar" satisfies PagesSidebar_ClassNames}>
				<div className={cn("PagesSidebar" satisfies PagesSidebar_ClassNames)}>
					<MySidebarHeader className={cn("PagesSidebar-header" satisfies PagesSidebar_ClassNames)}>
						<div className={cn("PagesSidebar-top-section" satisfies PagesSidebar_ClassNames)}>
							<div className={cn("PagesSidebar-top-section-left" satisfies PagesSidebar_ClassNames)}>
								{/* Hamburger Menu, mobile only */}
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
								<MyInputControl placeholder="Search pages" value={searchQuery} onChange={handleSearchChange} />
							</MyInputArea>
						</MyInput>

						<div className={cn("PagesSidebar-actions" satisfies PagesSidebar_ClassNames)}>
							<div className={cn("PagesSidebar-actions-group" satisfies PagesSidebar_ClassNames)}>
								<MyIconButton
									className={cn("PagesSidebar-actions-icon-button" satisfies PagesSidebar_ClassNames)}
									variant="secondary-subtle"
									tooltip="Unfold"
									onClick={handleUnfold}
								>
									<MyIconButtonIcon>
										<ChevronsDown />
									</MyIconButtonIcon>
								</MyIconButton>

								<MyIconButton
									className={cn("PagesSidebar-actions-icon-button" satisfies PagesSidebar_ClassNames)}
									variant="secondary-subtle"
									tooltip="Fold"
									onClick={handleFold}
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
											tooltip="Archive all"
											onClick={handleArchiveAll}
										>
											<MyIconButtonIcon>
												<ArchiveRestore />
											</MyIconButtonIcon>
										</MyIconButton>
										<MyIconButton
											className={cn("PagesSidebar-actions-icon-button" satisfies PagesSidebar_ClassNames)}
											variant="secondary"
											tooltip="Clear"
											onClick={handleClearSelection}
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
									onClick={handleNewPage}
								>
									<MyButtonIcon>
										<Plus />
									</MyButtonIcon>
									New Page
								</MyButton>
							)}
						</div>

						{archivedCount > 0 && (
							<MyButton
								className={cn("PagesSidebar-archive-toggle" satisfies PagesSidebar_ClassNames)}
								variant="ghost"
								onClick={handleToggleArchive}
							>
								{showArchived ? `Hide archived (${archivedCount})` : `Show archived (${archivedCount})`}
							</MyButton>
						)}
					</MySidebarHeader>

					<MySidebarContent className={cn("PagesSidebar-content" satisfies PagesSidebar_ClassNames)}>
						<PagesSidebarTreeArea
							ref={treeRef}
							selectedPageId={selectedPageId}
							searchQuery={searchQuery}
							showArchived={showArchived}
							onSelectItems={handleSelectItems}
							onArchive={onArchive}
							onPrimaryAction={onPrimaryAction}
							onAddChild={handleAddChild}
						/>
					</MySidebarContent>
				</div>
			</MySidebar>
		</PagesTreeContext.Provider>
	);
}
// #endregion PagesSidebar
