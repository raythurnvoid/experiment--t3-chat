import "./docs-sidebar-v2.css";
import * as React from "react";
import { FileText, Plus, Search, X, Archive, Edit2, ChevronRight, ChevronDown } from "lucide-react";
import { Sidebar, SidebarContent, SidebarHeader, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState, createContext, use, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { useThemeContext } from "@/components/theme-provider";
import { TooltipIconButton } from "./assistant-ui/tooltip-icon-button";
import {
	UncontrolledTreeEnvironment,
	Tree,
	InteractionMode,
	type TreeRef,
	type TreeItemRenderContext,
	type TreeItem,
} from "react-complex-tree";
import {
	useDocumentNavigation,
	shouldNavigateToDocument,
	createTreeDataWithPlaceholders,
	NotionLikeDataProvider,
	type DocData,
} from "@/stores/docs-store";

// Search Context
interface DocsSearchContext {
	searchQuery: string;
	archivedItems: Set<string>;
	showArchived: boolean;
	dataProviderRef: React.RefObject<NotionLikeDataProvider | null>;
	treeRef: React.RefObject<TreeRef | null>;
	setSearchQuery: (query: string) => void;
	setShowArchived: (show: boolean) => void;
	setArchivedItems: (items: Set<string>) => void;
}

const DocsSearchContext = createContext<DocsSearchContext | null>(null);

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
	const [showArchived, setShowArchived] = useState(false);
	const [archivedItems, setArchivedItems] = useState<Set<string>>(new Set());
	const dataProviderRef = useRef<NotionLikeDataProvider | null>(null);
	const treeRef = useRef<TreeRef | null>(null);

	return (
		<DocsSearchContext.Provider
			value={{
				searchQuery,
				setSearchQuery,
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
	const { searchQuery, setSearchQuery, showArchived, setShowArchived, archivedItems, dataProviderRef } =
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

// Tree Item Component - extracted to properly use hooks
interface TreeItemComponent_Props {
	item: TreeItem<DocData>;
	depth: number;
	children: React.ReactNode;
	title: React.ReactNode;
	context: TreeItemRenderContext;
	arrow: React.ReactNode;
	selectedDocId: string | null;
	archivedItems: Set<string>;
	showArchived: boolean;
	onAdd: (parentId: string) => void;
	onArchive: (itemId: string) => void;
	onUnarchive: (itemId: string) => void;
}

function TreeItemComponent({
	item,
	depth,
	children,
	title,
	context,
	arrow,
	selectedDocId,
	archivedItems,
	showArchived,
	onAdd,
	onArchive,
	onUnarchive,
}: TreeItemComponent_Props) {
	const triggerId = React.useId(); // Now properly used in a component
	const data = item.data as DocData;
	const isSelected = selectedDocId === item.index;
	const isPlaceholder = data.type === "placeholder";
	const isArchived = archivedItems.has(item.index.toString());

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

	// Regular items
	return (
		<li {...context.itemContainerWithChildrenProps} className="group relative">
			{/* Label wrapper that forwards clicks to the main selection trigger */}
			<label
				className={cn(
					"DocsSidebarTreeItem-container",
					"block w-full cursor-pointer rounded-md hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
					isSelected && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
					isArchived && "line-through opacity-60",
					"group-[.TreeContainer-focused]/tree-container:has-[.TreeItemComponent-button:focus]:outline-3",
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
							className={cn(
								"TreeItemComponent-button",
								"flex flex-1 items-center gap-2 truncate border-none bg-transparent p-0 text-left text-sm outline-none",
							)}
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
							onAdd(item.index.toString());
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
									onUnarchive(item.index.toString());
								} else {
									onArchive(item.index.toString());
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

interface TreeRenameInput_Props {
	inputProps: React.InputHTMLAttributes<HTMLInputElement>;
	inputRef: React.RefObject<HTMLInputElement | null>;
	formProps: React.FormHTMLAttributes<HTMLFormElement>;
	treeRef: React.RefObject<TreeRef | null>;
}

function TreeRenameInput({ inputProps, inputRef, formProps }: TreeRenameInput_Props) {
	// Override native
	const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
		e.target.form?.requestSubmit();
	};

	return (
		<form {...formProps} className="flex w-full">
			<Input {...inputProps} ref={inputRef} className="flex-1" autoFocus onBlur={handleBlur} />
		</form>
	);
}

// Separate component to use the theme context
function TreeContainer() {
	const { searchQuery, archivedItems, setArchivedItems, showArchived, dataProviderRef, treeRef } =
		useDocsSearchContext();

	// Get document navigation from parent context
	const { selectedDocId, navigateToDocument } = useDocumentNavigation();
	const { resolved_theme } = useThemeContext();
	const isDarkMode = resolved_theme === "dark";

	// Create custom data provider (stable instance)
	const dataProvider = useMemo(() => {
		const provider = new NotionLikeDataProvider(createTreeDataWithPlaceholders());
		dataProviderRef.current = provider; // Store in ref for access from other components
		return provider;
	}, []); // Empty dependency array - provider should only be created once

	const expandToPath = async (path: string[]) => {
		// Expand the full path to show a deeply nested item
		await treeRef.current?.expandSubsequently(path);
		// Then select the final item
		const finalItem = path[path.length - 1];
		treeRef.current?.selectItems([finalItem]);
		navigateToDocument(finalItem);
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
		// First, expand the parent item if it's not already expanded
		treeRef.current?.expandItem(parentId);

		const newItemId = dataProvider.createNewItem(parentId, "Untitled", "document");
		console.log("Created new item:", newItemId, "in parent:", parentId);

		// Enhanced UX: Auto-select, focus, and start renaming the new item
		navigateToDocument(newItemId);

		// Use setTimeout to ensure the item is rendered before we interact with it
		setTimeout(() => {
			treeRef.current?.selectItems([newItemId]);
			treeRef.current?.focusItem(newItemId, true);
			treeRef.current?.startRenamingItem(newItemId);
		}, 50);
	};

	const handleArchive = (itemId: string) => {
		const newArchivedSet = new Set(archivedItems);
		newArchivedSet.add(itemId);
		setArchivedItems(newArchivedSet);
		console.log("Archived item:", itemId);

		// If we archived the currently selected item, clear selection
		if (selectedDocId === itemId) {
			navigateToDocument(null);
		}
	};

	const handleUnarchive = (itemId: string) => {
		const newArchivedSet = new Set(archivedItems);
		newArchivedSet.delete(itemId);
		setArchivedItems(newArchivedSet);
		console.log("Unarchived item:", itemId);
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
				renderRenameInput={({ inputProps, inputRef, formProps }) => (
					<TreeRenameInput inputProps={inputProps} inputRef={inputRef as any} formProps={formProps} treeRef={treeRef} />
				)}
				onPrimaryAction={(item, treeId) => {
					// Handle primary action (title click) - selection only, no expansion
					// Skip navigation for placeholder and folder items
					if (shouldNavigateToDocument(item.data.type)) {
						navigateToDocument(item.index.toString());
					}
					console.log(`Primary action on ${item.data.type}:`, item.data.title);
				}}
				onSelectItems={(items, treeId) => {
					// Handle selection changes from built-in selection logic
					const selectedItem = items.length > 0 ? items[0] : null;
					const selectedItemId = selectedItem?.toString() || null;

					// Only navigate for document items, not folders or placeholders
					if (selectedItemId) {
						const provider = dataProviderRef.current;
						if (provider) {
							const allData = provider.getAllData();
							const itemData = allData[selectedItemId];
							if (itemData && shouldNavigateToDocument(itemData.data.type)) {
								navigateToDocument(selectedItemId);
							}
						}
					}
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
								className="h-4 w-4 p-0 text-muted-foreground hover:text-foreground"
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
							archivedItems={archivedItems}
							onAdd={handleAddChild}
							onArchive={handleArchive}
							onUnarchive={handleUnarchive}
							showArchived={showArchived}
						/>
					);
				}}
				renderTreeContainer={({ children, containerProps, info }) => {
					return (
						<div
							{...containerProps}
							className={cn("TreeContainer", info.isFocused && "TreeContainer-focused", "group/tree-container")}
						>
							{children}
						</div>
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
