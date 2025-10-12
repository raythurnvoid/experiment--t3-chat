import "./pages-sidebar.css";
import React, { useState, createContext, use, useMemo, useRef, useEffect } from "react";
import {
	FileText,
	Plus,
	Search,
	X,
	Archive,
	Edit2,
	ChevronRight,
	ChevronDown,
	ChevronsDown,
	ChevronsUp,
	Menu,
} from "lucide-react";
import { MySidebar, MySidebarContent, MySidebarHeader, type MySidebar_Props } from "@/components/my-sidebar.tsx";
import { MyInput, MyInputBox, MyInputArea, MyInputControl, MyInputIcon } from "@/components/my-input.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { cn, forward_ref, sx } from "@/lib/utils.ts";
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
} from "react-complex-tree";
import type { ConvexReactClient } from "convex/react";
import { useConvex, useQuery, useMutation } from "convex/react";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat.ts";
import { generate_timestamp_uuid } from "@/lib/utils.ts";
import { app_convex_api } from "@/lib/app-convex-client.ts";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { pages_ROOT_ID } from "@/lib/pages.ts";
import { formatRelativeTime, shouldShowAgoSuffix, shouldShowAtPrefix } from "@/lib/date.ts";
import { useNavigate } from "@tanstack/react-router";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { MyLink } from "../../../components/my-link.tsx";

/**
 * `react-complex-tree` item
 */
interface DocData {
	title: string;
	type: "page" | "placeholder";
	content: string; // HTML content for the rich text editor - all documents have content
	isArchived: boolean;
	updatedAt: number;
	updatedBy: string;
}

/**
 * `react-complex-tree` flat data record object
 */
type PagesSidebarTreeDataObject = Record<TreeItemIndex, TreeItem<DocData>>;

// New simplified tree item structure from Convex
interface ConvexTreeItem {
	index: string;
	children: string[];
	title: string;
	content: string;
	isArchived: boolean;
	updatedAt: number;
	updatedBy: string;
}

// Custom TreeDataProvider for dynamic operations
class NotionLikeDataProvider implements TreeDataProvider<DocData> {
	private data: PagesSidebarTreeDataObject;
	private treeChangeListeners: ((changedItemIds: TreeItemIndex[]) => void)[] = [];

	// NEW: Convex integration
	private convex: ConvexReactClient | null = null;
	private workspaceId: string;
	private projectId: string;

	constructor(
		initialData: PagesSidebarTreeDataObject,
		convex?: ConvexReactClient,
		workspaceId?: string,
		projectId?: string,
	) {
		// ✅ Store the already-sorted data
		this.data = { ...initialData };
		this.convex = convex || null;
		this.workspaceId = workspaceId || ai_chat_HARDCODED_ORG_ID;
		this.projectId = projectId || ai_chat_HARDCODED_PROJECT_ID;
	}

	// Method to update tree data from external source (like Convex query)
	updateTreeData(convexData: Record<string, ConvexTreeItem>) {
		// Convert Convex format to React Complex Tree format
		const convertedData: Record<TreeItemIndex, TreeItem<DocData>> = {};

		for (const [key, item] of Object.entries(convexData)) {
			const isPlaceholder = item.title === "No files inside";

			convertedData[key] = {
				index: item.index,
				children: item.children,
				data: {
					title: item.title,
					type: isPlaceholder ? "placeholder" : "page",
					content: item.content,
					isArchived: item.isArchived || false,
					updatedAt: item.updatedAt,
					updatedBy: item.updatedBy,
				},
				isFolder: isPlaceholder ? false : true,
				canMove: !isPlaceholder && key !== pages_ROOT_ID,
				canRename: !isPlaceholder && key !== pages_ROOT_ID,
			};
		}

		this.data = convertedData;
		const itemsKeys = Object.keys(convertedData);
		itemsKeys.forEach((key) => {
			const children = this.data[key].children;
			if (children) {
				this.data[key].children = this.sortChildren(children);
			}
		});
		this.notifyTreeChange(itemsKeys);
	}

	destroy() {
		this.treeChangeListeners = [];
	}

