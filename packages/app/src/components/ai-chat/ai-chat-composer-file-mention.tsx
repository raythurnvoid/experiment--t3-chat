// The composer's "@" file mention: a suggestion popup over the workspace file
// tree plus an inline chip node. The chip serializes to plain text as
// `@<path>` (file) or `@<path>/` (folder), so the sent message stays one plain
// string and the agent's path-based tools can resolve the mention.

import "./ai-chat-composer-file-mention.css";

import type { MouseEvent, Ref } from "react";
import { memo, useEffect, useId, useImperativeHandle, useState } from "react";
import { useQuery } from "convex/react";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { PluginKey } from "@tiptap/pm/state";
import { mergeAttributes, type Editor } from "@tiptap/core";
import { posToDOMRect, ReactRenderer } from "@tiptap/react";
import Mention from "@tiptap/extension-mention";
import { exitSuggestion, type SuggestionKeyDownProps } from "@tiptap/suggestion";
import { FileText, Folder } from "lucide-react";

import type { MyFloatingSurface_ClassNames } from "@/components/my-floating-surface.tsx";
import type { MyPopoverContent_ClassNames } from "@/components/my-popover.tsx";
import type {
	MyMenuItem_ClassNames,
	MyMenuItemContentPrimary_ClassNames,
	MyMenuItemContentSecondary_ClassNames,
} from "@/components/my-menu.tsx";
import { cn } from "@/lib/utils.ts";
import { AppTenantProvider } from "@/lib/app-tenant-context.tsx";
import { app_convex_api, type app_convex_Doc } from "@/lib/app-convex-client.ts";
import type { AppClassName, AppElementId } from "@/lib/dom-utils.ts";

/**
 * Plugin key for the composer's "@" suggestion. The composer's own keyboard
 * handlers read it to yield Enter/Escape/Arrow keys while the popup is open.
 */
export const ai_chat_composer_file_mention_PLUGIN_KEY = new PluginKey("aiChatComposerFileMention");

/** The fields of a `files_nodes` doc the mention popup uses. */
type FileMentionItem = Pick<app_convex_Doc<"files_nodes">, "name" | "path" | "kind" | "archiveOperationId">;

/** Longest list the popup renders. The workspace tree can be much larger. */
const FILE_MENTION_MAX_ITEMS = 50;

/**
 * Pick the nodes the popup lists for a query. A query containing `/` matches
 * the path, anything else matches the name, both case-insensitive, like the
 * files sidebar search. Archived nodes are excluded like the sidebar's
 * default view. Tree order is kept.
 */
function filter_mention_items<Item extends FileMentionItem>(nodes: readonly Item[], query: string) {
	const value = query.trim().toLowerCase();
	const matchesPath = value.includes("/");

	const items: Item[] = [];
	for (const node of nodes) {
		if (node.archiveOperationId !== undefined) {
			continue;
		}

		// Match folders in path mode by their serialized token (`/docs/`), so
		// typing a folder token back finds the folder itself, not only its
		// children.
		const candidate = matchesPath ? (node.kind === "folder" ? `${node.path}/` : node.path) : node.name;
		if (value && !candidate.toLowerCase().includes(value)) {
			continue;
		}

		items.push(node);
		if (items.length >= FILE_MENTION_MAX_ITEMS) {
			break;
		}
	}

	return items;
}

/**
 * Position the popup under the caret with a floating-ui virtual element, like
 * the official Tiptap mention example.
 */
function update_popup_position(editor: Editor, element: HTMLElement) {
	const virtualElement = {
		getBoundingClientRect: () => posToDOMRect(editor.view, editor.state.selection.from, editor.state.selection.to),
	};

	computePosition(virtualElement, element, {
		placement: "bottom-start",
		strategy: "absolute",
		middleware: [offset(4), flip(), shift()],
	})
		.then(({ x, y, strategy }) => {
			element.style.width = "max-content";
			element.style.position = strategy;
			element.style.left = `${x}px`;
			element.style.top = `${y}px`;
		})
		.catch((error: unknown) => {
			console.error("[AiChatComposerFileMention.update_popup_position] Failed to position the mention popup", {
				error,
			});
		});
}

