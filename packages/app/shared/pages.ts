import type { pages_TreeItem, pages_TreeItems } from "../convex/ai_docs_temp.ts";

export const pages_ROOT_ID = "root";
export const pages_FIRST_VERSION = 1;

export type { pages_TreeItem, pages_TreeItems };

export function pages_create_tree_root(): pages_TreeItem {
	return {
		type: "root",
		index: pages_ROOT_ID,
		parentId: "",
		title: "",
		content: "",
		isArchived: false,
		updatedAt: 0,
		updatedBy: "",
	};
}

export function pages_create_tree_placeholder_child(itemId: string): pages_TreeItem {
	return {
		type: "placeholder",
		index: `${itemId}-placeholder`,
		parentId: itemId,
		title: "No files inside",
		content: "",
		isArchived: false,
		updatedAt: 0,
		updatedBy: "",
	};
}
