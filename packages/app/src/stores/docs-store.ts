import type { TreeDataProvider, TreeItemIndex, TreeItem, UncontrolledTreeEnvironmentProps } from "react-complex-tree";
import type { ConvexReactClient } from "convex/react";
import { ai_chat_HARDCODED_ORG_ID, ai_chat_HARDCODED_PROJECT_ID } from "@/lib/ai-chat";
import { api } from "../../convex/_generated/api";
import { generate_timestamp_uuid } from "../lib/utils.ts";

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
		const doc_id = generate_timestamp_uuid("doc");
		const parentItem = this.data[parentId];

		console.log("createNewItem called:", { parentId, doc_id, parentChildren: parentItem?.children });

		if (parentItem) {
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
