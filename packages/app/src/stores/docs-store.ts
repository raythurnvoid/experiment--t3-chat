import { createContext, use } from "react";
import type { TreeDataProvider, TreeItemIndex, TreeItem } from "react-complex-tree";

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
	id: string;
	title: string;
	url: string;
	type: "document" | "placeholder";
	content: string; // HTML content for the rich text editor - all documents have content
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
				id: "root",
				title: "Documentation",
				url: "#",
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
				id: "getting-started",
				title: "Getting Started",
				url: "#getting-started",
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
				id: "introduction",
				title: "Introduction",
				url: "#introduction",
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
				id: "installation",
				title: "Installation",
				url: "#installation",
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
				id: "quick-start",
				title: "Quick Start Guide",
				url: "#quick-start",
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
				id: "user-guide",
				title: "User Guide",
				url: "#user-guide",
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
				id: "dashboard",
				title: "Dashboard Overview",
				url: "#dashboard",
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
				id: "projects",
				title: "Managing Projects",
				url: "#projects",
				type: "document",
				content: `<h1>Managing Projects</h1><p>Create, organize, and manage your projects. Learn about project settings, permissions, and collaboration features.</p>`,
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
				type: "document",
				content: `<h1>Collaboration</h1><p>Work together with sharing, comments, and real-time editing.</p>`,
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
				content: `<h1>Sharing Documents</h1><p>Share documents with team members and external collaborators. Configure permissions and access levels.</p>`,
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
				content: `<h1>Comments & Reviews</h1><p>Add comments, suggestions, and reviews to documents. Track feedback and approve changes collaboratively.</p>`,
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
					content: "",
				},
				canMove: false,
				canRename: false,
			};
		}
	}

	return modifiedData;
};

// Helper function to create room ID from document ID
export const createRoomId = (orgId: string, projectId: string, docId: string | null): string => {
	return docId ? `${orgId}:${projectId}:${docId}` : `${orgId}:${projectId}:docs-default`;
};

// Helper function to validate if a document type should trigger navigation
export const shouldNavigateToDocument = (itemType: string): boolean => {
	return itemType === "document"; // All items are documents now, except placeholders
};

// Helper function to get document content by ID using the tree data
export const getDocumentContent = (docId: string | null): string => {
	if (!docId) return `<h1>Welcome</h1><p>Select a document from the sidebar to start editing.</p>`;

	// Get content from the tree data
	const treeData = createTreeDataWithPlaceholders();
	const item = treeData[docId];

	if (item && item.data.content) {
		return item.data.content;
	}

	// Fallback for new documents
	return `<h1>${docId}</h1><p>Start writing your content here...</p>`;
};

// Custom TreeDataProvider for dynamic operations
export class NotionLikeDataProvider implements TreeDataProvider<DocData> {
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
	createNewItem(parentId: string, title: string = "Untitled", type: "document" = "document"): string {
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
					content: `<h1>${title}</h1><p>Start writing your content here...</p>`,
				},
				canMove: true,
				canRename: true,
				isFolder: true,
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