// #region chip
export type AiChatComposerFileMention_ClassNames = "AiChatComposerFileMention";

type ai_chat_composer_file_mention_CreateOptions = {
	/**
	 * Called with the popup element while it is mounted, and with `null` when
	 * it closes. Keep it in composer state and allow it in the composer's
	 * outside-interaction check, so a click on a popup row does not count as
	 * an outside click for the message-edit composer.
	 */
	onPopupElementChange: (element: HTMLElement | null) => void;
};

/**
 * Build the configured Mention extension for one composer instance.
 */
export function ai_chat_composer_file_mention_create_extension(options: ai_chat_composer_file_mention_CreateOptions) {
	return Mention.configure({
		HTMLAttributes: { class: "AiChatComposerFileMention" satisfies AiChatComposerFileMention_ClassNames },
		// The submitted message is `editor.getText(...)`, which uses this
		// serializer. The chip shows the name, but the text carries the full
		// path token the agent's tools resolve.
		renderText({ node }) {
			return `@${node.attrs.id}`;
		},
		renderHTML({ options: nodeOptions, node }) {
			const isFolder = typeof node.attrs.id === "string" && node.attrs.id.endsWith("/");
			return [
				"span",
				mergeAttributes(nodeOptions.HTMLAttributes, { title: node.attrs.id }),
				`@${node.attrs.label ?? node.attrs.id}${isFolder ? "/" : ""}`,
			];
		},
		suggestion: {
			char: "@",
			pluginKey: ai_chat_composer_file_mention_PLUGIN_KEY,
			// The popup owns a reactive Convex subscription and filters from its
			// props, so the plugin's one-shot items snapshot stays unused.
			items: () => [],
			render: () => {
				let component: ReactRenderer<AiChatComposerFileMentionList_Ref, AiChatComposerFileMentionList_Props> | null =
					null;
				let blurEditor: Editor | null = null;

				// The plugin does not close the suggestion when the editor loses
				// focus. Clicking the popup itself never blurs the editor because
				// the popup cancels mousedown, so a blur is a real focus exit.
				const handleEditorBlur = () => {
					if (blurEditor) {
						exitSuggestion(blurEditor.view, ai_chat_composer_file_mention_PLUGIN_KEY);
					}
				};

				// `onExit` can fire more than once (Escape, blur exit, editor
				// destroy), so destroying must tolerate repeats.
				const destroy = () => {
					if (!component) {
						return;
					}

					options.onPopupElementChange(null);
					blurEditor?.off("blur", handleEditorBlur);
					blurEditor = null;
					component.element.remove();
					component.destroy();
					component = null;
				};

				return {
					onStart: (props) => {
						component = new ReactRenderer(AiChatComposerFileMentionList, {
							props: {
								editor: props.editor,
								query: props.query,
								command: props.command,
							} satisfies AiChatComposerFileMentionList_Props,
							editor: props.editor,
						});

						if (!props.clientRect) {
							return;
						}

						component.element.style.position = "absolute";
						// Mount into the app overlay container so the popup escapes the
						// composer's overflow. Component tests render without the app
						// shell, so fall back to the body.
						const container =
							document.getElementById("app_hoisting_container" satisfies AppElementId) ?? document.body;
						container.appendChild(component.element);
						update_popup_position(props.editor, component.element);

						blurEditor = props.editor;
						props.editor.on("blur", handleEditorBlur);
						options.onPopupElementChange(component.element);
					},
					onUpdate: (props) => {
						if (!component) {
							return;
						}

						component.updateProps({
							query: props.query,
							command: props.command,
						} satisfies Partial<AiChatComposerFileMentionList_Props>);

						if (props.clientRect) {
							update_popup_position(props.editor, component.element);
						}
					},
					onKeyDown: (props) => {
						// Return false for Escape so the plugin runs its own exit; the
						// vendored plugin skips the exit when the renderer claims the key.
						// Also stop the native event here. This Escape only closes the
						// popup, but the chat-level keydown handler treats any bubbling
						// Escape as a close command even when defaultPrevented, so it
						// would still cancel a message edit. A React-state gate in the
						// composer cannot catch this: React flushes the popup-close state
						// update before its own handlers run.
						if (props.event.key === "Escape") {
							props.event.stopPropagation();
							return false;
						}

						return component?.ref?.onKeyDown(props) ?? false;
					},
					onExit: destroy,
				};
			},
		},
	});
}
// #endregion chip

