import { createContext, use } from "react";
import type { TreeDataProvider, TreeItemIndex, TreeItem, UncontrolledTreeEnvironmentProps } from "react-complex-tree";
import type { ConvexReactClient } from "convex/react";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat";
import { api } from "../../convex/_generated/api";

// Document Navigation Context for communication between sidebar and main content
export interface DocumentNavigationContextType {
	selectedDocId: string | null;
	navigateToDocument: (docId: string | null) => void;
}

export const DocumentNavigationContext = createContext<DocumentNavigationContextType | null>(null);

export const useDocumentNavigation = () => {
	const context = use(DocumentNavigationContext);
	if (!context) {
		throw new Error("useDocumentNavigation must be used within DocumentNavigationProvider");
	}
	return context;
};

// Types for document structure - react-complex-tree format
export interface DocData {
	title: string;
	type: "document" | "placeholder";
	content: string; // HTML content for the rich text editor - all documents have content
}

// New simplified tree item structure from Convex
export interface ConvexTreeItem {
	index: string;
	children: string[];
	title: string;
	content: string;
}

// Function to create tree data with placeholders for empty folders
export const createTreeDataWithPlaceholders = (): Record<TreeItemIndex, TreeItem<DocData>> => {
	// Base tree data
	const baseData: Record<TreeItemIndex, TreeItem<DocData>> = {
		root: {
			index: "root",
			isFolder: true,
			children: ["getting-started", "user-guide"],
			data: {
				title: "Documentation",
				type: "document",
				content: `<h1>Documentation</h1><p>Welcome to our docs. Find guides, API reference, and tutorials here.</p>`,
			},
			canMove: false,
			canRename: false,
		},
		"getting-started": {
			index: "getting-started",
			isFolder: true,
			children: ["introduction", "installation", "quick-start"],
			data: {
				title: "Getting Started",
				type: "document",
				content: `<h1>Getting Started</h1><p>Quick guide to get up and running. Follow the steps in order.</p>`,
			},
			canMove: true,
			canRename: true,
		},
		introduction: {
			index: "introduction",
			children: [],
			data: {
				title: "Introduction",
				type: "document",
				content: `<h1>Introduction</h1><p>Welcome to our documentation! Get started with our platform's core concepts and features.</p>`,
			},
			canMove: true,
			canRename: true,
		},
		installation: {
			index: "installation",
			children: [],
			data: {
				title: "Installation",
				type: "document",
				content: `<h1>Installation</h1><p>Quick setup guide:</p><ol><li>Install Node.js 18+</li><li>Run npm install</li><li>Start the development server</li></ol>`,
			},
			canMove: true,
			canRename: true,
		},
		"quick-start": {
			index: "quick-start",
			children: [],
			data: {
				title: "Quick Start Guide",
				type: "document",
				content: `<h1>Quick Start</h1><p>Get started in 5 minutes:</p><ol><li>Create account</li><li>Set up workspace</li><li>Create first document</li></ol>`,
			},
			canMove: true,
			canRename: true,
		},
		"user-guide": {
			index: "user-guide",
			isFolder: true,
			children: ["dashboard", "projects", "collaboration"],
			data: {
				title: "User Guide",
				type: "document",
				content: `<h1>User Guide</h1><p>Learn how to use all platform features.</p>`,
			},
			canMove: true,
			canRename: true,
		},
		dashboard: {
			index: "dashboard",
			children: [],
			data: {
				title: "Dashboard Overview",
				type: "document",
				content: `<h1>Dashboard Overview</h1><p>Your main control center with project stats, recent activity, and quick actions.</p>`,
			},
			canMove: true,
			canRename: true,
		},
		projects: {
			index: "projects",
			children: [],
			data: {
				title: "Managing Projects",
				type: "document",
				content: `<h1>Managing Projects</h1><p>Create, organize, and manage your projects. Learn about project settings, permissions, and collaboration features.</p>`,
			},
			canMove: true,
			canRename: true,
		},
		collaboration: {
			index: "collaboration",
			isFolder: true,
			children: [],
			data: {
				title: "Collaboration",
				type: "document",
				content: `<h1>Collaboration</h1><p>Work together with sharing, comments, and real-time editing.</p>`,
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
					title: "No files inside",
					type: "placeholder",
					content: "",
				},
				canMove: false,
				canRename: false,
			};
		}
	}

	// ✅ Sort all children arrays BEFORE returning
	Object.values(modifiedData).forEach((item) => {
		if (item.children && item.children.length > 0) {
			item.children = [...item.children].sort((a, b) => {
				const itemA = modifiedData[a];
				const itemB = modifiedData[b];

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
	});

	return modifiedData;
};

// Helper function to create room ID from document ID
export const createRoomId = (orgId: string, projectId: string, docId: string | null): string => {
	if (!docId) return `${orgId}:${projectId}:docs-default`;

	// Build roomId from components
	return `${orgId}:${projectId}:${docId}`;
};

// Helper function to validate if a document type should trigger navigation
export const shouldNavigateToDocument = (itemType: string): boolean => {
	return itemType === "document"; // All items are documents now, except placeholders
};

// Helper function to get document content by ID - pure Convex approach
export const getDocumentContent = (docId: string | null): string => {
	if (!docId) return `<h1>Welcome</h1><p>Select a document from the sidebar to start editing.</p>`;

	// For all documents (UUID-based), provide default content
	// The actual content will be loaded from Liveblocks/Convex
	return `<h1>Loading Document</h1><p>Document content is loading...</p>`;
};

// Custom TreeDataProvider for dynamic operations
export class NotionLikeDataProvider implements TreeDataProvider<DocData> {
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
				},
				// Client-side defaults
				isFolder: true,
				canMove: !isPlaceholder && key !== "root",
				canRename: !isPlaceholder && key !== "root",
			};
		}

		this.data = convertedData;
		this.notifyTreeChange(Object.keys(convertedData));
	}

	destroy() {
		this.treeChangeListeners = [];
	}

	async getTreeItem(itemId: TreeItemIndex): Promise<TreeItem<DocData>> {
		const item = this.data[itemId];
		if (!item) {
			throw new Error(`Item ${itemId} not found`);
		}

		// ✅ CORRECT: Return data as-is, no filtering in getTreeItem
		return item;
	}

	// ✅ Accept children from library, then sort them before storing
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
					.mutation(api.ai_docs_temp.ai_docs_temp_move_items, {
						item_ids: newChildren.map((id) => id.toString()),
						target_parent_id: itemId.toString(),
						workspace_id: this.workspaceId,
						project_id: this.projectId,
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

	// ✅ Re-sort parent after rename (title affects alphabetical order)
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
				await this.convex.mutation(api.ai_docs_temp.ai_docs_temp_rename_document, {
					doc_id: item.index.toString(),
					title: name,
				});
			} catch (error) {
				console.error("Failed to rename in Convex:", error);
			}
		}
	}

	// Custom methods for Notion-like operations
	createNewItem(parentId: string, title: string = "Untitled", type: "document" = "document"): string {
		// Generate doc_id
		const doc_id = `doc-${crypto.randomUUID()}`;
		const parentItem = this.data[parentId];

		console.log("createNewItem called:", { parentId, doc_id, parentChildren: parentItem?.children });

		if (parentItem) {
			// Create new item using doc_id as index
			const newItem: TreeItem<DocData> = {
				index: doc_id,
				children: [],
				data: {
					title,
					type: "document",
					content: `<h1>${title}</h1><p>Start writing your content here...</p>`,
				},
				canMove: true,
				canRename: true,
				isFolder: true,
			};

			this.data[doc_id] = newItem;

			// Check if parent has a placeholder that needs to be replaced
			const placeholderId = `${parentId}-placeholder`;
			const hasPlaceholder = this.data[placeholderId] && parentItem.children?.includes(placeholderId);

			let updatedChildren: TreeItemIndex[];
			if (hasPlaceholder) {
				// Replace placeholder with new item
				updatedChildren = parentItem.children?.map((id) => (id === placeholderId ? doc_id : id)) || [doc_id];
				delete this.data[placeholderId];
				console.log("Replaced placeholder with new item");
			} else {
				// Just add the new item to existing children
				updatedChildren = [...(parentItem.children || []), doc_id];
				console.log("Added new item to existing children");
			}

			// Update parent with new children array
			const updatedParent = {
				...parentItem,
				children: updatedChildren,
				isFolder: true,
			};

			this.data[parentId] = updatedParent;

			this.notifyTreeChange([parentId, doc_id]);
		}

		// Sync to Convex
		if (this.convex) {
			this.convex
				.mutation(api.ai_docs_temp.ai_docs_temp_create_document, {
					parent_id: parentId,
					title,
					workspace_id: this.workspaceId,
					project_id: this.projectId,
				})
				.then((result) => {
					console.log("Document created in Convex:", result.doc_id);
				})
				.catch(console.error);
		}

		return doc_id;
	}

	// Helper methods for sorting
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

	// Get all tree data (for debugging)
	getAllData(): Record<TreeItemIndex, TreeItem<DocData>> {
		return { ...this.data };
	}
}

export type docs_TypedUncontrolledTreeEnvironmentProps = UncontrolledTreeEnvironmentProps<DocData>;
