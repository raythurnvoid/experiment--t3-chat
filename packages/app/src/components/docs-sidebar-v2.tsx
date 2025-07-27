import * as React from "react";
import { FileText, Plus, Search, X, Archive, Edit2, ChevronRight, ChevronDown } from "lucide-react";
import { Sidebar, SidebarContent, SidebarHeader, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { useState, createContext, use, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { useThemeContext } from "@/components/theme-provider";
import { TooltipIconButton } from "./assistant-ui/tooltip-icon-button";
import {
	UncontrolledTreeEnvironment,
	Tree,
	InteractionMode,
	type TreeDataProvider,
	type TreeItemIndex,
	type TreeItem,
	type TreeRef,
	type TreeItemRenderContext,
} from "react-complex-tree";
import "./docs-sidebar-v2.css";

// Types for document structure - react-complex-tree format
interface DocData {
	id: string;
	title: string;
	url: string;
	type: "folder" | "document" | "placeholder";
}

// Function to create tree data with placeholders for empty folders
const createTreeDataWithPlaceholders = (): Record<TreeItemIndex, TreeItem<DocData>> => {
	// Base tree data
	const baseData: Record<TreeItemIndex, TreeItem<DocData>> = {
		root: {
			index: "root",
			isFolder: true,
			children: ["getting-started", "user-guide", "api", "tutorials", "troubleshooting"],
			data: {
				id: "root",
				title: "Documentation",
				url: "#",
				type: "folder",
			},
			canMove: false,
			canRename: false,
		},
		"getting-started": {
			index: "getting-started",
			isFolder: true,
			children: ["introduction", "installation", "quick-start"],
			data: {
				id: "getting-started",
				title: "Getting Started",
				url: "#getting-started",
				type: "folder",
			},
			canMove: true,
			canRename: true,
		},
		introduction: {
			index: "introduction",
			children: [],
			data: {
				id: "introduction",
				title: "Introduction",
				url: "#introduction",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		installation: {
			index: "installation",
			children: [],
			data: {
				id: "installation",
				title: "Installation",
				url: "#installation",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		"quick-start": {
			index: "quick-start",
			children: [],
			data: {
				id: "quick-start",
				title: "Quick Start Guide",
				url: "#quick-start",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		"user-guide": {
			index: "user-guide",
			isFolder: true,
			children: ["dashboard", "projects", "collaboration"],
			data: {
				id: "user-guide",
				title: "User Guide",
				url: "#user-guide",
				type: "folder",
			},
			canMove: true,
			canRename: true,
		},
		dashboard: {
			index: "dashboard",
			children: [],
			data: {
				id: "dashboard",
				title: "Dashboard Overview",
				url: "#dashboard",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		projects: {
			index: "projects",
			children: [],
			data: {
				id: "projects",
				title: "Managing Projects",
				url: "#projects",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		collaboration: {
			index: "collaboration",
			isFolder: true,
			children: ["sharing", "comments", "real-time"],
			data: {
				id: "collaboration",
				title: "Collaboration",
				url: "#collaboration",
				type: "folder",
			},
			canMove: true,
			canRename: true,
		},
		sharing: {
			index: "sharing",
			children: [],
			data: {
				id: "sharing",
				title: "Sharing Documents",
				url: "#sharing",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		comments: {
			index: "comments",
			children: [],
			data: {
				id: "comments",
				title: "Comments & Reviews",
				url: "#comments",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		"real-time": {
			index: "real-time",
			children: [],
			data: {
				id: "real-time",
				title: "Real-time Editing",
				url: "#real-time",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		api: {
			index: "api",
			isFolder: true,
			children: ["authentication", "endpoints", "webhooks", "examples"],
			data: {
				id: "api",
				title: "API Reference",
				url: "#api",
				type: "folder",
			},
			canMove: true,
			canRename: true,
		},
		authentication: {
			index: "authentication",
			children: [],
			data: {
				id: "authentication",
				title: "Authentication",
				url: "#authentication",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		endpoints: {
			index: "endpoints",
			children: [],
			data: {
				id: "endpoints",
				title: "API Endpoints",
				url: "#endpoints",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		webhooks: {
			index: "webhooks",
			children: [],
			data: {
				id: "webhooks",
				title: "Webhooks",
				url: "#webhooks",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		examples: {
			index: "examples",
			isFolder: true,
			children: ["javascript", "python", "curl"],
			data: {
				id: "examples",
				title: "Examples",
				url: "#examples",
				type: "folder",
			},
			canMove: true,
			canRename: true,
		},
		javascript: {
			index: "javascript",
			children: [],
			data: {
				id: "javascript",
				title: "JavaScript SDK",
				url: "#javascript",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		python: {
			index: "python",
			children: [],
			data: {
				id: "python",
				title: "Python SDK",
				url: "#python",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		curl: {
			index: "curl",
			children: [],
			data: {
				id: "curl",
				title: "cURL Examples",
				url: "#curl",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		tutorials: {
			index: "tutorials",
			isFolder: true,
			children: ["basic-setup", "advanced-features", "integrations"],
			data: {
				id: "tutorials",
				title: "Tutorials",
				url: "#tutorials",
				type: "folder",
			},
			canMove: true,
			canRename: true,
		},
		"basic-setup": {
			index: "basic-setup",
			children: [],
			data: {
				id: "basic-setup",
				title: "Basic Setup",
				url: "#basic-setup",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		"advanced-features": {
			index: "advanced-features",
			children: [],
			data: {
				id: "advanced-features",
				title: "Advanced Features",
				url: "#advanced-features",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		integrations: {
			index: "integrations",
			children: [],
			data: {
				id: "integrations",
				title: "Third-party Integrations",
				url: "#integrations",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		troubleshooting: {
			index: "troubleshooting",
			isFolder: true,
			children: ["common-issues", "performance", "support"],
			data: {
				id: "troubleshooting",
				title: "Troubleshooting",
				url: "#troubleshooting",
				type: "folder",
			},
			canMove: true,
			canRename: true,
		},
		"common-issues": {
			index: "common-issues",
			children: [],
			data: {
				id: "common-issues",
				title: "Common Issues",
				url: "#common-issues",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		performance: {
			index: "performance",
			children: [],
			data: {
				id: "performance",
				title: "Performance Tips",
				url: "#performance",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
		support: {
			index: "support",
			children: [],
			data: {
				id: "support",
				title: "Getting Support",
				url: "#support",
				type: "document",
			},
			canMove: true,
			canRename: true,
		},
	};

	// Create modified data where all items are foldable and empty ones get placeholders
	const modifiedData: Record<TreeItemIndex, TreeItem<DocData>> = {};

	// Copy base data and modify
	for (const [key, item] of Object.entries(baseData)) {
		const hasChildren = item.children && item.children.length > 0;
		const placeholderId = `${key}-placeholder`;

		modifiedData[key] = {
			...item,
			isFolder: true, // Make all items foldable
			children: hasChildren ? item.children : [placeholderId], // Add placeholder for empty items
		};

		// Add placeholder item for empty folders
		if (!hasChildren) {
			modifiedData[placeholderId] = {
				index: placeholderId,
				children: [],
				data: {
					id: placeholderId,
					title: "No files inside",
					url: "#",
					type: "placeholder",
				},
				canMove: false,
				canRename: false,
			};
		}
	}

	return modifiedData;
};

// Search Context
interface DocsSearchContextType {
	searchQuery: string;
	setSearchQuery: (query: string) => void;
	selectedDocId: string | null;
	setSelectedDocId: (id: string | null) => void;
	showArchived: boolean;
	setShowArchived: (show: boolean) => void;
	archivedItems: Set<string>;
	setArchivedItems: (items: Set<string>) => void;
	dataProviderRef: React.MutableRefObject<NotionLikeDataProvider | null>;
	treeRef: React.MutableRefObject<TreeRef | null>;
}

const DocsSearchContext = createContext<DocsSearchContextType | null>(null);

const useDocsSearchContext = () => {
	const context = use(DocsSearchContext);
	if (!context) {
		throw new Error("useDocsSearchContext must be used within DocsSearchContextProvider");
	}
	return context;
};

interface DocsSearchContextProvider_Props {
	children: React.ReactNode;
}

function DocsSearchContextProvider({ children }: DocsSearchContextProvider_Props) {
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedDocId, setSelectedDocId] = useState<string | null>("getting-started");
	const [showArchived, setShowArchived] = useState(false);
	const [archivedItems, setArchivedItems] = useState<Set<string>>(new Set());
	const dataProviderRef = useRef<NotionLikeDataProvider | null>(null);
	const treeRef = useRef<TreeRef | null>(null);

	return (
		<DocsSearchContext.Provider
			value={{
				searchQuery,
				setSearchQuery,
				selectedDocId,
				setSelectedDocId,
				showArchived,
				setShowArchived,
				archivedItems,
				setArchivedItems,
				dataProviderRef,
				treeRef,
			}}
		>
			{children}
		</DocsSearchContext.Provider>
	);
}

// Main sidebar content component
function DocsSidebarContent({ onClose }: { onClose?: () => void }) {
	const { searchQuery, setSearchQuery, showArchived, setShowArchived, archivedItems, dataProviderRef, treeRef } =
		useDocsSearchContext();

	return (
		<div className={cn("DocsSidebarContent", "flex h-full flex-col")}>
			<SidebarHeader className="border-b">
				{/* Close button only if onClose is provided */}
				{onClose && (
					<div className="mb-4 flex items-center justify-between">
						<h2 className={cn("DocsSidebarContent-title", "text-lg font-semibold")}>Documentation</h2>
						<Button
							variant="ghost"
							size="icon"
							onClick={onClose}
							className={cn("DocsSidebarContent-close-button", "h-8 w-8")}
						>
							<X className="h-4 w-4" />
						</Button>
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

				{/* New Document Button */}
				<Button
					className={cn("DocsSidebarContent-new-doc-button", "mb-2 w-full justify-start gap-2")}
					variant="outline"
					onClick={() => {
						// Add to root by default - could access treeRef.current for programmatic control
						// For now, this would need to be connected to handleAddChild in TreeContainer
						// or use treeRef.current?.navigateToDocument() for external navigation
						if (dataProviderRef.current) {
							const newItemId = dataProviderRef.current.createNewItem("root", "New Document", "document");
							console.log("Created new document from header button:", newItemId);
						}
					}}
				>
					<Plus className="h-4 w-4" />
					New Document
				</Button>

				{/* Show Archived Toggle */}
				{archivedItems.size > 0 && (
					<div className="flex items-center justify-between">
						<span className="text-sm text-muted-foreground">Show archived ({archivedItems.size})</span>
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
				)}
			</SidebarHeader>

			<SidebarContent className="flex-1 overflow-auto">
				<TreeContainer />
			</SidebarContent>
		</div>
	);
}

// Custom TreeDataProvider for dynamic operations
class NotionLikeDataProvider implements TreeDataProvider<DocData> {
	private data: Record<TreeItemIndex, TreeItem<DocData>>;
	private treeChangeListeners: ((changedItemIds: TreeItemIndex[]) => void)[] = [];

	constructor(initialData: Record<TreeItemIndex, TreeItem<DocData>>) {
		this.data = { ...initialData };
	}

	async getTreeItem(itemId: TreeItemIndex): Promise<TreeItem<DocData>> {
		const item = this.data[itemId];
		if (!item) {
			throw new Error(`Item ${itemId} not found`);
		}

		// ✅ CORRECT: Return data as-is, no filtering in getTreeItem
		return item;
	}

	async onChangeItemChildren(itemId: TreeItemIndex, newChildren: TreeItemIndex[]): Promise<void> {
		if (this.data[itemId]) {
			this.data[itemId] = {
				...this.data[itemId],
				children: newChildren,
			};
			this.notifyTreeChange([itemId]);
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
	}

	// Custom methods for Notion-like operations
	createNewItem(parentId: string, title: string = "Untitled", type: "folder" | "document" = "document"): string {
		const newItemId = `${type}-${Date.now()}`;
		const parentItem = this.data[parentId];

		console.log("createNewItem called:", { parentId, newItemId, parentChildren: parentItem?.children });

		if (parentItem) {
			// Create new item
			const newItem: TreeItem<DocData> = {
				index: newItemId,
				children: [],
				data: {
					id: newItemId,
					title,
					url: `#${newItemId}`,
					type,
				},
				canMove: true,
				canRename: true,
				isFolder: type === "folder",
			};

			this.data[newItemId] = newItem;

			// Check if parent has a placeholder that needs to be replaced
			const placeholderId = `${parentId}-placeholder`;
			const hasPlaceholder = this.data[placeholderId] && parentItem.children?.includes(placeholderId);

			let updatedChildren: TreeItemIndex[];
			if (hasPlaceholder) {
				// Replace placeholder with new item
				updatedChildren = parentItem.children?.map((id) => (id === placeholderId ? newItemId : id)) || [newItemId];
				delete this.data[placeholderId];
				console.log("Replaced placeholder with new item");
			} else {
				// Just add the new item to existing children
				updatedChildren = [...(parentItem.children || []), newItemId];
				console.log("Added new item to existing children");
			}

			// Update parent with new children array
			const updatedParent = {
				...parentItem,
				children: updatedChildren,
				isFolder: true,
			};

			this.data[parentId] = updatedParent;

			this.notifyTreeChange([parentId, newItemId]);
		}

		return newItemId;
	}

	// Helper methods
	private notifyTreeChange(changedItemIds: TreeItemIndex[]): void {
		this.treeChangeListeners.forEach((listener) => listener(changedItemIds));
	}

	// Get all tree data (for debugging)
	getAllData(): Record<TreeItemIndex, TreeItem<DocData>> {
		return { ...this.data };
	}
}

// Tree Item Component - extracted to properly use hooks
interface TreeItemComponent_Props {
	item: TreeItem<DocData>;
	depth: number;
	children: React.ReactNode;
	title: React.ReactNode;
	context: TreeItemRenderContext;
	arrow: React.ReactNode;
	selectedDocId: string | null;
	setSelectedDocId: (id: string | null) => void;
	archivedItems: Set<string>;
	setArchivedItems: (items: Set<string>) => void;
	showArchived: boolean;
	dataProvider: NotionLikeDataProvider;
	treeRef: React.MutableRefObject<TreeRef | null>;
}

function TreeItemComponent({
	item,
	depth,
	children,
	title,
	context,
	arrow,
	selectedDocId,
	setSelectedDocId,
	archivedItems,
	setArchivedItems,
	showArchived,
	dataProvider,
	treeRef,
}: TreeItemComponent_Props) {
	const triggerId = React.useId(); // Now properly used in a component
	const data = item.data as DocData;
	const isSelected = selectedDocId === item.index;
	const isPlaceholder = data.type === "placeholder";
	const isArchived = archivedItems.has(item.index.toString());

	// Action handlers
	const handleAddChild = (parentId: string) => {
		// First, expand the parent item if it's not already expanded
		treeRef.current?.expandItem(parentId);

		const newItemId = dataProvider.createNewItem(parentId, "Untitled", "document");
		console.log("Created new item:", newItemId, "in parent:", parentId);

		// Enhanced UX: Auto-select, focus, and start renaming the new item
		setSelectedDocId(newItemId);

		// Use setTimeout to ensure the item is rendered before we interact with it
		setTimeout(() => {
			treeRef.current?.selectItems([newItemId]);
			treeRef.current?.focusItem(newItemId, true);
			treeRef.current?.startRenamingItem(newItemId);
		}, 50);
	};

	const handleArchive = (itemId: string) => {
		// Update context state
		const newArchivedSet = new Set(archivedItems);
		newArchivedSet.add(itemId);
		setArchivedItems(newArchivedSet);

		console.log("Archived item:", itemId);

		// If we archived the currently selected item, clear selection
		if (selectedDocId === itemId) {
			setSelectedDocId(null);
		}
	};

	// Hide archived items when showArchived is false
	if (isArchived && !showArchived) {
		return null;
	}

	// Placeholder items have special rendering
	if (isPlaceholder) {
		return (
			<li {...context.itemContainerWithChildrenProps} className="group relative">
				<div
					{...context.itemContainerWithoutChildrenProps}
					style={{ paddingLeft: `${(depth + 1) * 16}px` }}
					className={cn("flex min-h-[32px] items-center gap-2 rounded-md px-2 py-1", "text-muted-foreground italic")}
				>
					{/* No arrow for placeholders */}
					<div className="flex h-4 w-4 items-center justify-center"></div>

					{/* Icon for placeholder */}
					<span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-sm">
						<FileText className="h-4 w-4 opacity-50" />
					</span>

					{/* Non-interactive title */}
					<div className="flex-1 truncate p-0 text-left text-sm">{title}</div>
				</div>
				{/* No action buttons for placeholders */}
				{children}
			</li>
		);
	}

	// Regular items (folders and documents)
	return (
		<li {...context.itemContainerWithChildrenProps} className="group relative">
			{/* Label wrapper that forwards clicks to the main selection trigger */}
			<label
				className={cn(
					"DocsSidebarTreeItem-container",
					"block w-full cursor-pointer rounded-md hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
					isSelected && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
					isArchived && "line-through opacity-60",
				)}
				htmlFor={triggerId}
			>
				{/* First row - main item content */}
				<div
					{...context.itemContainerWithoutChildrenProps}
					style={{ paddingLeft: `${(depth + 1) * 16}px` }}
					className={cn("flex h-[32px] items-center gap-2 px-2 py-1")}
				>
					{/* Expand/collapse arrow - now with custom icon and tooltip */}
					{arrow}

					{/* Title with icon - handles selection only, prevents default expand/collapse */}
					{context.isRenaming ? (
						<div className="flex flex-1 items-center gap-2 truncate border-none bg-transparent p-0 text-left text-sm outline-none">
							{/* Icon for document type */}
							<span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-sm">
								<FileText className="h-4 w-4" />
							</span>
							<span className="truncate">{title}</span>
						</div>
					) : (
						<button
							{...context.interactiveElementProps}
							id={triggerId}
							type="button"
							className="flex flex-1 items-center gap-2 truncate border-none bg-transparent p-0 text-left text-sm outline-none"
						>
							{/* Icon for document type */}
							<span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-sm">
								<FileText className="h-4 w-4" />
							</span>
							<span className="truncate">{title}</span>
						</button>
					)}
				</div>

				{/* Second row - action buttons */}
				<div
					style={{ paddingLeft: `${(depth + 1) * 16 + 32}px` }}
					className="flex h-[32px] items-center justify-end gap-1 px-2 py-1"
				>
					{/* Add child button - for all items (since all are now foldable) */}
					<TooltipIconButton
						className="h-6 w-6 p-0 text-muted-foreground hover:text-sidebar-accent-foreground"
						variant="ghost"
						tooltip="Add child"
						onClick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							handleAddChild(item.index.toString());
						}}
					>
						<Plus className="h-3 w-3" />
					</TooltipIconButton>

					{/* Edit button - for all items */}
					<TooltipIconButton
						className="h-6 w-6 p-0 text-muted-foreground hover:text-sidebar-accent-foreground"
						variant="ghost"
						tooltip="Rename"
						onClick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							context.startRenamingItem();
						}}
					>
						<Edit2 className="h-3 w-3" />
					</TooltipIconButton>

					{/* Archive/Unarchive button - for all items except root */}
					{item.index !== "root" && (
						<TooltipIconButton
							className="h-6 w-6 p-0 text-muted-foreground hover:text-sidebar-accent-foreground"
							variant="ghost"
							tooltip={isArchived ? "Unarchive" : "Archive"}
							onClick={(e) => {
								e.preventDefault();
								e.stopPropagation();
								if (isArchived) {
									// Update context state
									const newArchivedSet = new Set(archivedItems);
									newArchivedSet.delete(item.index.toString());
									setArchivedItems(newArchivedSet);

									console.log("Unarchived item:", item.index);
								} else {
									handleArchive(item.index.toString());
								}
							}}
						>
							<Archive className={cn("h-3 w-3", isArchived && "fill-current")} />
						</TooltipIconButton>
					)}
				</div>
			</label>

			{/* Children */}
			{children}
		</li>
	);
}

// Tree Rename Input Component - handles blur to complete and escape to abort
interface TreeRenameInput_Props {
	item: TreeItem<DocData>;
	inputProps: React.InputHTMLAttributes<HTMLInputElement>;
	inputRef: React.Ref<HTMLInputElement>;
	formProps: React.FormHTMLAttributes<HTMLFormElement>;
	treeRef: React.MutableRefObject<TreeRef | null>;
}

function TreeRenameInput({ item, inputProps, inputRef, formProps, treeRef }: TreeRenameInput_Props) {
	return (
		<form
			{...formProps}
			onSubmit={(e) => {
				e.preventDefault();
				// Complete rename on form submit (Enter key)
				treeRef.current?.completeRenamingItem();
			}}
			className="flex w-full"
		>
			<input
				{...inputProps}
				ref={inputRef}
				className={cn(
					"flex-1 rounded border border-input bg-background px-2 py-1 text-sm",
					"focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-none",
				)}
				onBlur={() => {
					// Apply changes on blur (losing focus)
					treeRef.current?.completeRenamingItem();
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						// Revert changes on Escape
						treeRef.current?.abortRenamingItem();
					}
					// Let other keys (like Enter) bubble up to form submit
				}}
				autoFocus
			/>
		</form>
	);
}

// Separate component to use the theme context
function TreeContainer() {
	const {
		searchQuery,
		selectedDocId,
		setSelectedDocId,
		archivedItems,
		setArchivedItems,
		showArchived,
		dataProviderRef,
		treeRef,
	} = useDocsSearchContext();
	const { resolved_theme } = useThemeContext();
	const isDarkMode = resolved_theme === "dark";

	// Create custom data provider (stable instance)
	const dataProvider = useMemo(() => {
		const provider = new NotionLikeDataProvider(createTreeDataWithPlaceholders());
		dataProviderRef.current = provider; // Store in ref for access from other components
		return provider;
	}, []); // Empty dependency array - provider should only be created once

	// No automatic synchronization - state updated explicitly in event handlers

	// Programmatic tree control functions
	const navigateToDocument = (docId: string) => {
		// Programmatically focus and select a document
		treeRef.current?.focusItem(docId, true); // Focus with DOM focus
		treeRef.current?.selectItems([docId]); // Select the item
		setSelectedDocId(docId);
		console.log("Navigated to document:", docId);
	};

	const expandToPath = async (path: string[]) => {
		// Expand the full path to show a deeply nested item
		await treeRef.current?.expandSubsequently(path);
		// Then select the final item
		const finalItem = path[path.length - 1];
		treeRef.current?.selectItems([finalItem]);
		setSelectedDocId(finalItem);
		console.log("Expanded to path:", path);
	};

	const expandAll = () => {
		treeRef.current?.expandAll();
		console.log("Expanded all items");
	};

	const collapseAll = () => {
		treeRef.current?.collapseAll();
		console.log("Collapsed all items");
	};

	// Action handlers
	const handleAddChild = (parentId: string) => {
		const newItemId = dataProvider.createNewItem(parentId, "Untitled", "document");
		console.log("Created new item:", newItemId, "in parent:", parentId);

		// Enhanced UX: Auto-select, focus, and start renaming the new item
		setSelectedDocId(newItemId);

		// Use setTimeout to ensure the item is rendered before we interact with it
		setTimeout(() => {
			treeRef.current?.selectItems([newItemId]);
			treeRef.current?.focusItem(newItemId, true);
			treeRef.current?.startRenamingItem(newItemId);
		}, 50);
	};

	const handleArchive = (itemId: string) => {
		// Update context state
		const newArchivedSet = new Set(archivedItems);
		newArchivedSet.add(itemId);
		setArchivedItems(newArchivedSet);

		console.log("Archived item:", itemId);

		// If we archived the currently selected item, clear selection
		if (selectedDocId === itemId) {
			setSelectedDocId(null);
		}
	};

	// Keyboard shortcuts for additional tree control
	React.useEffect(() => {
		const handleKeyPress = (e: KeyboardEvent) => {
			// Only handle if the tree area is focused (not when typing in search input)
			const isTreeFocused = document.activeElement?.closest(".rct-tree-root") !== null;

			if (isTreeFocused && e.ctrlKey) {
				switch (e.key) {
					case "e":
						e.preventDefault();
						expandAll();
						break;
					case "w":
						e.preventDefault();
						collapseAll();
						break;
					default:
						break;
				}
			}
		};

		document.addEventListener("keydown", handleKeyPress);
		return () => document.removeEventListener("keydown", handleKeyPress);
	}, []);

	// Store helper functions in refs for external access (could be used by parent components)
	React.useEffect(() => {
		if (treeRef.current) {
			// Extend the tree ref with our custom helper functions
			(treeRef.current as any).navigateToDocument = navigateToDocument;
			(treeRef.current as any).expandToPath = expandToPath;
			(treeRef.current as any).expandAll = expandAll;
			(treeRef.current as any).collapseAll = collapseAll;
		}
	}, []);

	return (
		<div className={cn("p-2", isDarkMode && "rct-dark")}>
			<UncontrolledTreeEnvironment
				dataProvider={dataProvider}
				getItemTitle={(item) => item.data.title}
				canDragAndDrop={true}
				canDropOnFolder={true}
				canReorderItems={true}
				defaultInteractionMode={InteractionMode.ClickArrowToExpand}
				renderRenameInput={({ item, inputProps, inputRef, formProps }) => (
					<TreeRenameInput
						item={item}
						inputProps={inputProps}
						inputRef={inputRef}
						formProps={formProps}
						treeRef={treeRef}
					/>
				)}
				onPrimaryAction={(item, treeId) => {
					// Handle primary action (title click) - selection only, no expansion
					setSelectedDocId(item.index.toString());
					console.log(`Primary action on ${item.data.type}:`, item.data.title);
				}}
				onSelectItems={(items, treeId) => {
					// Handle selection changes from built-in selection logic
					const selectedItem = items.length > 0 ? items[0] : null;
					setSelectedDocId(selectedItem?.toString() || null);
					console.log("Selection changed:", items);
				}}
				renderItemArrow={({ item, context }) => {
					// Only render arrow for folders
					if (!item.isFolder) return null;

					return (
						<div {...context.arrowProps} className="DocsSidebarTreeArrow flex h-4 w-4 items-center justify-center">
							<TooltipIconButton
								tooltip={context.isExpanded ? "Collapse file" : "Expand file"}
								side="bottom"
								variant="ghost"
								size="icon"
								className="h-4 w-4 p-0"
							>
								{context.isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
							</TooltipIconButton>
						</div>
					);
				}}
				shouldRenderChildren={(item, context) => {
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
							const childItem = dataProvider.getAllData()[childId];
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
				}}
				viewState={{
					"docs-tree": {
						expandedItems: ["root", "getting-started", "user-guide", "api", "tutorials", "troubleshooting"],
					},
				}}
				renderItem={({ item, depth, children, title, context, arrow }) => {
					return (
						<TreeItemComponent
							item={item}
							depth={depth}
							children={children}
							title={title}
							context={context}
							arrow={arrow}
							selectedDocId={selectedDocId}
							setSelectedDocId={setSelectedDocId}
							archivedItems={archivedItems}
							setArchivedItems={setArchivedItems}
							showArchived={showArchived}
							dataProvider={dataProvider}
							treeRef={treeRef}
						/>
					);
				}}
			>
				<Tree ref={treeRef} treeId="docs-tree" rootItem="root" treeLabel="Documentation Tree" />
			</UncontrolledTreeEnvironment>
		</div>
	);
}

// Props interface for the DocsSidebar wrapper component
export interface DocsSidebar_Props extends React.ComponentProps<typeof Sidebar> {
	onClose?: (() => void) | undefined;
}

// Main sidebar wrapper component
export function DocsSidebar({ onClose, className, ...props }: DocsSidebar_Props) {
	return (
		<SidebarProvider className={cn("DocsSidebar", "flex h-full w-full")}>
			<DocsSearchContextProvider>
				<div className={cn("DocsSidebarContent-wrapper", "relative h-full w-full overflow-hidden", className)}>
					<Sidebar
						side="left"
						variant="sidebar"
						collapsible="none"
						className={cn("DocsSidebarContent-wrapper-sidebar", "h-full !border-r-0 [&>*]:!border-r-0")}
						style={{ borderRight: "none !important", width: "320px" }}
						{...props}
					>
						<DocsSidebarContent onClose={onClose} />
					</Sidebar>
				</div>
			</DocsSearchContextProvider>
		</SidebarProvider>
	);
}
