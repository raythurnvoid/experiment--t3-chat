import "./docs-sidebar-v2.css";
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
} from "lucide-react";
import { Sidebar, SidebarContent, SidebarHeader, SidebarProvider } from "@/components/ui/sidebar.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { cn, sx } from "@/lib/utils.ts";
import { IconButton } from "@/components/icon-button.tsx";
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
import { app_convex_api } from "../lib/app-convex-client.ts";

// Types for document structure - react-complex-tree format
interface DocData {
	title: string;
	type: "document" | "placeholder";
	content: string; // HTML content for the rich text editor - all documents have content
	isArchived: boolean;
}

// New simplified tree item structure from Convex
interface ConvexTreeItem {
	index: string;
	children: string[];
	title: string;
	content: string;
	isArchived: boolean;
}

// Custom TreeDataProvider for dynamic operations
class NotionLikeDataProvider implements TreeDataProvider<DocData> {
	private data: Record<TreeItemIndex, TreeItem<DocData>>;
	private treeChangeListeners: ((changedItemIds: TreeItemIndex[]) => void)[] = [];

	// NEW: Convex integration
	private convex: ConvexReactClient | null = null;
	private workspaceId: string;
	private projectId: string;

	constructor(
		initialData: Record<TreeItemIndex, TreeItem<DocData>>,
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
					type: isPlaceholder ? "placeholder" : "document",
					content: item.content,
					isArchived: item.isArchived || false,
				},
				isFolder: true,
				canMove: !isPlaceholder && key !== "root",
				canRename: !isPlaceholder && key !== "root",
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

		console.log("createNewItem called:", { parentId, doc_id: docId, parentChildren: parentItem?.children });