	async getTreeItem(itemId: TreeItemIndex): Promise<TreeItem<DocData>> {
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
			this.notifyTreeChange([itemId]);

			// Sync to Convex using doc_ids
			if (this.convex) {
				this.convex
					.mutation(app_convex_api.ai_docs_temp.move_pages, {
						itemIds: newChildren.map((id) => id.toString()),
						targetParentId: itemId.toString(),
						workspaceId: this.workspaceId,
						projectId: this.projectId,
					})
					.catch(console.error);
			}
		}
	}

	onDidChangeTreeData(listener: (changedItemIds: TreeItemIndex[]) => void): { dispose(): void } {
		this.treeChangeListeners.push(listener);
		return {
			dispose: () => {
				const index = this.treeChangeListeners.indexOf(listener);
				if (index > -1) {
					this.treeChangeListeners.splice(index, 1);
				}
			},
		};
	}

	async onRenameItem(item: TreeItem<DocData>, name: string): Promise<void> {
		const updatedItem = {
			...item,
			data: { ...item.data, title: name },
		};
		this.data[item.index] = updatedItem;
		this.notifyTreeChange([item.index]);

		// Find parent and re-sort its children since title changed
		const parentItem = Object.values(this.data).find((parent) => parent.children?.includes(item.index));
		if (parentItem && parentItem.children) {
			const sortedChildren = this.sortChildren(parentItem.children);
			this.data[parentItem.index] = {
				...parentItem,
				children: sortedChildren,
			};
			this.notifyTreeChange([parentItem.index]);
		}

		// Sync to Convex using doc_id
		if (this.convex) {
			try {
				await this.convex.mutation(app_convex_api.ai_docs_temp.rename_page, {
					workspaceId: this.workspaceId,
					projectId: this.projectId,
					pageId: item.index.toString(),
					name: name,
				});
			} catch (error) {
				console.error("Failed to rename in Convex:", error);
			}
		}
	}

	createNewItem(parentId: string, title: string = "Untitled"): string {
		const docId = generate_timestamp_uuid("doc");
		const parentItem = this.data[parentId];

		if (parentItem) {
			const newItem: TreeItem<DocData> = {
				index: docId,
				children: [],
				data: {
					title,
					type: "page",
					content: `<h1>${title}</h1><p>Start writing your content here...</p>`,
					isArchived: false,
					updatedAt: Date.now(),
					updatedBy: "user",
				},
				canMove: true,
				canRename: true,
				isFolder: true,
			};

			this.data[docId] = newItem;

			// Check if parent has a placeholder that needs to be replaced
			const placeholderId = `${parentId}-placeholder`;
			const hasPlaceholder = this.data[placeholderId] && parentItem.children?.includes(placeholderId);

			let updatedChildren: TreeItemIndex[];
			if (hasPlaceholder) {
				// Replace placeholder with new item
				updatedChildren = parentItem.children?.map((id) => (id === placeholderId ? docId : id)) || [docId];
				delete this.data[placeholderId];
			} else {
				// Just add the new item to existing children
				updatedChildren = [...(parentItem.children || []), docId];
			}

			// Update parent with new children array
			const updatedParent = {
				...parentItem,
				children: updatedChildren,
				isFolder: true,
			};

			this.data[parentId] = updatedParent;

			this.notifyTreeChange([parentId, docId]);
		}

		// Sync to Convex
		if (this.convex) {
			this.convex
				.mutation(app_convex_api.ai_docs_temp.create_page, {
					pageId: docId,
					parentId: parentId,
					name: title,
					workspaceId: this.workspaceId,
					projectId: this.projectId,
				})
				.catch(console.error);
		}

		return docId;
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
		this.treeChangeListeners.forEach((listener) => listener(changedItemIds));
	}

	updateArchiveStatus(itemId: TreeItemIndex, isArchived: boolean): void {
		if (this.data[itemId]) {
			this.data[itemId] = {
				...this.data[itemId],
				data: {
					...this.data[itemId].data,
					isArchived: isArchived,
				},
			};
			this.notifyTreeChange([itemId]);
		}
	}

	getAllData(): Record<TreeItemIndex, TreeItem<DocData>> {
		return { ...this.data };
	}
}

type docs_TypedUncontrolledTreeEnvironmentProps = UncontrolledTreeEnvironmentProps<DocData>;