// #region list
type AiChatComposerFileMentionList_ClassNames =
	| "AiChatComposerFileMentionList"
	| "AiChatComposerFileMentionList-status"
	| "AiChatComposerFileMentionList-item"
	| "AiChatComposerFileMentionList-item-icon"
	| "AiChatComposerFileMentionList-item-content"
	| "AiChatComposerFileMentionList-item-name"
	| "AiChatComposerFileMentionList-item-path";

type AiChatComposerFileMentionList_Ref = {
	onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

type AiChatComposerFileMentionList_Props = {
	ref?: Ref<AiChatComposerFileMentionList_Ref>;
	editor: Editor;
	query: string;
	command: (attrs: { id: string; label: string }) => void;
};

// This component is private because the Tiptap extension owns its lifecycle.
// eslint-disable-next-line react-refresh/only-export-components
const AiChatComposerFileMentionList = memo(function AiChatComposerFileMentionList(
	props: AiChatComposerFileMentionList_Props,
) {
	const { ref, editor, query, command } = props;

	const listboxId = `AiChatComposerFileMentionList-${useId()}`;

	const { membershipId } = AppTenantProvider.useContext();
	const treeNodes = useQuery(app_convex_api.files_nodes.list_tree, { membershipId });
	const items = treeNodes && filter_mention_items(treeNodes, query);

	// The stored highlight belongs to the query it was set for; a new query
	// starts back at the top row without needing a sync effect.
	const [highlight, setHighlight] = useState({ query, index: 0 });
	const selectedIndex = highlight.query === query ? highlight.index : 0;
	const activeIndex = items && items.length > 0 ? Math.min(selectedIndex, items.length - 1) : 0;
	const activeOptionId = items && items.length > 0 ? `${listboxId}-option-${activeIndex}` : null;

	const selectItem = (item: FileMentionItem) => {
		// Folder tokens carry a trailing slash so the model can tell folders
		// from files without another lookup.
		command({ id: item.kind === "folder" ? `${item.path}/` : item.path, label: item.name });
	};

	const handleRootMouseDown = (event: MouseEvent<HTMLDivElement>) => {
		// Keep DOM focus in the editor for every popup click.
		event.preventDefault();
	};

	useImperativeHandle(
		ref,
		() => ({
			onKeyDown: ({ event }: SuggestionKeyDownProps) => {
				// Let the IME commit composed text; the plugin forwards keys while
				// composition is active.
				if (event.isComposing) {
					return false;
				}

				if (event.key === "ArrowUp" || event.key === "ArrowDown") {
					if (items && items.length > 0) {
						const direction = event.key === "ArrowUp" ? -1 : 1;
						setHighlight({ query, index: (activeIndex + direction + items.length) % items.length });
					}
					return true;
				}

				if (event.key === "Enter") {
					const item = items?.[activeIndex];
					if (item) {
						selectItem(item);
					}
					// Swallow Enter even with no rows: the composer yields while the
					// popup is open, and letting ProseMirror split the paragraph would
					// break the one-paragraph message invariant.
					return true;
				}

				return false;
			},
		}),
		[items, activeIndex, query, command],
	);

	// The editor keeps DOM focus. Expose the popup to assistive tech through
	// the textbox: aria-controls names the listbox and aria-activedescendant
	// tracks the highlighted row.
	useEffect(() => {
		const editorDom = editor.view.dom;
		editorDom.setAttribute("aria-controls", listboxId);
		if (activeOptionId) {
			editorDom.setAttribute("aria-activedescendant", activeOptionId);
		} else {
			editorDom.removeAttribute("aria-activedescendant");
		}

		return () => {
			editorDom.removeAttribute("aria-controls");
			editorDom.removeAttribute("aria-activedescendant");
		};
	}, [editor, listboxId, activeOptionId]);

	useEffect(() => {
		if (activeOptionId) {
			document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
		}
	}, [activeOptionId]);

	return (
		<div
			id={listboxId}
			role="listbox"
			aria-label="Files and folders"
			className={cn(
				"AiChatComposerFileMentionList" satisfies AiChatComposerFileMentionList_ClassNames,
				"app-scrollable" satisfies AppClassName,
				"MyFloatingSurface" satisfies MyFloatingSurface_ClassNames,
				"MyPopoverContent" satisfies MyPopoverContent_ClassNames,
			)}
			onMouseDown={handleRootMouseDown}
		>
			{!items ? (
				<div className={"AiChatComposerFileMentionList-status" satisfies AiChatComposerFileMentionList_ClassNames}>
					Loading…
				</div>
			) : items.length === 0 ? (
				<div className={"AiChatComposerFileMentionList-status" satisfies AiChatComposerFileMentionList_ClassNames}>
					No results
				</div>
			) : (
				items.map((item, index) => {
					const parentPath = item.path.slice(0, item.path.lastIndexOf("/") + 1);
					return (
						<div
							key={item.path}
							id={`${listboxId}-option-${index}`}
							role="option"
							aria-selected={index === activeIndex}
							className={cn(
								"AiChatComposerFileMentionList-item" satisfies AiChatComposerFileMentionList_ClassNames,
								"MyMenuItem" satisfies MyMenuItem_ClassNames,
							)}
							onClick={() => selectItem(item)}
						>
							<div
								className={"AiChatComposerFileMentionList-item-icon" satisfies AiChatComposerFileMentionList_ClassNames}
							>
								{item.kind === "folder" ? <Folder /> : <FileText />}
							</div>
							<div
								className={
									"AiChatComposerFileMentionList-item-content" satisfies AiChatComposerFileMentionList_ClassNames
								}
							>
								<span
									className={cn(
										"AiChatComposerFileMentionList-item-name" satisfies AiChatComposerFileMentionList_ClassNames,
										"MyMenuItemContentPrimary" satisfies MyMenuItemContentPrimary_ClassNames,
									)}
								>
									{item.name}
								</span>
								<span
									className={cn(
										"AiChatComposerFileMentionList-item-path" satisfies AiChatComposerFileMentionList_ClassNames,
										"MyMenuItemContentSecondary" satisfies MyMenuItemContentSecondary_ClassNames,
									)}
								>
									{parentPath}
								</span>
							</div>
						</div>
					);
				})
			)}
		</div>
	);
});
// #endregion list

if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	const nodes = [
		{ name: "docs", path: "/docs", kind: "folder" as const, archiveOperationId: undefined },
		{ name: "api.md", path: "/docs/api.md", kind: "file" as const, archiveOperationId: undefined },
		{ name: "notes.md", path: "/notes.md", kind: "file" as const, archiveOperationId: undefined },
	];

	describe("filter_mention_items", () => {
		test("matches names case-insensitively when the query has no slash", () => {
			expect(filter_mention_items(nodes, "API").map((item) => item.path)).toEqual(["/docs/api.md"]);
		});

		test("matches paths when the query contains a slash, including the folder's own token", () => {
			expect(filter_mention_items(nodes, "docs/").map((item) => item.path)).toEqual(["/docs", "/docs/api.md"]);
		});

		test("returns everything in tree order for an empty query", () => {
			expect(filter_mention_items(nodes, "").map((item) => item.path)).toEqual(["/docs", "/docs/api.md", "/notes.md"]);
		});

		test("excludes archived nodes", () => {
			const withArchived = [
				...nodes,
				{
					name: "old.md",
					path: "/old.md",
					kind: "file" as const,
					archiveOperationId: "archive-1" as app_convex_Doc<"files_nodes">["archiveOperationId"],
				},
			];
			expect(filter_mention_items(withArchived, "old")).toEqual([]);
		});

		test("caps the result list", () => {
			const many = Array.from({ length: 80 }, (_, index) => ({
				name: `file-${index}.md`,
				path: `/file-${index}.md`,
				kind: "file" as const,
				archiveOperationId: undefined,
			}));
			expect(filter_mention_items(many, "file").length).toBe(50);
		});
	});
}
