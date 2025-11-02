import type { pages_TreeItem } from "../convex/ai_docs_temp.ts";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { TextAlign } from "@tiptap/extension-text-align";
import { Typography } from "@tiptap/extension-typography";
import { TextStyle } from "@tiptap/extension-text-style";
import { Underline } from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import { HorizontalRule } from "novel";

export const pages_ROOT_ID = "root";
export const pages_FIRST_VERSION = 1;
export const pages_YJS_DOC_KEYS = {
	richText: "default",
	plainText: "markdown",
};

export type { pages_TreeItem };

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

export function ai_docs_create_liveblocks_room_id(workspaceId: string, projectId: string, pageId: string): string {
	return `${workspaceId}:${projectId}:${pageId}`;
}

/**
 * Server-safe Tiptap extensions (no DOM, no React).
 *
 * Shared with client and server code.
 */
export const pages_get_tiptap_shared_extensions = ((/* iife */) => {
	function value() {
		return {
			starterKit: StarterKit.configure({
				// The Liveblocks extension comes with its own history handling
				undoRedo: false,
				underline: false,
				dropcursor: false, // DOM-only, disabled for server
				gapcursor: false,

				horizontalRule: false,
			}),
			taskList: TaskList.configure({
				HTMLAttributes: {
					class: "not-prose pl-2",
				},
			}),
			taskItem: TaskItem.configure({
				HTMLAttributes: {
					class: "flex gap-2 items-start my-4",
				},
				nested: true,
			}),
			textAlign: TextAlign,
			typography: Typography,
			markdown: Markdown.configure({
				markedOptions: {
					gfm: true,
					breaks: false,
				},
			}),
			highlight: Highlight.extend({
				renderMarkdown: (node, helpers, ctx) => {
					const color = node.attrs?.color;

					if (!color) {
						// Default to markdown syntax
						return `==${helpers.renderChildren(node.content || [])}==`;
					}

					const content = helpers.renderChildren(node.content || []);
					return `<mark style="background-color: ${color}">${content}</mark>`;
				},
			}).configure({
				multicolor: true,
			}),
			textStyle: TextStyle.extend({
				renderMarkdown: (node, helpers, ctx) => {
					const color = node.attrs?.color;

					if (!color) {
						return helpers.renderChildren(node.content || []);
					}

					const content = helpers.renderChildren(node.content || []);
					return `<span style="color: ${color}">${content}</span>`;
				},
			}),
			underline: Underline.extend({
				renderMarkdown: (node, helpers, ctx) => {
					// Return HTML <u> tag to preserve underline formatting
					const content = helpers.renderChildren(node.content || []);
					return `<u>${content}</u>`;
				},
			}),
			horizontalRule: HorizontalRule.configure({
				HTMLAttributes: {
					class: "mt-4 mb-6 border-t border-muted-foreground",
				},
			}),
		};
	}

	let cache: ReturnType<typeof value>;

	return function pages_get_tiptap_shared_extensions() {
		return (cache ??= value());
	};
})();