type PagesSidebar_CssVars = {
	"--PagesSidebarTreeItem-content-depth": number;
};

type PagesSidebarTreeContext = {
	dataProvider: NotionLikeDataProvider;
	treeItems: Record<TreeItemIndex, TreeItem<DocData>>;
};

const PagesTreeContext = createContext<PagesSidebarTreeContext | null>(null);

type PagesSidebarTreeItemArrow_ClassNames = "PagesSidebarTreeItemArrow";

interface PagesSidebarTreeItemArrow_Props {
	item: TreeItem<DocData>;
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
			tooltip={context.isExpanded ? "Collapse page" : "Expand page"}
			side="bottom"
			variant="ghost"
			size="icon"
			className={cn(
				"PagesSidebarTreeItemArrow" satisfies PagesSidebarTreeItemArrow_ClassNames,
				"flex h-5 w-5 items-center justify-center p-0 text-muted-foreground hover:text-foreground",
			)}
		>
			<MyIcon>{context.isExpanded ? <ChevronDown /> : <ChevronRight />}</MyIcon>
		</MyIconButton>
	);
}

type PagesSidebarTreeItemFileIcon_ClassNames = "PagesSidebarTreeItemFileIcon";

function PagesSidebarTreeItemFileIcon() {
	return (
		<span
			className={cn(
				"PagesSidebarTreeItemFileIcon" satisfies PagesSidebarTreeItemFileIcon_ClassNames,
				"inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-sm",
			)}
		>
			<FileText className="h-4 w-4" />
		</span>
	);
}

type PagesSidebarTreeItemPrimaryActionContent_ClassNames = "PagesSidebarTreeItemPrimaryActionContent";

type PagesSidebarTreeItemPrimaryActionContent_Props = {
	title: React.ReactNode;
};

function PagesSidebarTreeItemPrimaryActionContent(props: PagesSidebarTreeItemPrimaryActionContent_Props) {
	const { title } = props;

	return (
		<div
			className={cn(
				"PagesSidebarTreeItemPrimaryActionContent" satisfies PagesSidebarTreeItemPrimaryActionContent_ClassNames,
				"text-sm outline-none",
			)}
		>
			<PagesSidebarTreeItemFileIcon />
			<div className="flex-1 truncate text-left">
				<div className="truncate">{title}</div>
			</div>
		</div>
	);
}

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
			className={cn(
				"PagesSidebarTreeItemNoChildrenPlaceholder" satisfies PagesSidebarTreeItemNoChildrenPlaceholder_ClassNames,
				"group relative",
			)}
		>
			<div
				{...context.itemContainerWithoutChildrenProps}
				style={sx({ "--PagesSidebarTreeItem-content-depth": depth } satisfies Partial<PagesSidebar_CssVars>)}
				className={cn(
					"PagesSidebarTreeItem-content" satisfies PagesSidebarTreeItem_ClassNames,
					"PagesSidebarTreeItem-content-placeholder" satisfies PagesSidebarTreeItem_ClassNames,
					"border-2 border-transparent text-muted-foreground italic",
				)}
			>
				<PagesSidebarTreeItemPrimaryActionContent title={title} />
			</div>
			{children}
		</li>
	);
}

type PagesSidebarTreeItemActionIconButton_ClassNames = "PagesSidebarTreeItemActionIconButton";

type PagesSidebarTreeItemActionIconButton_Props = {
	tooltip: string;
	children: React.ReactNode;
	isActive: boolean;
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
};

function PagesSidebarTreeItemActionIconButton(props: PagesSidebarTreeItemActionIconButton_Props) {
	const { tooltip, onClick, children, isActive } = props;

	return (
		<MyIconButton
			className={"PagesSidebarTreeItemActionIconButton" satisfies PagesSidebarTreeItemActionIconButton_ClassNames}
			variant="ghost-secondary"
			tooltip={tooltip}
			onClick={onClick}
			tabIndex={isActive ? 0 : -1}
		>
			<MyIconButtonIcon>{children}</MyIconButtonIcon>
		</MyIconButton>
	);
}

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
	item: TreeItem<DocData>;
	depth: number;
	children: React.ReactNode;
	title: React.ReactNode;
	context: TreeItemRenderContext;
	arrow: React.ReactNode;
	info: TreeInformation;
	selectedDocId: string | null;
	showArchived: boolean;
	onAdd: (parentId: string) => void;
	onArchive: (itemId: string) => void;
	onUnarchive: (itemId: string) => void;
};

