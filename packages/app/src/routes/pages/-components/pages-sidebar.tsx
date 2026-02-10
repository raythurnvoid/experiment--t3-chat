import "./pages-sidebar.css";
import React, { useEffect, useRef, useState } from "react";
import {
	Archive,
	ArchiveRestore,
	ChevronDown,
	ChevronRight,
	ChevronsDown,
	ChevronsUp,
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
	type ItemInstance,
} from "@headless-tree/core";
import { AssistiveTreeDescription, useTree } from "@headless-tree/react";
import { useNavigate } from "@tanstack/react-router";
import { MySidebar, MySidebarContent, MySidebarHeader, type MySidebar_Props } from "@/components/my-sidebar.tsx";
import { MainAppSidebar } from "@/components/main-app-sidebar.tsx";
import { MyInput, MyInputArea, MyInputBox, MyInputControl, MyInputIcon } from "@/components/my-input.tsx";
import { MyButton, MyButtonIcon } from "@/components/my-button.tsx";
import { MyIconButton, MyIconButtonIcon } from "@/components/my-icon-button.tsx";
import { MyIcon } from "@/components/my-icon.tsx";
import { MyLink } from "@/components/my-link.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import {
	ai_chat_HARDCODED_ORG_ID,
	ai_chat_HARDCODED_PROJECT_ID,
	cn,
	sx,
} from "@/lib/utils.ts";
import { app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";
import { useAppGlobalStore } from "@/lib/app-global-store.ts";
import {
	pages_ROOT_ID,
	pages_create_tree_placeholder_child,
	type pages_EditorView,
	type pages_TreeItem,
} from "@/lib/pages.ts";
import { format_relative_time } from "@/lib/date.ts";

// #region css contracts
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

type PagesSidebarTreeArea_ClassNames =
	| "PagesSidebarTreeArea"
	| "PagesSidebarTreeArea-drag-over"
	| "PagesSidebarTreeArea-empty-state"
	| "PagesSidebarTreeArea-container"
	| "PagesSidebarTreeArea-container-focused"
	| "PagesSidebarTreeArea-container-dragging"
	| "PagesSidebar-tree-drag-between-line";

type PagesSidebarTreeItem_ClassNames =
	| "PagesSidebarTreeItem"
	| "PagesSidebarTreeItem-content"
	| "PagesSidebarTreeItem-content-navigated"
	| "PagesSidebarTreeItem-content-selected"
	| "PagesSidebarTreeItem-content-focused"
	| "PagesSidebarTreeItem-content-dragging-over"
	| "PagesSidebarTreeItem-content-archived"
	| "PagesSidebarTreeItem-content-placeholder"
	| "PagesSidebarTreeItem-primary-action-interactive-area"
	| "PagesSidebarTreeItem-meta-label"
	| "PagesSidebarTreeItem-meta-label-text"
	| "PagesSidebarTreeItem-actions";

type PagesSidebarTreeItemActionIconButton_ClassNames = "PagesSidebarTreeItemActionIconButton";
type PagesSidebarTreeItemArrow_ClassNames = "PagesSidebarTreeItemArrow";
type PagesSidebarTreeItemPrimaryActionContent_ClassNames = "PagesSidebarTreeItemPrimaryActionContent";
type PagesSidebarTreeItemIcon_ClassNames = "PagesSidebarTreeItemIcon";
type PagesSidebarTreeRenameInput_ClassNames = "PagesSidebarTreeRenameInput" | "PagesSidebarTreeRenameInput-input";

type PagesSidebar_CssVars = {
	"--PagesSidebarTreeItem-content-depth": number;
};

type PagesSidebar_CollectionItem = {
	index: string;
	data: pages_TreeItem;
	children: string[];
};

type PagesSidebar_Collection = Record<string, PagesSidebar_CollectionItem>;
// #endregion css contracts

// #region helpers
function pages_sidebar_to_page_id(pageId: string) {
	return pageId as app_convex_Id<"pages">;
}

function pages_sidebar_to_parent_id(parentId: string) {
	return (parentId === pages_ROOT_ID ? pages_ROOT_ID : pages_sidebar_to_page_id(parentId)) as
		| app_convex_Id<"pages">
		| typeof pages_ROOT_ID;
}

function pages_sidebar_sort_children(args: {
	children: string[];
	collection: PagesSidebar_Collection;
}) {
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

function pages_sidebar_build_collection(args: {
	treeItemsList: pages_TreeItem[] | undefined;
	showArchived: boolean;
}) {
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

		current.children = pages_sidebar_sort_children({
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

	for (let index = 0; index < left.length; index += 1) {
		const leftValue = left[index];
		const rightValue = right[index];
		if (!leftValue || !rightValue) {
			return false;
		}
		if (leftValue.index !== rightValue.index) {
			return false;
		}
		if (leftValue.parentId !== rightValue.parentId) {
			return false;
		}
		if (leftValue.title !== rightValue.title) {
			return false;
		}
		if (leftValue.isArchived !== rightValue.isArchived) {
			return false;
		}
		if (leftValue.updatedAt !== rightValue.updatedAt) {
			return false;
		}
		if ((leftValue.updatedBy ?? "") !== (rightValue.updatedBy ?? "")) {
			return false;
		}
	}

	return true;
}
// #endregion helpers

// #region view atoms
function PagesSidebarTreeItemIcon() {
	return (
		<MyIcon className={"PagesSidebarTreeItemIcon" satisfies PagesSidebarTreeItemIcon_ClassNames}>
			<FileText />
		</MyIcon>
	);
}

function PagesSidebarTreeItemPrimaryActionContent(props: {
	title: React.ReactNode;
}) {
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

function PagesSidebarTreeItemActionIconButton(props: {
	children: React.ReactNode;
	tooltip: string;
	isActive: boolean;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<MyIconButton
			variant={props.isActive ? "ghost-highlightable" : "ghost"}
			className={cn("PagesSidebarTreeItemActionIconButton" satisfies PagesSidebarTreeItemActionIconButton_ClassNames)}
			tooltip={props.tooltip}
			side="bottom"
			onClick={props.onClick}
			disabled={props.disabled}
		>
			<MyIconButtonIcon>{props.children}</MyIconButtonIcon>
		</MyIconButton>
	);
}
// #endregion view atoms

// #region root
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

	// #region infrastructure
	const navigate = useNavigate();
	const { toggleSidebar } = MainAppSidebar.useSidebar();
	const homePageId = useAppGlobalStore((state) => state.pages_home_id);

	const queriedTreeItemsList = useQuery(app_convex_api.ai_docs_temp.get_tree_items_list, {
		workspaceId: ai_chat_HARDCODED_ORG_ID,
		projectId: ai_chat_HARDCODED_PROJECT_ID,
	});
	const [resolvedTreeItemsList, setResolvedTreeItemsList] = useState<typeof queriedTreeItemsList>(undefined);
	useEffect(() => {
		if (queriedTreeItemsList === undefined) {
			return;
		}
		setResolvedTreeItemsList((currentValue) => {
			if (pages_sidebar_are_tree_items_lists_equal(currentValue, queriedTreeItemsList)) {
				return currentValue;
			}
			return queriedTreeItemsList;
		});
	}, [queriedTreeItemsList]);
	const treeItemsList = queriedTreeItemsList ?? resolvedTreeItemsList;

	const serverMovePages = useMutation(app_convex_api.ai_docs_temp.move_pages);
	const serverRenamePage = useMutation(app_convex_api.ai_docs_temp.rename_page);
	const serverCreatePage = useMutation(app_convex_api.ai_docs_temp.create_page);
	const serverArchivePage = useMutation(app_convex_api.ai_docs_temp.archive_pages);
	const serverUnarchivePage = useMutation(app_convex_api.ai_docs_temp.unarchive_pages);
	// #endregion infrastructure

	// #region local state
	const [searchQuery, setSearchQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const [isCreatingPage, setIsCreatingPage] = useState(false);
	const [isArchivingSelection, setIsArchivingSelection] = useState(false);
	const [isTreeFocused, setIsTreeFocused] = useState(false);
	const [isDraggingOverRootArea, setIsDraggingOverRootArea] = useState(false);
	const [pendingRenamePageId, setPendingRenamePageId] = useState<string | null>(null);
	const [pendingActionPageIds, setPendingActionPageIds] = useState<Set<string>>(new Set());

	const rootElement = useRef<HTMLDivElement>(null);
	// #endregion local state

	// #region derived tree model
	const baseTreeCollection = ((/* iife */) => {
		return pages_sidebar_build_collection({
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
		!showArchived &&
		archivedCount > 0 &&
		(baseTreeCollection[pages_ROOT_ID]?.children.length ?? 0) === 0;

	const treeCollection = ((/* iife */) => {
		if (!shouldForceShowArchived) {
			return baseTreeCollection;
		}

		return pages_sidebar_build_collection({
			treeItemsList,
			showArchived: true,
		});
	})();

	const isArchivedShown = showArchived || shouldForceShowArchived;

	const dataLoader = {
		getItem: (itemId: string) =>
			treeCollection[itemId]?.data ?? pages_create_tree_placeholder_child(itemId.replace("-placeholder", "")),
		getChildren: (itemId: string) => treeCollection[itemId]?.children ?? [],
	};
	// #endregion derived tree model

	// #region mutations helpers
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

	const movePagesToParent = (args: {
		pageIds: string[];
		targetParentId: string;
	}) => {
		const movedPageIds = args.pageIds.filter((pageId) => treeCollection[pageId]?.data.type === "page");
		if (movedPageIds.length === 0) {
			return Promise.resolve();
		}

		return serverMovePages({
			itemIds: movedPageIds.map((itemId) => pages_sidebar_to_page_id(itemId)),
			targetParentId: pages_sidebar_to_parent_id(args.targetParentId),
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
		});
	};
	// #endregion mutations helpers

	// #region headless tree
	const tree = useTree<pages_TreeItem>({
		rootItemId: pages_ROOT_ID,
		initialState: {
			expandedItems: [pages_ROOT_ID],
		},
		getItemName: (item) => item.getItemData().title,
		isItemFolder: (item) => item.getItemData().type !== "placeholder",
		canReorder: true,
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
			serverRenamePage({
				workspaceId: ai_chat_HARDCODED_ORG_ID,
				projectId: ai_chat_HARDCODED_PROJECT_ID,
				pageId: pages_sidebar_to_page_id(item.getId()),
				name: trimmedValue,
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
		dataLoader,
		features: [
			syncDataLoaderFeature,
			selectionFeature,
			hotkeysCoreFeature,
			dragAndDropFeature,
			renamingFeature,
			expandAllFeature,
		],
	});

	const hasSelectedPageInTree = !!(selectedPageId && treeCollection[selectedPageId]);
	const hasPendingRenamePageInTree = !!(pendingRenamePageId && treeCollection[pendingRenamePageId]);

	useEffect(() => {
		if (!selectedPageId || !hasSelectedPageInTree) {
			return;
		}
		tree.getItemInstance(selectedPageId).setFocused();
	}, [hasSelectedPageInTree, selectedPageId, tree]);

	useEffect(() => {
		if (!pendingRenamePageId || !hasPendingRenamePageInTree) {
			return;
		}
		tree.getItemInstance(pendingRenamePageId).startRenaming();
		setPendingRenamePageId(null);
	}, [hasPendingRenamePageInTree, pendingRenamePageId, tree]);

	tree.scheduleRebuildTree();
	const treeItems = tree.getItems();
	// #endregion headless tree

	// #region view model
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
	const renderedTreeItems = treeItems.filter((item) => {
		const itemId = item.getId();
		if (itemId === pages_ROOT_ID) {
			return false;
		}
		if (visibleIds && !visibleIds.has(itemId)) {
			return false;
		}
		return true;
	});
	const showEmptyState = !isTreeLoading && renderedTreeItems.length === 0;
	// #endregion view model

	// #region handlers
	const createPage = (parentPageId: string) => {
		setIsCreatingPage(true);
		serverCreatePage({
			parentId: pages_sidebar_to_parent_id(parentPageId),
			name: "New Page",
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
		})
			.then((result) => {
				setPendingRenamePageId(result.pageId);
				return navigate({
					to: "/pages",
					search: { pageId: result.pageId, view },
				});
			})
			.catch(console.error)
			.finally(() => {
				setIsCreatingPage(false);
			});
	};

	const handleArchive = (pageId: string) => {
		markPageAsPending(pageId);
		serverArchivePage({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId: pages_sidebar_to_page_id(pageId),
		})
			.then(() => {
				onArchive(pageId);
			})
			.catch(console.error)
			.finally(() => {
				unmarkPageAsPending(pageId);
			});
	};

	const handleUnarchive = (pageId: string) => {
		markPageAsPending(pageId);
		serverUnarchivePage({
			workspaceId: ai_chat_HARDCODED_ORG_ID,
			projectId: ai_chat_HARDCODED_PROJECT_ID,
			pageId: pages_sidebar_to_page_id(pageId),
		})
			.catch(console.error)
			.finally(() => {
				unmarkPageAsPending(pageId);
			});
	};

	const handleArchiveAll = () => {
		const selectedIds = selectedPageIds;
		if (selectedIds.length === 0) {
			return;
		}

		setIsArchivingSelection(true);
		Promise.all(
			selectedIds.map((pageId) =>
				serverArchivePage({
					workspaceId: ai_chat_HARDCODED_ORG_ID,
					projectId: ai_chat_HARDCODED_PROJECT_ID,
					pageId: pages_sidebar_to_page_id(pageId),
				}),
			),
		)
			.then(() => {
				if (selectedPageId && selectedIds.includes(selectedPageId)) {
					onArchive(selectedPageId);
				}
			})
			.catch(console.error)
			.finally(() => {
				tree.setSelectedItems([]);
				setIsArchivingSelection(false);
			});
	};

	const handleDragOverRootArea = (event: React.DragEvent<HTMLDivElement>) => {
		if (event.target !== rootElement.current) {
			return;
		}

		const draggedItems = tree.getState().dnd?.draggedItems ?? [];
		if (draggedItems.length === 0) {
			return;
		}

		event.preventDefault();
		setIsDraggingOverRootArea(true);
	};

	const handleDropOnRootArea = (event: React.DragEvent<HTMLDivElement>) => {
		setIsDraggingOverRootArea(false);
		if (event.target !== rootElement.current) {
			return;
		}

		event.preventDefault();
		const draggedItems = tree.getState().dnd?.draggedItems ?? [];
		if (draggedItems.length === 0) {
			return;
		}

		movePagesToParent({
			pageIds: draggedItems.map((item) => item.getId()),
			targetParentId: pages_ROOT_ID,
		}).catch(console.error);
	};

	const handleTreeItemPrimaryClick = (event: React.MouseEvent<HTMLButtonElement>, item: ItemInstance<pages_TreeItem>) => {
		const itemId = item.getId();
		const isModifierClick = event.shiftKey || event.ctrlKey || event.metaKey;

		if (event.shiftKey) {
			item.selectUpTo(event.ctrlKey || event.metaKey);
		} else if (event.ctrlKey || event.metaKey) {
			item.toggleSelect();
		} else {
			tree.setSelectedItems([itemId]);
		}

		if (!event.shiftKey) {
			const dataRef = tree.getDataRef() as { current: { selectUpToAnchorId?: string } };
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
	// #endregion handlers

	// #region render
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
							<MyInputControl placeholder="Search pages" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
						</MyInputArea>
					</MyInput>

					<div className={cn("PagesSidebar-actions" satisfies PagesSidebar_ClassNames)}>
						<div className={cn("PagesSidebar-actions-group" satisfies PagesSidebar_ClassNames)}>
							<MyIconButton
								className={cn("PagesSidebar-actions-icon-button" satisfies PagesSidebar_ClassNames)}
								variant="secondary-subtle"
								tooltip="Unfold"
								onClick={() => tree.expandAll().catch(console.error)}
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
								onClick={() => tree.collapseAll()}
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
										tooltip="Archive all"
										onClick={handleArchiveAll}
										disabled={isBusy}
									>
										<MyIconButtonIcon>
											<ArchiveRestore />
										</MyIconButtonIcon>
									</MyIconButton>
									<MyIconButton
										className={cn("PagesSidebar-actions-icon-button" satisfies PagesSidebar_ClassNames)}
										variant="secondary"
										tooltip="Clear"
										onClick={() => tree.setSelectedItems([])}
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
								onClick={() => createPage(pages_ROOT_ID)}
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
					<div
						ref={rootElement}
						className={cn(
							"PagesSidebarTreeArea" satisfies PagesSidebarTreeArea_ClassNames,
							isDraggingOverRootArea && ("PagesSidebarTreeArea-drag-over" satisfies PagesSidebarTreeArea_ClassNames),
						)}
						onDragOver={handleDragOverRootArea}
						onDragLeave={(event) => {
							if (event.target === rootElement.current) {
								setIsDraggingOverRootArea(false);
							}
						}}
						onDragEnd={() => setIsDraggingOverRootArea(false)}
						onDrop={handleDropOnRootArea}
					>
						<div
							{...tree.getContainerProps("Pages")}
							className={cn(
								"PagesSidebarTreeArea-container" satisfies PagesSidebarTreeArea_ClassNames,
								isTreeFocused && ("PagesSidebarTreeArea-container-focused" satisfies PagesSidebarTreeArea_ClassNames),
								(tree.getState().dnd?.draggedItems?.length ?? 0) > 0 &&
									("PagesSidebarTreeArea-container-dragging" satisfies PagesSidebarTreeArea_ClassNames),
							)}
							onFocus={() => setIsTreeFocused(true)}
							onBlur={(event) => {
								const relatedTarget = event.relatedTarget as HTMLElement | null;
								if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) {
									setIsTreeFocused(false);
									tree.setSelectedItems([]);
								}
							}}
							onKeyDown={(event) => {
								if (event.key !== "F2") {
									return;
								}

								const focusedItem = tree.getFocusedItem();
								if (focusedItem.getItemData().type !== "page") {
									return;
								}

								event.preventDefault();
								focusedItem.startRenaming();
							}}
						>
							<AssistiveTreeDescription tree={tree} />

							{isTreeLoading ? (
								<div className={cn("PagesSidebarTreeArea-empty-state" satisfies PagesSidebarTreeArea_ClassNames)}>
									Loading pages...
								</div>
							) : showEmptyState ? (
								<div className={cn("PagesSidebarTreeArea-empty-state" satisfies PagesSidebarTreeArea_ClassNames)}>
									{searchQuery.trim() ? "No pages match your search." : "No pages yet."}
								</div>
							) : (
								renderedTreeItems.map((item) => {
									const itemId = item.getId();
									const itemData = item.getItemData();
									const isPlaceholder = itemData.type === "placeholder";
									const isArchived = itemData.isArchived;
									const isNavigated = selectedPageId === itemId;
									const isPending = isBusy || pendingActionPageIds.has(itemId);
									const depth = item.getItemMeta().level;
									const isDragging = !!tree
										.getState()
										.dnd?.draggedItems?.some((draggedItem: ItemInstance<pages_TreeItem>) => draggedItem.getId() === itemId);

									const metaText = isPlaceholder
										? ""
										: `${format_relative_time(itemData.updatedAt)} ${itemData.updatedBy || "Unknown"}`;
									const tooltipContent = isPlaceholder
										? undefined
										: `Updated ${format_relative_time(itemData.updatedAt, { prefixForDatesPast7Days: "the " })} by ${itemData.updatedBy || "Unknown"}`;

									const content = isPlaceholder ? (
										<div
											style={sx({ "--PagesSidebarTreeItem-content-depth": depth } satisfies Partial<PagesSidebar_CssVars>)}
											className={cn(
												"PagesSidebarTreeItem-content" satisfies PagesSidebarTreeItem_ClassNames,
												"PagesSidebarTreeItem-content-placeholder" satisfies PagesSidebarTreeItem_ClassNames,
											)}
										>
											<PagesSidebarTreeItemPrimaryActionContent title={itemData.title} />
										</div>
									) : (
										<div
											style={sx({ "--PagesSidebarTreeItem-content-depth": depth } satisfies Partial<PagesSidebar_CssVars>)}
											className={cn(
												"PagesSidebarTreeItem-content" satisfies PagesSidebarTreeItem_ClassNames,
												isNavigated && ("PagesSidebarTreeItem-content-navigated" satisfies PagesSidebarTreeItem_ClassNames),
												item.isSelected() &&
													("PagesSidebarTreeItem-content-selected" satisfies PagesSidebarTreeItem_ClassNames),
												item.isFocused() && ("PagesSidebarTreeItem-content-focused" satisfies PagesSidebarTreeItem_ClassNames),
												item.isDragTarget() &&
													("PagesSidebarTreeItem-content-dragging-over" satisfies PagesSidebarTreeItem_ClassNames),
												isArchived && ("PagesSidebarTreeItem-content-archived" satisfies PagesSidebarTreeItem_ClassNames),
											)}
										>
											{item.isRenaming() ? (
												<div className={"PagesSidebarTreeItem-primary-action-interactive-area" satisfies PagesSidebarTreeItem_ClassNames}>
													<div
														className={
															"PagesSidebarTreeItemPrimaryActionContent" satisfies PagesSidebarTreeItemPrimaryActionContent_ClassNames
														}
													>
														<PagesSidebarTreeItemIcon />
														<div className="PagesSidebarTreeItemPrimaryActionContent-title-container">
															<form
																className={
																	"PagesSidebarTreeRenameInput" satisfies PagesSidebarTreeRenameInput_ClassNames
																}
															>
																<MyInput>
																	<MyInputControl
																		{...item.getRenameInputProps()}
																		className={
																			"PagesSidebarTreeRenameInput-input" satisfies PagesSidebarTreeRenameInput_ClassNames
																		}
																	/>
																</MyInput>
															</form>
														</div>
													</div>
												</div>
											) : (
												<button
													{...item.getProps()}
													onClick={(event) => handleTreeItemPrimaryClick(event, item)}
													type="button"
													className={
														"PagesSidebarTreeItem-primary-action-interactive-area" satisfies PagesSidebarTreeItem_ClassNames
													}
													disabled={isPending}
												>
													<PagesSidebarTreeItemPrimaryActionContent title={itemData.title} />
												</button>
											)}

											<div className={"PagesSidebarTreeItemArrow" satisfies PagesSidebarTreeItemArrow_ClassNames}>
												{item.isFolder() ? (
													<MyIconButton
														className={"PagesSidebarTreeItemArrow" satisfies PagesSidebarTreeItemArrow_ClassNames}
														tooltip={item.isExpanded() ? "Collapse page" : "Expand page"}
														side="bottom"
														variant="ghost-highlightable"
														onClick={(event) => {
															event.preventDefault();
															event.stopPropagation();
															if (item.isExpanded()) {
																item.collapse();
															} else {
																item.expand();
															}
														}}
														disabled={isPending}
													>
														<MyIconButtonIcon>{item.isExpanded() ? <ChevronDown /> : <ChevronRight />}</MyIconButtonIcon>
													</MyIconButton>
												) : null}
											</div>

											<div className={"PagesSidebarTreeItem-meta-label" satisfies PagesSidebarTreeItem_ClassNames}>
												<div className={"PagesSidebarTreeItem-meta-label-text" satisfies PagesSidebarTreeItem_ClassNames}>
													{metaText}
												</div>
											</div>

											<div className={"PagesSidebarTreeItem-actions" satisfies PagesSidebarTreeItem_ClassNames}>
												<PagesSidebarTreeItemActionIconButton
													tooltip="Add child"
													isActive={item.isFocused()}
													onClick={() => createPage(itemId)}
													disabled={isPending}
												>
													<Plus />
												</PagesSidebarTreeItemActionIconButton>

												<PagesSidebarTreeItemActionIconButton
													tooltip="Rename"
													isActive={item.isFocused()}
													onClick={() => item.startRenaming()}
													disabled={isPending}
												>
													<Edit2 />
												</PagesSidebarTreeItemActionIconButton>

												<PagesSidebarTreeItemActionIconButton
													tooltip={isArchived ? "Restore" : "Archive"}
													isActive={item.isFocused()}
													onClick={() => {
														if (isArchived) {
															handleUnarchive(itemId);
														} else {
															handleArchive(itemId);
														}
													}}
													disabled={isPending}
												>
													{isArchived ? <ArchiveRestore /> : <Archive />}
												</PagesSidebarTreeItemActionIconButton>
											</div>
										</div>
									);

									return (
										<div key={itemId} className={cn("PagesSidebarTreeItem" satisfies PagesSidebarTreeItem_ClassNames)}>
											{tooltipContent ? (
												<Tooltip delayDuration={2000}>
													<TooltipTrigger asChild>{content}</TooltipTrigger>
													{!isDragging ? (
														<TooltipContent side="bottom" align="center">
															{tooltipContent}
														</TooltipContent>
													) : null}
												</Tooltip>
											) : (
												content
											)}
										</div>
									);
								})
							)}

							<div style={tree.getDragLineStyle()} className="PagesSidebar-tree-drag-between-line" />
						</div>
					</div>
				</MySidebarContent>
			</div>
		</MySidebar>
	);
	// #endregion render
}
// #endregion root
