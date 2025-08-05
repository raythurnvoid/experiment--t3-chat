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
import { Sidebar, SidebarContent, SidebarHeader, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn, sx } from "@/lib/utils";
import { IconButton } from "@/components/icon-button";
import {
	UncontrolledTreeEnvironment,
	Tree,
	InteractionMode,
	type TreeRef,
	type TreeItemRenderContext,
	type TreeItem,
	type TreeInformation,
} from "react-complex-tree";
import {
	NotionLikeDataProvider,
	type DocData,
	type docs_TypedUncontrolledTreeEnvironmentProps,
} from "@/stores/docs-store";
import { useConvex, useQuery, useMutation } from "convex/react";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat";
import { api } from "../../convex/_generated/api";

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

// Search Context
type DocsSearchContext = {
	searchQuery: string;
	archivedItems: Set<string>;
	showArchived: boolean;
	dataProviderRef: React.RefObject<NotionLikeDataProvider | null>;
	setSearchQuery: (query: string) => void;
	setShowArchived: (show: boolean) => void;
	setArchivedItems: (items: Set<string>) => void;
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
	const [archivedItems, setArchivedItems] = useState<Set<string>>(new Set());
	const dataProviderRef = useRef<NotionLikeDataProvider | null>(null);

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
	archivedItems: Set<string>;
	showArchived: boolean;
	onAdd: (parentId: string) => void;
	onArchive: (itemId: string) => void;
	onUnarchive: (itemId: string) => void;
};

function TreeItem(props: TreeItem_Props) {
	const {
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
	} = props;

	const data = item.data as DocData;

	// Current selected document
	const isNavigated = selectedDocId === item.index;
	const isPlaceholder = data.type === "placeholder";
	const isArchived = archivedItems.has(item.index.toString());
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

	const { searchQuery, archivedItems, setArchivedItems, showArchived, dataProviderRef } = useDocsSearchContext();

	const convex = useConvex();

	const treeData = useQuery(api.ai_docs_temp.ai_docs_temp_get_document_tree, {
		workspace_id: ai_chat_HARDCODED_ORG_ID,
		project_id: ai_chat_HARDCODED_PROJECT_ID,
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
		if (!dataProviderRef.current) {
			dataProviderRef.current = provider; // Store in ref for access from other components
		}
		return provider;
	}, []);

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

	// Get expanded items for view state
	const expandedItems = useMemo(() => {
		if (!dataProvider) return [];
		const allData = dataProvider.getAllData();
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
	}, [dataProvider, searchQuery]); // Re-calculate when search query changes

	const rootElement = useRef<HTMLDivElement>(null);

	const [isDraggingOverRootArea, setIsDraggingOverRootArea] = useState(false);

	const archiveDocument = useMutation(api.ai_docs_temp.ai_docs_temp_archive_document);

	const handleAddChild = (parentId: string) => {
		if (dataProviderRef.current) {
			const newItemId = dataProviderRef.current.createNewItem(parentId, "New Document", "document");
			console.log("Created new document:", newItemId);
			onAddChild(parentId, newItemId);
		}
	};

	const handleArchive = (itemId: string) => {
		const newArchivedSet = new Set(archivedItems);
		newArchivedSet.add(itemId);
		setArchivedItems(newArchivedSet);
		console.log("Archived item:", itemId);

		// Sync to Convex
		if (convex) {
			archiveDocument({
				doc_id: itemId,
				is_archived: true,
			}).catch(console.error);
		}

		onArchive(itemId);
	};

	const handleUnarchive = (itemId: string) => {
		const newArchivedSet = new Set(archivedItems);
		newArchivedSet.delete(itemId);
		setArchivedItems(newArchivedSet);
		console.log("Unarchived item:", itemId);

		// Sync to Convex
		if (convex) {
			archiveDocument({
				doc_id: itemId,
				is_archived: false,
			}).catch(console.error);
		}
	};

	const handlePrimaryAction: docs_TypedUncontrolledTreeEnvironmentProps["onPrimaryAction"] = (item, treeId) => {
		if (item.data.type === "document") {
			onPrimaryAction(item.index.toString(), item.data.type);
		}
	};

	const handleShouldRenderChildren: docs_TypedUncontrolledTreeEnvironmentProps["shouldRenderChildren"] = (
		item,
		context,
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

			if (!draggingItems || draggingItems.length === 0 || !dataProviderRef.current) {
				console.log("No dragging items found or no data provider");
				return;
			}

			try {
				const provider = dataProviderRef.current;
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
							archivedItems={archivedItems}
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

	const {
		searchQuery,
		setSearchQuery,
		showArchived,
		setShowArchived,
		archivedItems,
		setArchivedItems,
		dataProviderRef,
	} = useDocsSearchContext();

	const treeRef = useRef<TreeRef | null>(null);

	const [multiSelectionCount, setMultiSelectionCount] = useState(0);
	const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);

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
		if (dataProviderRef.current) {
			const newItemId = dataProviderRef.current.createNewItem(ROOT_TREE_ID, "New Document", "document");
			console.log("Created new document from header button:", newItemId);
		}
	};

	const handleClearSelection = () => {
		// Clear all tree selections
		treeRef.current?.selectItems([]);
	};

	const handleArchiveAll = () => {
		// Archive all selected items
		const newArchivedSet = new Set(archivedItems);

		selectedItemIds.forEach((itemId: string) => {
			newArchivedSet.add(itemId);
		});

		setArchivedItems(newArchivedSet);

		handleClearSelection();
	};

	const handleSelectItems: TreeArea_Props["onSelectItems"] = (items, treeId) => {
		setMultiSelectionCount(items.length);
		setSelectedItemIds(items.map((item) => item.toString()));
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
			</DocsSearchContextProvider>
		</SidebarProvider>
	);
}