function PagesSidebarTreeItem(props: PagesSidebarTreeItem_Props) {
	const { item, depth, children, title, context, arrow, selectedDocId, showArchived, onAdd, onArchive, onUnarchive } =
		props;

	const data = item.data as DocData;

	// Current selected document
	const isNavigated = selectedDocId === item.index;
	const isPlaceholder = data.type === "placeholder";
	const isArchived = item.data.isArchived;
	const isRenaming = context.isRenaming;

	// Meta text for non-placeholder items
	const metaText = !isPlaceholder ? `${formatRelativeTime(data.updatedAt)} ${data.updatedBy || "Unknown"}` : undefined;

	// Tooltip content for non-placeholder items
	const tooltipContent = !isPlaceholder
		? (() => {
				const relativeTime = formatRelativeTime(data.updatedAt);
				const showAt = shouldShowAtPrefix(data.updatedAt);
				const showAgo = shouldShowAgoSuffix(data.updatedAt);
				return `Updated${showAt ? " at" : ""} ${relativeTime}${showAgo ? " ago" : ""} by ${data.updatedBy || "Unknown"}`;
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
	const treeItemContent = (
		<li
			{...context.itemContainerWithChildrenProps}
			className={cn("PagesSidebarTreeItem" satisfies PagesSidebarTreeItem_ClassNames, "group relative")}
		>
			{/* Primary action */}
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
						tooltip={isArchived ? "Unarchive" : "Archive"}
						isActive={context.isFocused ?? false}
						onClick={() => {
							if (isArchived) {
								onUnarchive(item.index.toString());
							} else {
								onArchive(item.index.toString());
							}
						}}
					>
						<Archive className={cn(isArchived && "fill-current")} />
					</PagesSidebarTreeItemActionIconButton>
				</div>
			</div>

			{children}
		</li>
	);

	// Wrap with tooltip if content exists
	if (tooltipContent) {
		return (
			<Tooltip delayDuration={2000}>
				<TooltipTrigger asChild>{treeItemContent}</TooltipTrigger>
				<TooltipContent side="bottom" align="center">
					{tooltipContent}
				</TooltipContent>
			</Tooltip>
		);
	}

	return treeItemContent;
}

type TreeRenameInputComponent_ClassNames = "TreeRenameInputComponent";

type TreeRenameInputComponent_Props = {
	item: TreeItem<DocData>;
	inputProps: React.InputHTMLAttributes<HTMLInputElement>;
	inputRef: React.Ref<HTMLInputElement>;
	submitButtonProps: React.HTMLProps<any>;
	submitButtonRef: React.Ref<any>;
	formProps: React.FormHTMLAttributes<HTMLFormElement>;
};

function TreeRenameInputComponent(props: TreeRenameInputComponent_Props) {
	const { inputProps, inputRef, formProps } = props;

	// Override native blur behavior
	const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
		e.target.form?.requestSubmit();
	};

	return (
		<form
			{...formProps}
			className={cn("TreeRenameInputComponent" satisfies TreeRenameInputComponent_ClassNames, "flex w-full")}
		>
			<Input {...inputProps} ref={inputRef} className="h-5 flex-1 px-0.5" autoFocus onBlur={handleBlur} />
		</form>
	);
}

const TREE_ID = "pages-tree";

type PagesSidebarTreeArea_ClassNames =
	| "PagesSidebarTreeArea"
	| "PagesSidebarTreeArea-drag-over"
	| "PagesSidebarTreeArea-container"
	| "PagesSidebarTreeArea-container-focused"
	| "PagesSidebarTreeArea-container-dragging"
	| "PagesSidebar-tree-drag-between-line";

type PagesSidebarTreeArea_Props = {
	ref: React.Ref<TreeRef>;
	selectedDocId: string | null;
	searchQuery: string;
	showArchived: boolean;
	onSelectItems: docs_TypedUncontrolledTreeEnvironmentProps["onSelectItems"];
	onArchive: (itemId: string) => void;
	onPrimaryAction: (itemId: string, itemType: string) => void;
};

function PagesSidebarTreeArea(props: PagesSidebarTreeArea_Props) {
	const { ref, selectedDocId, searchQuery, showArchived, onSelectItems, onArchive, onPrimaryAction } = props;

	const context = use(PagesTreeContext);
	if (!context) {
		throw new Error(`${PagesSidebarTreeArea.name} must be used within ${PagesTreeContext.name}`);
	}

	const { dataProvider, treeItems } = context;

	const navigate = useNavigate();
	const convex = useConvex();

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
	useEffect(() => {
		if (treeRef.current && selectedDocId && treeItems[selectedDocId] && !treeRef.current.isFocused) {
			const navigatedItem = treeItems[selectedDocId];
			if (
				navigatedItem &&
				navigatedItem.data.type !== "placeholder" &&
				(!navigatedItem.data.isArchived || showArchived)
			) {
				treeRef.current.focusItem(selectedDocId, false);
			}
		}
	}, [selectedDocId, treeItems, showArchived]);

	const handleAddChild = (parentId: string) => {
		if (dataProvider) {
			const newItemId = dataProvider.createNewItem(parentId, "New Page");
			// Navigate to the new page
			navigate({
				to: "/pages",
				search: { pageId: newItemId },
			}).catch(console.error);
		}
	};

	const handleArchive = (itemId: string) => {
		// Update local data immediately for better UX
		if (dataProvider) {
			dataProvider.updateArchiveStatus(itemId, true);
		}

		// Sync to Convex
		if (convex) {
			archiveDocument({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId: itemId,
			}).catch(console.error);
		}

		onArchive(itemId);
	};

	const handleUnarchive = (itemId: string) => {
		// Update local data immediately for better UX
		if (dataProvider) {
			dataProvider.updateArchiveStatus(itemId, false);
		}

		// Sync to Convex
		if (convex) {
			unarchivePage({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId: itemId,
			}).catch(console.error);
		}
	};

	const handlePrimaryAction: docs_TypedUncontrolledTreeEnvironmentProps["onPrimaryAction"] = (
		item: TreeItem<DocData>,
		treeId: string,
	) => {
		if (item.data.type === "page") {
			onPrimaryAction(item.index.toString(), item.data.type);
		}
	};

	const handleShouldRenderChildren: docs_TypedUncontrolledTreeEnvironmentProps["shouldRenderChildren"] = (
		item: TreeItem<DocData>,
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

			try {
				const provider = dataProvider;
				const itemIds = draggingItems.map((item: any) => item.index as string);

				// ✅ Use currentItems (tree's live state) as source of truth - EXACTLY like internal drop
				const currentItems = treeRef.current?.treeEnvironmentContext.items || {};

				// ✅ Follow EXACT same pattern as UncontrolledTreeEnvironment's onDrop
				const promises: Promise<void>[] = [];

				// Step 1: Remove items from old parents (same logic as internal drop)
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

				// Step 2: Add items to root (same logic as internal drop for targetType === 'root')
				promises.push(
					provider.onChangeItemChildren(pages_ROOT_ID, [
						...(currentItems[pages_ROOT_ID]?.children ?? []).filter((i: any) => !itemIds.includes(i)),
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
			if (selectedDocId) {
				const navigatedItem = treeItems[selectedDocId];
				if (
					navigatedItem &&
					navigatedItem.data.type !== "placeholder" &&
					(!navigatedItem.data.isArchived || showArchived)
				) {
					treeRef.current?.focusItem(selectedDocId, false);
					return;
				}
			}

			// Priority 2: Focus first visible item
			{
				const linear = treeRef.current?.treeEnvironmentContext.linearItems?.[TREE_ID] ?? [];
				for (const { item: itemId } of linear) {
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
					return (
						<div
							{...props.lineProps}
							className={cn(
								"PagesSidebar-tree-drag-between-line",
								"h-2 border-2 border-solid border-red-500 bg-red-500",
							)}
						/>
					);
				}}
				renderRenameInput={(props) => {
					return <TreeRenameInputComponent {...props} />;
				}}
				renderItemArrow={(props) => <PagesSidebarTreeItemArrow {...props} />}
				renderItem={(props) => {
					if (searchActive && visibleIds && props.item.index !== pages_ROOT_ID) {
						if (!visibleIds.has(props.item.index as string)) return null;
					}

					return (
						<PagesSidebarTreeItem
							{...props}
							selectedDocId={selectedDocId}
							showArchived={showArchived}
							onAdd={handleAddChild}
							onArchive={handleArchive}
							onUnarchive={handleUnarchive}
						/>
					);
				}}
				renderTreeContainer={(props) => {
					const isDragging = !!treeRef.current?.dragAndDropContext.draggingItems;

					return (
						<div
							{...props.containerProps}
							onBlur={handleBlur}
							className={cn(
								"PagesSidebarTreeArea-container" satisfies PagesSidebarTreeArea_ClassNames,
								props.info.isFocused &&
									("PagesSidebarTreeArea-container-focused" satisfies PagesSidebarTreeArea_ClassNames),
								isDragging && ("PagesSidebarTreeArea-container-dragging" satisfies PagesSidebarTreeArea_ClassNames),
								"group/PagesSidebarTreeArea-container",
							)}
						>
							{props.children}
						</div>
					);
				}}
			>
				<Tree
					ref={(inst) => {
						return forward_ref(inst, ref, treeRef);
					}}
					treeId={TREE_ID}
					rootItem={pages_ROOT_ID}
					treeLabel="Pages"
				/>
			</UncontrolledTreeEnvironment>
		</div>
	);
}

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
	onClose: () => void;
	onArchive: (itemId: string) => void;
	onPrimaryAction: (itemId: string, itemType: string) => void;
};

export function PagesSidebar(props: PagesSidebar_Props) {
	const { selectedPageId, state = "expanded", onClose, onArchive, onPrimaryAction } = props;

	const convex = useConvex();
	const navigate = useNavigate();
	const { toggleSidebar } = MainAppSidebar.useSidebar();

	const treeData = useQuery(app_convex_api.ai_docs_temp.get_tree, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
	});

	const dataProvider = useMemo(() => {
		const provider = new NotionLikeDataProvider(
			// Initial data
			{
				root: {
					index: pages_ROOT_ID,
					children: [],
					data: {
						title: "Pages",
						type: "page",
						content: "",
						isArchived: false,
						updatedAt: 0,
						updatedBy: "",
					},
					isFolder: true,
					canMove: false,
					canRename: false,
				},
			},
			convex,
			ai_chat_HARDCODED_ORG_ID,
			ai_chat_HARDCODED_PROJECT_ID,
		);

		return provider;
	}, [convex]);

	// Reactive items state that updates when tree data changes
	const [treeItems, setTreeItems] = useState(() => {
		return dataProvider?.getAllData() || {};
	});

	const [searchQuery, setSearchQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);

	const [multiSelectionCount, setMultiSelectionCount] = useState(0);

	const archivedCount = Object.values(treeItems).filter(
		(item) => item.data.isArchived && item.data.type !== "placeholder" && item.index !== pages_ROOT_ID,
	).length;

	const treeRef = useRef<TreeRef | null>(null);

	// Update local tree data when remote tree data changes
	useEffect(() => {
		if (treeData && dataProvider && Object.keys(treeData).length > 0) {
			dataProvider.updateTreeData(treeData);
		}
	}, [treeData, dataProvider]);

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
			dataProvider.destroy();
		};
	}, [dataProvider]);

	const handleFold = () => {
		treeRef.current?.collapseAll();
	};

	const handleUnfold = () => {
		treeRef.current?.expandAll();
	};

	const handleNewPage = () => {
		const newItemId = dataProvider.createNewItem(pages_ROOT_ID, "New Page");
		navigate({
			to: "/pages",
			search: { pageId: newItemId },
		}).catch(console.error);
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
								<MyIcon>
									<X />
								</MyIcon>
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
												<Archive />
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
							selectedDocId={selectedPageId}
							searchQuery={searchQuery}
							showArchived={showArchived}
							onSelectItems={handleSelectItems}
							onArchive={onArchive}
							onPrimaryAction={onPrimaryAction}
						/>
					</MySidebarContent>
				</div>
			</MySidebar>
		</PagesTreeContext.Provider>
	);
}