		if (parentItem) {
			const newItem: TreeItem<DocData> = {
				index: docId,
				children: [],
				data: {
					title,
					type: "document",
					content: `<h1>${title}</h1><p>Start writing your content here...</p>`,
					isArchived: false,
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
				console.log("Replaced placeholder with new item");
			} else {
				// Just add the new item to existing children
				updatedChildren = [...(parentItem.children || []), docId];
				console.log("Added new item to existing children");
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
				.then(() => {
					console.log("Document created in Convex");
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

type DocsSidebar_ClassNames =
	| "DocsSidebar-tree-area"
	| "DocsSidebar-tree-area-drag-over"
	| "DocsSidebar-tree-container"
	| "DocsSidebar-tree-container-focused"
	| "DocsSidebar-tree-item"
	| "DocsSidebar-tree-item-content"
	| "DocsSidebar-tree-item-content-placeholder"
	| "DocsSidebar-tree-item-main-row"
	| "DocsSidebar-tree-item-arrow"
	| "DocsSidebar-tree-item-file-icon"
	| "DocsSidebar-tree-item-primary-action-content"
	| "DocsSidebar-tree-item-primary-action-interactive-area"
	| "DocsSidebar-tree-item-actions"
	| "DocsSidebar-selection-counter";

type DocsSidebar_CssVars = {
	"--DocsSidebar-tree-item-content-depth": number;
};

type DocsTreeContext = {
	dataProvider: NotionLikeDataProvider;
	items: Record<TreeItemIndex, TreeItem<DocData>>;
};

const DocsTreeContext = createContext<DocsTreeContext | null>(null);

function useDocsTree() {
	const context = use(DocsTreeContext);
	if (!context) {
		throw new Error(`${useDocsTree.name} must be used within ${DocsTreeProvider.name}`);
	}
	return context;
}

type DocsTreeProvider_Props = {
	children: React.ReactNode;
};

function DocsTreeProvider({ children }: DocsTreeProvider_Props) {
	const convex = useConvex();

	const treeData = useQuery(app_convex_api.ai_docs_temp.get_tree, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
	});

	const dataProvider = useMemo(() => {
		const emptyData: Record<string, any> = {
			root: {
				index: "root",
				children: [],
				data: {
					title: "Documents",
					type: "document",
					content: "",
				},
				isFolder: true,
				canMove: false,
				canRename: false,
			},
		};

		const provider = new NotionLikeDataProvider(
			emptyData,
			convex,
			ai_chat_HARDCODED_ORG_ID,
			ai_chat_HARDCODED_PROJECT_ID,
		);
		return provider;
	}, [convex]);

	// Update data provider when tree data changes
	useEffect(() => {
		if (treeData && dataProvider && Object.keys(treeData).length > 0) {
			dataProvider.updateTreeData(treeData);
		}
	}, [treeData, dataProvider]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (dataProvider) {
				dataProvider.destroy();
			}
		};
	}, [dataProvider]);

	// Reactive items state that updates when tree data changes
	const [items, setItems] = useState<Record<TreeItemIndex, TreeItem<DocData>>>(() => {
		return dataProvider?.getAllData() || {};
	});

	useEffect(() => {
		if (!dataProvider) {
			setItems({});
			return;
		}

		setItems(dataProvider.getAllData());

		const disposable = dataProvider.onDidChangeTreeData(() => {
			setItems(dataProvider.getAllData());
		});

		return () => {
			disposable.dispose();
		};
	}, [dataProvider]);

	return (
		<DocsTreeContext.Provider
			value={{
				dataProvider,
				items,
			}}
		>
			{children}
		</DocsTreeContext.Provider>
	);
}

// Search Context
type DocsSearchContext = {
	searchQuery: string;
	showArchived: boolean;
	setSearchQuery: (query: string) => void;
	setShowArchived: (show: boolean) => void;
};

const DocsSearchContext = createContext<DocsSearchContext | null>(null);

const useDocsSearchContext = () => {
	const context = use(DocsSearchContext);
	if (!context) {
		throw new Error("useDocsSearchContext must be used within DocsSearchContextProvider");
	}
	return context;
};

type DocsSearchContextProvider_Props = {
	children: React.ReactNode;
};

function DocsSearchContextProvider({ children }: DocsSearchContextProvider_Props) {
	const [searchQuery, setSearchQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);

	return (
		<DocsSearchContext.Provider
			value={{
				searchQuery,
				setSearchQuery,
				showArchived,
				setShowArchived,
			}}
		>
			{children}
		</DocsSearchContext.Provider>
	);
}

interface TreeItemArrow_Props {
	item: TreeItem<DocData>;
	context: TreeItemRenderContext;
	info: TreeInformation;
}

function TreeItemArrow(props: TreeItemArrow_Props) {
	const { item, context } = props;

	// Only render arrow for folders
	if (!item.isFolder) return null;

	return (
		<IconButton
			{...(context.arrowProps as any)}
			tooltip={context.isExpanded ? "Collapse file" : "Expand file"}
			side="bottom"
			variant="ghost"
			size="icon"
			className={cn(
				"DocsSidebar-TreeItemArrow",
				"flex h-5 w-5 items-center justify-center p-0 text-muted-foreground hover:text-foreground",
			)}
		>
			{context.isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
		</IconButton>
	);
}

function TreeItemFileIcon() {
	return (
		<span
			className={cn(
				"DocsSidebar-tree-item-file-icon" satisfies DocsSidebar_ClassNames,
				"inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-sm",
			)}
		>
			<FileText className="h-4 w-4" />
		</span>
	);
}

type TreeItemPrimaryActionContent_Props = {
	title: React.ReactNode;
};

function TreeItemPrimaryActionContent(props: TreeItemPrimaryActionContent_Props) {
	const { title } = props;

	return (
		<div
			className={cn(
				"DocsSidebar-tree-item-primary-action-content" satisfies DocsSidebar_ClassNames,
				"text-sm outline-none",
			)}
		>
			<TreeItemFileIcon />
			<div className={cn("flex-1 truncate text-left")}>{title}</div>
		</div>
	);
}

type TreeItemNoChildrenPlaceholder_Props = {
	children: React.ReactNode;
	title: React.ReactNode;
	context: TreeItemRenderContext;
	depth: number;
};

function TreeItemNoChildrenPlaceholder(props: TreeItemNoChildrenPlaceholder_Props) {
	const { children, title, context, depth } = props;

	return (
		<li {...context.itemContainerWithChildrenProps} className="group relative">
			<div
				{...context.itemContainerWithoutChildrenProps}
				style={sx({ "--DocsSidebar-tree-item-content-depth": depth } satisfies Partial<DocsSidebar_CssVars>)}
				className={cn(
					"DocsSidebar-tree-item-content" satisfies DocsSidebar_ClassNames,
					"DocsSidebar-tree-item-content-placeholder" satisfies DocsSidebar_ClassNames,
					"border-2 border-transparent text-muted-foreground italic",
				)}
			>
				<TreeItemPrimaryActionContent title={title} />
			</div>
			{children}
		</li>
	);
}

type TreeItemActionIconButton_Props = {
	tooltip: string;
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
	children: React.ReactNode;
};

function TreeItemActionIconButton(props: TreeItemActionIconButton_Props) {
	const { tooltip, onClick, children } = props;

	return (
		<IconButton
			className="h-5 w-5 text-muted-foreground hover:text-sidebar-accent-foreground"
			variant="ghost"
			tooltip={tooltip}
			onClick={onClick}
		>
			{children}
		</IconButton>
	);
}

type TreeItem_Props = {
	item: TreeItem<DocData>;
	depth: number;
	children: React.ReactNode;
	title: React.ReactNode;
	context: TreeItemRenderContext;
	arrow: React.ReactNode;
	info: TreeInformation;
	selectedDocId?: string;
	showArchived: boolean;
	onAdd: (parentId: string) => void;
	onArchive: (itemId: string) => void;
	onUnarchive: (itemId: string) => void;
};

function TreeItem(props: TreeItem_Props) {
	const { item, depth, children, title, context, arrow, selectedDocId, showArchived, onAdd, onArchive, onUnarchive } =
		props;

	const data = item.data as DocData;

	// Current selected document
	const isNavigated = selectedDocId === item.index;
	const isPlaceholder = data.type === "placeholder";
	const isArchived = item.data.isArchived;
	const isRenaming = context.isRenaming;

	// Hide archived items when showArchived is false
	if (isArchived && !showArchived) {
		return null;
	}

	// Placeholder items
	if (isPlaceholder) {
		return <TreeItemNoChildrenPlaceholder children={children} title={title} context={context} depth={depth} />;
	}

	// Regular items
	return (
		<li
			{...context.itemContainerWithChildrenProps}
			className={cn("DocsSidebar-tree-item" satisfies DocsSidebar_ClassNames, "group relative")}
		>
			{/* Primary action */}
			<div
				{...context.itemContainerWithoutChildrenProps}
				style={sx({ "--DocsSidebar-tree-item-content-depth": depth } satisfies Partial<DocsSidebar_CssVars>)}
				className={cn(
					"DocsSidebar-tree-item-content" satisfies DocsSidebar_ClassNames,
					"rounded-md border-2 border-transparent ring-ring ring-offset-2 ring-offset-background hover:bg-sidebar-accent",

					isNavigated && "font-medium ring-1",
					context.isSelected && !isRenaming && "ring-2",
					context.isFocused &&
						!isRenaming &&
						"group-[.DocsSidebar-tree-container-focused]/DocsSidebar-tree-container:outline-2",
					context.isSelected && context.isFocused && !isRenaming && "ring-3 outline-0",
					context.isDraggingOver && [
						"border-dashed border-primary/40",
						"shadow-lg shadow-primary/20",
						"bg-gradient-to-br from-primary/10 via-primary/20 to-primary/10",
					],
					isArchived && "line-through opacity-60",
				)}
			>
				{context.isRenaming ? (
					<TreeItemPrimaryActionContent title={title} />
				) : (
					<button
						{...context.interactiveElementProps}
						type="button"
						className={cn("DocsSidebar-tree-item-primary-action-interactive-area" satisfies DocsSidebar_ClassNames)}
					>
						<TreeItemPrimaryActionContent title={title} />
					</button>
				)}

				{/* Expand/collapse arrow */}
				<div className={cn("DocsSidebar-tree-item-arrow" satisfies DocsSidebar_ClassNames)}>{arrow}</div>

				{/* Second row - action buttons */}
				<div className={cn("DocsSidebar-tree-item-actions" satisfies DocsSidebar_ClassNames)}>
					<TreeItemActionIconButton tooltip="Add child" onClick={() => onAdd(item.index.toString())}>
						<Plus />
					</TreeItemActionIconButton>

					<TreeItemActionIconButton tooltip="Rename" onClick={() => context.startRenamingItem()}>
						<Edit2 />
					</TreeItemActionIconButton>

					<TreeItemActionIconButton
						tooltip={isArchived ? "Unarchive" : "Archive"}
						onClick={() => {
							if (isArchived) {
								onUnarchive(item.index.toString());
							} else {
								onArchive(item.index.toString());
							}
						}}
					>
						<Archive className={cn(isArchived && "fill-current")} />
					</TreeItemActionIconButton>
				</div>
			</div>

			{children}
		</li>
	);
}

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
		<form {...formProps} className="flex w-full">
			<Input {...inputProps} ref={inputRef} className="h-5 flex-1 px-0.5" autoFocus onBlur={handleBlur} />
		</form>
	);
}

const TREE_ID = "docs-tree";
const ROOT_TREE_ID = "root";

type TreeArea_Props = {
	ref: React.RefObject<TreeRef | null>;
	selectedDocId?: string;
	onSelectItems: docs_TypedUncontrolledTreeEnvironmentProps["onSelectItems"];
	onAddChild: (parentId: string, newItemId: string) => void;
	onArchive: (itemId: string) => void;
	onPrimaryAction: (itemId: string, itemType: string) => void;
};

function TreeArea(props: TreeArea_Props) {
	const { ref, selectedDocId, onSelectItems, onAddChild, onArchive, onPrimaryAction } = props;

	const { searchQuery, showArchived } = useDocsSearchContext();
	const { dataProvider, items: treeItems } = useDocsTree();

	const convex = useConvex();

	// Get expanded items for view state
	const expandedItems = useMemo(() => {
		if (!dataProvider) return [];
		const allData = treeItems;
		const expanded: string[] = [];

		// Get the root item to find its direct children
		const rootItem = allData[ROOT_TREE_ID];
		if (rootItem && rootItem.children) {
			// Only expand direct children of root that are folders with children
			rootItem.children.forEach((childId) => {
				const childItem = allData[childId];
				if (childItem && childItem.isFolder && childItem.children && childItem.children.length > 0) {
					expanded.push(childId.toString());
				}
			});
		}

		return expanded;
	}, [dataProvider, searchQuery, treeItems]);

	const rootElement = useRef<HTMLDivElement>(null);

	const [isDraggingOverRootArea, setIsDraggingOverRootArea] = useState(false);

	const archiveDocument = useMutation(app_convex_api.ai_docs_temp.archive_pages);
	const unarchiveDocument = useMutation(app_convex_api.ai_docs_temp.unarchive_pages);

	const handleAddChild = (parentId: string) => {
		if (dataProvider) {
			const newItemId = dataProvider.createNewItem(parentId, "New Document");
			console.log("Created new document:", newItemId);
			onAddChild(parentId, newItemId);
		}
	};

	const handleArchive = (itemId: string) => {
		console.log("Archived item:", itemId);

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
		console.log("Unarchived item:", itemId);

		// Update local data immediately for better UX
		if (dataProvider) {
			dataProvider.updateArchiveStatus(itemId, false);
		}

		// Sync to Convex
		if (convex) {
			unarchiveDocument({
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
		if (item.data.type === "document") {
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

		// Filter children based on search query
		if (item.children && item.children.length > 0 && searchQuery.trim()) {
			const hasVisibleChildren = item.children.some((childId) => {
				// Check if child matches search query
				const childItem = treeItems[childId];
				if (childItem) {
					const titleMatches = childItem.data.title.toLowerCase().includes(searchQuery.toLowerCase());
					// For now, just check title match. Could add recursive search here if needed
					return titleMatches;
				}
				return false;
			});

			return hasVisibleChildren;
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

	const handleDropOnRootArea = async (e: React.DragEvent<HTMLDivElement>) => {
		setIsDraggingOverRootArea(false);

		if (e.target === rootElement.current) {
			e.preventDefault();

			// Get the currently dragged items from react-complex-tree
			const draggingItems = ref.current?.dragAndDropContext.draggingItems;

			if (!draggingItems || draggingItems.length === 0 || !dataProvider) {
				console.log("No dragging items found or no data provider");
				return;
			}

			try {
				const provider = dataProvider;
				const itemIds = draggingItems.map((item: any) => item.index as string);

				// ✅ Use currentItems (tree's live state) as source of truth - EXACTLY like internal drop
				const currentItems = ref.current?.treeEnvironmentContext.items || {};

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
					if (parent.index !== ROOT_TREE_ID) {
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
					provider.onChangeItemChildren(ROOT_TREE_ID, [
						...(currentItems[ROOT_TREE_ID]?.children ?? []).filter((i: any) => !itemIds.includes(i)),
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

	return (
		<div
			ref={rootElement}
			className={cn(
				"DocsSidebar-tree-area" satisfies DocsSidebar_ClassNames,
				isDraggingOverRootArea && ("DocsSidebar-tree-area-drag-over" satisfies DocsSidebar_ClassNames),
			)}
			onDragOver={handleDragOverRootArea}
			onDrop={handleDropOnRootArea}
		>
			<UncontrolledTreeEnvironment
				viewState={{
					[TREE_ID]: {
						expandedItems,
					},
				}}
				dataProvider={dataProvider}
				getItemTitle={(item) => item.data.title}
				canDropAt={(items, target) => {
					return true;
				}}
				canReorderItems={true}
				canDragAndDrop={true}
				canDropOnFolder={true}
				canDropOnNonFolder={true}
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
								"DocsSidebar-tree-drag-between-line",
								"h-2 border-2 border-solid border-red-500 bg-red-500",
							)}
						/>
					);
				}}
				renderRenameInput={(props) => {
					return <TreeRenameInputComponent {...props} />;
				}}
				renderItemArrow={(props) => <TreeItemArrow {...props} />}
				renderItem={(props) => {
					return (
						<TreeItem
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
					return (
						<div
							{...props.containerProps}
							className={cn(
								"DocsSidebar-tree-container" satisfies DocsSidebar_ClassNames,
								props.info.isFocused && ("DocsSidebar-tree-container-focused" satisfies DocsSidebar_ClassNames),
								"group/DocsSidebar-tree-container",
							)}
						>
							{props.children}
						</div>
					);
				}}
			>
				<Tree ref={ref} treeId={TREE_ID} rootItem={ROOT_TREE_ID} treeLabel="Documentation Tree" />
			</UncontrolledTreeEnvironment>
		</div>
	);
}

type DocsSidebarContent_Props = {
	selectedDocId?: string;
	onClose: () => void;
	onAddChild: (parentId: string, newItemId: string) => void;
	onArchive: (itemId: string) => void;
	onPrimaryAction: (itemId: string, itemType: string) => void;
};

function DocsSidebarContent(props: DocsSidebarContent_Props) {
	const { selectedDocId, onClose, onAddChild, onArchive, onPrimaryAction } = props;

	const { searchQuery, setSearchQuery, showArchived, setShowArchived } = useDocsSearchContext();
	const { dataProvider, items: treeItems } = useDocsTree();

	const treeRef = useRef<TreeRef | null>(null);

	const [multiSelectionCount, setMultiSelectionCount] = useState(0);

	// Handler functions for tree actions
	const handleFold = () => {
		treeRef.current?.collapseAll();
	};

	const handleUnfold = () => {
		treeRef.current?.expandAll();
	};

	const handleNewDoc = () => {
		// Add to root by default - could access treeRef.current for programmatic control
		// For now, this would need to be connected to handleAddChild in TreeContainer
		// or use treeRef.current?.navigateToDocument() for external navigation
		if (dataProvider) {
			const newItemId = dataProvider.createNewItem(ROOT_TREE_ID, "New Document");
			console.log("Created new document from header button:", newItemId);
			onAddChild(ROOT_TREE_ID, newItemId);
		}
	};

	const handleClearSelection = () => {
		// Clear all tree selections
		treeRef.current?.selectItems([]);
	};

	const handleArchiveAll = () => {
		handleClearSelection();
	};

	const handleSelectItems: TreeArea_Props["onSelectItems"] = (items, treeId) => {
		setMultiSelectionCount(items.length);
	};

	return (
		<div className={cn("DocsSidebarContent", "flex h-full flex-col")}>
			<SidebarHeader className="border-b">
				{/* Close button only if onClose is provided */}
				<div className="mb-4 flex items-center justify-between">
					<h2 className={cn("DocsSidebarContent-title", "text-lg font-semibold")}>Documentation</h2>
					<IconButton
						variant="ghost"
						size="icon"
						onClick={onClose}
						tooltip="Close"
						className={cn("DocsSidebarContent-close-button", "h-8 w-8")}
					>
						<X />
					</IconButton>
				</div>

				{/* Multi-selection counter */}
				{multiSelectionCount > 1 && (
					<div className={cn("DocsSidebar-selection-counter" satisfies DocsSidebar_ClassNames, "mb-4")}>
						<span className="font-medium">{multiSelectionCount} items selected</span>
						<div className="flex gap-1">
							<IconButton
								variant="ghost"
								size="icon"
								onClick={handleArchiveAll}
								tooltip="Archive all"
								className="h-6 w-6"
							>
								<Archive className="h-3 w-3" />
							</IconButton>
							<IconButton
								variant="ghost"
								size="icon"
								onClick={handleClearSelection}
								tooltip="Clear"
								className="h-6 w-6"
							>
								<X className="h-3 w-3" />
							</IconButton>
						</div>
					</div>
				)}

				{/* Search Form */}
				<div className={cn("DocsSidebarContent-search-container", "relative mb-4")}>
					<div className={cn("DocsSidebarContent-search-label", "mb-2 text-xs font-medium text-muted-foreground")}>
						Search docs
					</div>
					<input
						placeholder="Search documentation..."
						value={searchQuery}
						onChange={(e) => {
							const newQuery = e.target.value;
							setSearchQuery(newQuery);
							// Filtering is now handled by shouldRenderChildren prop
						}}
						className={cn(
							"DocsSidebarContent-search-input",
							"h-8 w-full rounded-md border border-input bg-background px-3 py-1 pl-8 text-sm shadow-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none",
						)}
					/>
					<Search
						className={cn(
							"DocsSidebarContent-search-icon",
							"pointer-events-none absolute top-8 left-2 h-4 w-4 text-muted-foreground",
						)}
					/>
				</div>

				<div className="mb-2 flex items-center gap-2">
					<div className="flex gap-1">
						<IconButton tooltip="Unfold" onClick={handleUnfold} variant="secondary">
							<ChevronsDown className="h-4 w-4" />
						</IconButton>

						<IconButton tooltip="Fold" onClick={handleFold} variant="secondary">
							<ChevronsUp className="h-4 w-4" />
						</IconButton>
					</div>

					<Button
						className={cn("DocsSidebarContent-new-doc-button", "flex-1 justify-start gap-2")}
						variant="outline"
						onClick={handleNewDoc}
					>
						<Plus className="h-4 w-4" />
						New Document
					</Button>
				</div>

				{/* Archived Toggle */}
				{(() => {
					const archivedCount = Object.values(treeItems).filter(
						(item) => item.data.isArchived && item.data.type !== "placeholder" && item.index !== "root",
					).length;
					return (
						archivedCount > 0 && (
							<div className="flex items-center justify-between">
								<span className="text-sm text-muted-foreground">Show archived ({archivedCount})</span>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										const newShowArchived = !showArchived;
										setShowArchived(newShowArchived);
										// Filtering is now handled by shouldRenderChildren prop
									}}
									className={cn("text-xs", showArchived && "bg-sidebar-accent")}
								>
									{showArchived ? "Hide" : "Show"}
								</Button>
							</div>
						)
					);
				})()}
			</SidebarHeader>

			<SidebarContent className="flex-1 overflow-auto">
				<TreeArea
					ref={treeRef}
					onSelectItems={handleSelectItems}
					selectedDocId={selectedDocId}
					onAddChild={onAddChild}
					onArchive={onArchive}
					onPrimaryAction={onPrimaryAction}
				/>
			</SidebarContent>
		</div>
	);
}

export type DocsSidebar_Props = React.ComponentProps<typeof Sidebar> & {
	selectedDocId?: string;
	onClose: () => void;
	onAddChild: (parentId: string, newItemId: string) => void;
	onArchive: (itemId: string) => void;
	onPrimaryAction: (itemId: string, itemType: string) => void;
};

export function DocsSidebar(props: DocsSidebar_Props) {
	const { className, selectedDocId, onClose, onAddChild, onArchive, onPrimaryAction, ...rest } = props;

	return (
		<SidebarProvider className={cn("DocsSidebar", "flex h-full w-full")}>
			<DocsSearchContextProvider>
				<DocsTreeProvider>
					<div className={cn("DocsSidebarContent-wrapper", "relative h-full w-full overflow-hidden", className)}>
						<Sidebar
							side="left"
							variant="sidebar"
							collapsible="none"
							className={cn("DocsSidebarContent-wrapper-sidebar", "h-full !border-r-0 [&>*]:!border-r-0")}
							style={{ borderRight: "none !important", width: "320px" }}
							{...rest}
						>
							<DocsSidebarContent
								onClose={onClose}
								selectedDocId={selectedDocId}
								onAddChild={onAddChild}
								onArchive={onArchive}
								onPrimaryAction={onPrimaryAction}
							/>
						</Sidebar>
					</div>
				</DocsTreeProvider>
			</DocsSearchContextProvider>
		</SidebarProvider>
	);
}
