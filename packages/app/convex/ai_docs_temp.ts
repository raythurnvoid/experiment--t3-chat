/*
Pages are organized in a emulated file system in which each page exists in a tree and each page can have children.

This structure allows file system like operations such has finding all items under a certain path (`foo/bar/*`) or
listing all children or the content of a certain page (`foo/bar/baz`).
*/

import {
	httpAction,
	internalQuery,
	mutation,
	query,
	type QueryCtx,
	type MutationCtx,
	type ActionCtx,
	internalMutation,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel";
import { paginationOptsValidator, type RouteSpec } from "convex/server";
import { streamText, smoothStream } from "ai";
import { openai } from "@ai-sdk/openai";
import {
	path_extract_segments_from,
	server_convex_get_user_fallback_to_anonymous,
	server_request_json_parse_and_validate,
	encode_path_segment,
} from "../server/server-utils.ts";
import { v, type Infer } from "convex/values";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import {
	date_get_week_start_timestamp,
	date_get_day_start_timestamp,
	date_get_hour_start_timestamp,
	date_MS_DAY,
	date_MS_DAYS_30,
	date_MS_WEEK,
} from "../shared/date.ts";
import {
	pages_FIRST_VERSION,
	pages_ROOT_ID,
	pages_headless_tiptap_editor_create,
	pages_u8_to_array_buffer,
	pages_headless_tiptap_editor_set_content_from_markdown,
	pages_yjs_create_empty_state_update,
	pages_yjs_doc_create_from_array_buffer_update,
	pages_yjs_doc_get_markdown,
	pages_yjs_doc_update_from_tiptap_editor,
	pages_yjs_doc_create_from_tiptap_editor,
	pages_yjs_compute_diff_update_from_state_vector,
} from "../server/pages.ts";
import { minimatch } from "minimatch";
import { Result } from "../shared/errors-as-values-utils.ts";
import { encodeStateVector, encodeStateAsUpdate, mergeUpdates } from "yjs";
import type { Editor } from "@tiptap/core";
import { should_never_happen } from "../shared/shared-utils.ts";
import app_convex_schema from "./schema.ts";
import { internal } from "./_generated/api.js";
import { doc } from "convex-helpers/validators";
import { z } from "zod";
import type { RouterForConvexModules } from "./http.ts";

function pages_materialized_path_join(parentPath: string, pageName: string) {
	if (parentPath === "/") {
		const encodedName = encode_path_segment(pageName);
		return encodedName === "" ? "/" : `/${encodedName}`;
	}

	const encodedName = encode_path_segment(pageName);
	return encodedName === "" ? parentPath : `${parentPath}/${encodedName}`;
}

/**
 * Rebase an absolute path from one base path to another.
 *
 * @example
 * ```ts
 * // valid rebase
 * path_rebase({
 * 	fromBasePath: "/docs",
 * 	toBasePath: "/archive",
 * 	path: "/docs/guides/getting-started",
 * }); // => "/archive/guides/getting-started"
 * ```
 *
 * @example
 * ```ts
 * // invalid rebase (path is outside fromBasePath)
 * path_rebase({
 * 	fromBasePath: "/docs",
 * 	toBasePath: "/archive",
 * 	path: "/notes/todo",
 * }); // => null
 * ```
 *
 * Path format: absolute (`/`-prefixed) and no trailing `/` for non-root paths.
 *
 * @param args.fromBasePath - Base path that `args.path` must match (same path format).
 * @param args.toBasePath - Base path used in the rebased result (same path format).
 * @param args.path - Absolute path to rebase (same path format).
 *
 * @returns The rebased path, or `null` when `args.path` does not start with `args.fromBasePath`.
 */
function path_rebase(args: { fromBasePath: string; toBasePath: string; path: string }) {
	if (args.path === args.fromBasePath) {
		return args.toBasePath;
	}

	if (!args.path.startsWith(`${args.fromBasePath}/`)) {
		return null;
	}

	const suffix = args.path.slice(args.fromBasePath.length + 1);
	return `${args.toBasePath}${args.toBasePath === "/" ? "" : "/"}${suffix}`;
}

function is_home_page(page: Pick<Doc<"pages">, "path">): boolean;
function is_home_page(page: Pick<Doc<"pages">, "parentId" | "name">): boolean;
function is_home_page(page: Partial<Pick<Doc<"pages">, "path" | "parentId" | "name">>) {
	return page.path === "/" || (page.parentId === pages_ROOT_ID && page.name === "");
}

type pages_QueryOrMutationCtx = QueryCtx | MutationCtx;

async function find_active_pages_by_path(
	ctx: pages_QueryOrMutationCtx,
	args: { workspaceId: string; projectId: string; path: string },
) {
	return ctx.db
		.query("pages")
		.withIndex("by_workspaceId_projectId_path_archiveOperationId", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("path", args.path)
				.eq("archiveOperationId", undefined),
		)
		.collect();
}

async function find_active_page_by_path(
	ctx: pages_QueryOrMutationCtx,
	args: { workspaceId: string; projectId: string; path: string },
) {
	const activePages = await find_active_pages_by_path(ctx, args);
	return activePages.at(0) ?? null;
}

async function find_active_path_conflict(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		path: string;
		excludePageIds?: Array<Id<"pages">>;
	},
) {
	const activePages = await find_active_pages_by_path(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		path: args.path,
	});
	const excludePageIdsSet = new Set(args.excludePageIds ?? []);
	for (const activePage of activePages) {
		if (excludePageIdsSet.has(activePage._id)) {
			continue;
		}
		return activePage;
	}
	return null;
}

async function resolve_id_from_path(ctx: QueryCtx, args: { workspaceId: string; projectId: string; path: string }) {
	if (args.path === "/") {
		return null;
	}

	const activePageByMaterializedPath = await find_active_page_by_path(ctx, args);
	return activePageByMaterializedPath?._id ?? null;
}

async function resolve_page_id_from_path_fn(
	ctx: QueryCtx,
	args: { workspaceId: string; projectId: string; path: string },
) {
	return resolve_id_from_path(ctx, args);
}

export const resolve_page_id_from_path = internalQuery({
	args: { workspaceId: v.string(), projectId: v.string(), path: v.string() },
	returns: v.union(v.id("pages"), v.null()),
	handler: (ctx, args) => resolve_page_id_from_path_fn(ctx, args),
});

async function resolve_tree_node_id_from_path_fn(
	ctx: QueryCtx,
	args: { workspaceId: string; projectId: string; path: string },
) {
	if (args.path === "/") return pages_ROOT_ID;

	const pageByMaterializedPath = await find_active_page_by_path(ctx, args);
	if (pageByMaterializedPath) {
		return pageByMaterializedPath._id;
	}

	return null;
}

export const resolve_tree_node_id_from_path = internalQuery({
	args: { workspaceId: v.string(), projectId: v.string(), path: v.string() },
	returns: v.union(v.id("pages"), v.literal(pages_ROOT_ID), v.null()),
	handler: (ctx, args) => resolve_tree_node_id_from_path_fn(ctx, args),
});

async function resolve_parent_path_from_parent_id(
	ctx: QueryCtx,
	args: {
		workspaceId: string;
		projectId: string;
		parentId: Doc<"pages">["parentId"];
	},
) {
	if (args.parentId === pages_ROOT_ID) {
		return "/";
	}

	const parentPage = await ctx.db.get("pages", args.parentId);
	if (!parentPage || parentPage.workspaceId !== args.workspaceId || parentPage.projectId !== args.projectId) {
		return null;
	}

	return parentPage.path;
}

async function cascade_page_descendants_path(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		parentId: Id<"pages">;
		parentPath: string;
	},
) {
	const stack: Array<{ parentId: Id<"pages">; parentPath: string }> = [
		{ parentId: args.parentId, parentPath: args.parentPath },
	];

	while (stack.length > 0) {
		const frame = stack.pop();
		if (!frame) {
			continue;
		}

		const children = await ctx.db
			.query("pages")
			.withIndex("by_workspaceId_projectId_parentId_name", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("parentId", frame.parentId),
			)
			.collect();

		await Promise.all(
			children.map(async (child) => {
				const childPath = pages_materialized_path_join(frame.parentPath, child.name);
				await ctx.db.patch("pages", child._id, {
					path: childPath,
				});
				stack.push({
					parentId: child._id,
					parentPath: childPath,
				});
			}),
		);
	}
}

const get_tree_items_list_validator = v.array(
	v.object({
		type: v.union(v.literal("root"), v.literal("page"), v.literal("placeholder")),
		index: v.string(),
		parentId: v.string(),
		title: v.string(),
		archiveOperationId: v.optional(v.string()),
		updatedAt: v.number(),
		updatedBy: v.string(),
		_id: v.union(v.id("pages"), v.null()),
	}),
);

export type pages_TreeItem = Infer<typeof get_tree_items_list_validator>[number];

export const get_tree_items_list = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: get_tree_items_list_validator,
	handler: async (ctx, args) => {
		const pages = await ctx.db
			.query("pages")
			.withIndex("by_workspaceId_projectId_name", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId),
			)
			.order("asc")
			.filter((q) => q.neq(q.field("name"), ""))
			.collect();

		const treeItemsList: pages_TreeItem[] = [
			{
				type: "root",
				index: pages_ROOT_ID,
				parentId: "",
				title: "Pages",
				archiveOperationId: undefined,
				updatedAt: Date.now(),
				updatedBy: "system",
				_id: null,
			},
			...pages.map(
				(page) =>
					({
						type: "page" as const,
						index: page._id,
						parentId: page.parentId === pages_ROOT_ID ? pages_ROOT_ID : page.parentId,
						title: page.name || "Untitled",
						archiveOperationId: page.archiveOperationId,
						updatedAt: page.updatedAt,
						updatedBy: page.updatedBy,
						_id: page._id,
					}) satisfies pages_TreeItem,
			),
		];

		return treeItemsList;
	},
});

async function do_create_page(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		parentId: Doc<"pages">["parentId"];
		name: Doc<"pages">["name"];
		markdown_content: Doc<"pages_markdown_content">["content"];
	},
) {
	const user = await server_convex_get_user_fallback_to_anonymous(ctx);
	const now = Date.now();
	const parentPath = await resolve_parent_path_from_parent_id(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		parentId: args.parentId,
	});
	if (parentPath == null) {
		return Result({
			_nay: {
				name: "nay",
				message: "Parent page not found",
			},
		});
	}
	const pagePath = pages_materialized_path_join(parentPath, args.name);
	const activePathConflict = await find_active_path_conflict(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		path: pagePath,
	});
	if (activePathConflict) {
		return Result({
			_nay: {
				name: "nay",
				message: "Failed to create page because path already exists",
			},
		});
	}

	// Create initial Yjs snapshot + sequence tracker with the page.
	// Important: do NOT store an empty bytes blob; Yjs update decoding may throw on empty payloads.
	const initialYjsSequence = 0;

	let initialYjsSnapshotUpdate;
	if (args.markdown_content) {
		const editor = pages_headless_tiptap_editor_create();

		if (editor._nay) {
			return editor;
		}

		const markdownContentSet = pages_headless_tiptap_editor_set_content_from_markdown({
			markdown: args.markdown_content ?? "",
			mut_editor: editor._yay,
		});
		if (markdownContentSet._nay) {
			return markdownContentSet;
		}
		initialYjsSnapshotUpdate = yjs_create_state_update_from_tiptap_editor({
			tiptapEditor: editor._yay,
		});
	} else {
		initialYjsSnapshotUpdate = pages_yjs_create_empty_state_update();
	}

	const pageId = await ctx.db.insert("pages", {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		parentId: args.parentId,
		path: pagePath,
		version: pages_FIRST_VERSION,
		name: args.name,
		archiveOperationId: undefined,
		createdBy: user.id,
		updatedBy: user.name,
		updatedAt: now,
	});

	const [yjs_snapshot_id, yjs_last_sequence_id, markdown_content_id] = await Promise.all([
		ctx.db.insert("pages_yjs_snapshots", {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: pageId,
			sequence: initialYjsSequence,
			snapshot_update: pages_u8_to_array_buffer(initialYjsSnapshotUpdate),
			created_by: user.name,
			updated_by: user.name,
			updated_at: now,
		}),
		ctx.db.insert("pages_yjs_docs_last_sequences", {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: pageId,
			last_sequence: initialYjsSequence,
		}),
		ctx.db.insert("pages_markdown_content", {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: pageId,
			content: args.markdown_content,
			is_archived: false,
			yjs_sequence: initialYjsSequence,
			updated_by: user.name,
			updated_at: now,
		}),
	]);

	await ctx.db.patch("pages", pageId, {
		markdownContentId: markdown_content_id,
		yjsLastSequenceId: yjs_last_sequence_id,
		yjsSnapshotId: yjs_snapshot_id,
	});

	return Result({ _yay: pageId });
}

export const create_page = mutation({
	args: {
		parentId: v.union(v.id("pages"), v.literal(pages_ROOT_ID)),
		name: v.string(),
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: v.union(
		v.object({ _yay: v.object({ pageId: v.id("pages") }) }),
		v.object({ _nay: v.object({ name: v.string(), message: v.string() }) }),
	),
	handler: async (ctx, args) => {
		const page = await do_create_page(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: args.parentId,
			name: args.name,
			markdown_content: "",
		});

		if (page._nay) {
			return page;
		}

		return Result({ _yay: { pageId: page._yay } });
	},
});

export const create_page_quick = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: v.union(
		v.object({ _yay: v.object({ pageId: v.id("pages") }) }),
		v.object({ _nay: v.object({ name: v.string(), message: v.string() }) }),
	),
	handler: async (ctx, args) => {
		const { workspaceId, projectId } = args;

		// Ensure ".tmp" under root exists
		const tmp = await ctx.db
			.query("pages")
			.withIndex("by_workspaceId_projectId_parentId_name", (q) =>
				q.eq("workspaceId", workspaceId).eq("projectId", projectId).eq("parentId", pages_ROOT_ID).eq("name", ".tmp"),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.first();

		let tmpPageId = null;

		if (!tmp) {
			const tmpPage = await do_create_page(ctx, {
				workspaceId: workspaceId,
				projectId: projectId,
				parentId: pages_ROOT_ID,
				name: ".tmp",
				markdown_content:
					"Automatically generated temp folder\n\nThis page contains temporary pages generated by the system.",
			});

			if (tmpPage._nay) {
				return tmpPage;
			}

			tmpPageId = tmpPage._yay;
		} else {
			tmpPageId = tmp._id;
		}

		// Create quick page under ".tmp"
		const title = `Quick page created at ${new Date().toLocaleString("en-GB", { hour12: false })}`;
		const page = await do_create_page(ctx, {
			workspaceId: workspaceId,
			projectId: projectId,
			parentId: tmpPageId,
			name: title,
			markdown_content: "",
		});

		if (page._nay) {
			return page;
		}

		return Result({ _yay: { pageId: page._yay } });
	},
});

export const rename_page = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		name: v.string(),
	},
	returns: v.union(
		v.object({ _yay: v.null() }),
		v.object({ _nay: v.object({ name: v.string(), message: v.string(), data: v.optional(v.any()) }) }),
	),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const page = await ctx.db.get("pages", args.pageId);
		if (!page || page.workspaceId !== args.workspaceId || page.projectId !== args.projectId) {
			return Result({ _yay: null });
		}

		if (is_home_page(page)) {
			// Ignore rename requests for homepage
			return Result({ _yay: null });
		}

		const parentPath = await resolve_parent_path_from_parent_id(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: page.parentId,
		});
		if (parentPath == null) {
			return Result({ _yay: null });
		}
		const renamedPath = pages_materialized_path_join(parentPath, args.name);
		if (page.archiveOperationId === undefined) {
			const activePathConflict = await find_active_path_conflict(ctx, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				path: renamedPath,
				excludePageIds: [args.pageId],
			});
			if (activePathConflict) {
				return Result({
					_nay: {
						name: "nay",
						message: "Path already exists",
					},
				});
			}
		}

		await ctx.db.patch("pages", args.pageId, {
			name: args.name,
			path: renamedPath,
			updatedBy: user.name,
			updatedAt: Date.now(),
		});
		await cascade_page_descendants_path(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: args.pageId,
			parentPath: renamedPath,
		});
		return Result({ _yay: null });
	},
});

export const move_pages = mutation({
	args: {
		itemIds: v.array(v.id("pages")),
		targetParentId: v.union(v.id("pages"), v.literal(pages_ROOT_ID)),
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: v.union(
		v.object({ _yay: v.null() }),
		v.object({ _nay: v.object({ name: v.string(), message: v.string() }) }),
	),
	handler: async (ctx, args) => {
		const targetParentPath = await resolve_parent_path_from_parent_id(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: args.targetParentId,
		});
		if (targetParentPath == null) {
			return Result({ _yay: null });
		}

		const pagesToMove: Array<{ itemId: Id<"pages">; page: Doc<"pages">; movedPath: string }> = [];

		for (const itemId of args.itemIds) {
			const page = await ctx.db.get("pages", itemId);
			if (!page || page.workspaceId !== args.workspaceId || page.projectId !== args.projectId) {
				continue;
			}
			if (is_home_page(page)) {
				// Skip move requests for homepage
				continue;
			}

			const movedPath = pages_materialized_path_join(targetParentPath, page.name);
			pagesToMove.push({ itemId, page, movedPath });
		}

		const movingPageIds = pagesToMove.map((page) => page.itemId);
		const movedPathByPageId = new Map<string, Id<"pages">>();
		for (const pageToMove of pagesToMove) {
			if (pageToMove.page.archiveOperationId !== undefined) {
				continue;
			}

			const duplicateTargetPageId = movedPathByPageId.get(pageToMove.movedPath);
			if (duplicateTargetPageId && duplicateTargetPageId !== pageToMove.itemId) {
				return Result({
					_nay: {
						name: "nay",
						message: "Path already exists",
					},
				});
			}
			movedPathByPageId.set(pageToMove.movedPath, pageToMove.itemId);

			const activePathConflict = await find_active_path_conflict(ctx, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				path: pageToMove.movedPath,
				excludePageIds: movingPageIds,
			});
			if (activePathConflict) {
				return Result({
					_nay: {
						name: "nay",
						message: "Path already exists",
					},
				});
			}
		}

		for (const pageToMove of pagesToMove) {
			await ctx.db.patch("pages", pageToMove.itemId, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				parentId: args.targetParentId,
				path: pageToMove.movedPath,
				updatedAt: Date.now(),
			});
			await cascade_page_descendants_path(ctx, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				parentId: pageToMove.itemId,
				parentPath: pageToMove.movedPath,
			});
		}
		return Result({ _yay: null });
	},
});

export const archive_pages = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageIds: v.array(v.id("pages")),
	},
	returns: v.union(
		v.object({ _yay: v.null() }),
		v.object({ _nay: v.object({ name: v.string(), message: v.string(), data: v.any() }) }),
	),
	handler: async (ctx, args) => {
		const now = Date.now();
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const pages = await Promise.all(
			args.pageIds.map(async (pageId) => {
				return ctx.db.get("pages", pageId).then((page) => {
					if (!page || page.workspaceId !== args.workspaceId || page.projectId !== args.projectId) {
						return Result({ _nay: { name: "nay", message: "Page not found", data: { pageId } } });
					}

					return Result({ _yay: page });
				});
			}),
		);

		const nayResult = pages.find((page) => page._nay !== undefined);
		if (nayResult) {
			return nayResult;
		}

		const archiveOperationId = crypto.randomUUID();
		const pageIdsToArchive = new Set<Id<"pages">>();

		for (const page of pages) {
			if (!page._yay) {
				continue;
			}

			if (is_home_page(page._yay)) {
				// Ignore archive requests for homepage
				continue;
			}

			if (page._yay.archiveOperationId !== undefined) {
				continue;
			}

			pageIdsToArchive.add(page._yay._id);

			// All descendants page needs to be archived too
			const descendantsPathPrefix = `${page._yay.path}/`;
			const descendantPages = await ctx.db
				.query("pages")
				.withIndex("by_workspaceId_projectId_path_archiveOperationId", (q) =>
					q
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.projectId)
						.gte("path", descendantsPathPrefix)
						.lt("path", `${descendantsPathPrefix}\uffff`),
				)
				.collect();

			for (const descendantPage of descendantPages) {
				if (descendantPage.archiveOperationId !== undefined) {
					continue;
				}
				pageIdsToArchive.add(descendantPage._id);
			}
		}

		await Promise.all(
			[...pageIdsToArchive].map(async (pageId) => {
				await ctx.db.patch("pages", pageId, {
					archiveOperationId,
					updatedBy: user.name,
					updatedAt: now,
				});
			}),
		);

		return Result({ _yay: null });
	},
});

export const unarchive_pages = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageIds: v.array(v.id("pages")),
	},
	returns: v.union(
		v.object({ _yay: v.null() }),
		v.object({ _nay: v.object({ name: v.string(), message: v.string() }) }),
	),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		if (args.pageIds.length === 0) {
			return Result({ _yay: null });
		}

		const pages = await Promise.all(
			args.pageIds.map(async (pageId) => {
				return ctx.db.get("pages", pageId).then((page) => {
					if (!page || page.workspaceId !== args.workspaceId || page.projectId !== args.projectId) {
						return Result({ _nay: { name: "nay", message: "Page not found", data: { pageId } } });
					}
					return Result({ _yay: page });
				});
			}),
		);
		const nayResult = pages.find((page) => page._nay !== undefined);
		if (nayResult) {
			return nayResult;
		}

		// Find the top most shared ancestor for each page requested.
		const topMostSharedAncestorsByPath = new Map<string, Doc<"pages">>();
		for (const page of pages) {
			if (!page._yay) {
				continue;
			}

			const currentPage = page._yay;

			// Ignore unarchive requests for homepage.
			if (is_home_page(currentPage)) {
				continue;
			}

			if (currentPage.archiveOperationId === undefined) {
				continue;
			}

			const conflictedCurrentPage = topMostSharedAncestorsByPath.get(currentPage.path);
			if (conflictedCurrentPage) {
				return Result({
					_nay: {
						name: "nay",
						message: "Failed to unarchive page because it would conflict with another unarchiving page",
						data: {
							requestedPageIds: args.pageIds,
							pageId: currentPage._id,
							pagePath: currentPage.path,
							targetPath: currentPage.path,
							conflictingPageId: conflictedCurrentPage._id,
							conflictingPagePath: conflictedCurrentPage.path,
						},
					},
				});
			}

			let isDescendantOfCurrentRoot = false;
			for (const currentRootPath of topMostSharedAncestorsByPath.keys()) {
				if (currentPage.path.startsWith(`${currentRootPath}/`)) {
					isDescendantOfCurrentRoot = true;
					break;
				}
			}
			if (isDescendantOfCurrentRoot) {
				continue;
			}

			for (const currentRootPath of topMostSharedAncestorsByPath.keys()) {
				if (currentRootPath.startsWith(`${currentPage.path}/`)) {
					topMostSharedAncestorsByPath.delete(currentRootPath);
				}
			}

			topMostSharedAncestorsByPath.set(currentPage.path, currentPage);
		}

		if (topMostSharedAncestorsByPath.size === 0) {
			return Result({ _yay: null });
		}

		// Build one plan entry per page to unarchive.
		const plans: Array<{
			page: Doc<"pages">;
			targetParentId: Doc<"pages">["parentId"];
			targetPath: string;
		}> = [];
		const ancestorsPagesByTargetPath = new Map<string, Doc<"pages">>();

		for (const ancestorPage of topMostSharedAncestorsByPath.values()) {
			const archiveOperationId = ancestorPage.archiveOperationId;
			if (archiveOperationId === undefined) {
				continue;
			}

			// For each ancestor find all descendants to unarchive.
			const descendantsPathPrefix = `${ancestorPage.path}/`;
			const descendantPages = await ctx.db
				.query("pages")
				.withIndex("by_workspaceId_projectId_archiveOperationId_path", (q) =>
					q
						.eq("workspaceId", args.workspaceId)
						.eq("projectId", args.projectId)
						.eq("archiveOperationId", archiveOperationId)
						.gte("path", descendantsPathPrefix)
						.lt("path", `${descendantsPathPrefix}\uffff`),
				)
				.collect();

			let shouldMoveToRoot = false;
			if (ancestorPage.parentId !== pages_ROOT_ID) {
				const parentPage = await ctx.db.get("pages", ancestorPage.parentId);
				// If parent is still archived or invalid, move this subtree to root when unarchiving.
				shouldMoveToRoot =
					!parentPage ||
					parentPage.workspaceId !== args.workspaceId ||
					parentPage.projectId !== args.projectId ||
					parentPage.archiveOperationId !== undefined;
			}

			const ancestorTargetParentId = shouldMoveToRoot ? pages_ROOT_ID : ancestorPage.parentId;
			let ancestorTargetPath = ancestorPage.path;
			if (shouldMoveToRoot) {
				const ancestorPathName = path_extract_segments_from(ancestorPage.path).at(-1);
				if (!ancestorPathName) {
					throw should_never_happen("Failed to move page to root because path does not include a name segment", {
						pageId: ancestorPage._id,
						path: ancestorPage.path,
					});
				}
				ancestorTargetPath = `/${ancestorPathName}`;
			}

			const conflictedAncestorPage = ancestorsPagesByTargetPath.get(ancestorTargetPath);
			if (conflictedAncestorPage) {
				return Result({
					_nay: {
						name: "nay",
						message: "Failed to unarchive page because it would conflict with another unarchiving page",
						data: {
							requestedPageIds: args.pageIds,
							pageId: ancestorPage._id,
							pagePath: ancestorPage.path,
							targetPath: ancestorTargetPath,
							conflictingPageId: conflictedAncestorPage._id,
							conflictingPagePath: conflictedAncestorPage.path,
						},
					},
				});
			}
			ancestorsPagesByTargetPath.set(ancestorTargetPath, ancestorPage);

			plans.push({
				page: ancestorPage,
				targetParentId: ancestorTargetParentId,
				targetPath: ancestorTargetPath,
			});

			for (const page of descendantPages) {
				const targetPath = path_rebase({
					fromBasePath: ancestorPage.path,
					toBasePath: ancestorTargetPath,
					path: page.path,
				});

				if (!targetPath) {
					throw should_never_happen("Failed to rebase descendants pages", {
						ancestorPageId: ancestorPage._id,
						ancestorPath: ancestorPage.path,
						ancestorTargetPath,
						ancestorTargetParentId,
						descendantPageId: page._id,
						descendantPagePath: page.path,
					});
				}

				plans.push({
					page,
					targetParentId: page.parentId,
					targetPath,
				});
			}
		}

		// Validate top-most ancestor conflicts against currently not archived pages outside this operation.
		for (const [ancestorTargetPath, ancestorPage] of ancestorsPagesByTargetPath) {
			const conflictPage = await find_active_path_conflict(ctx, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				path: ancestorTargetPath,
			});

			if (conflictPage) {
				return Result({
					_nay: {
						name: "nay",
						message: "Failed to unarchive page because path already exists",
						data: {
							requestedPageIds: args.pageIds,
							pageId: ancestorPage._id,
							pagePath: ancestorPage.path,
							targetPath: ancestorTargetPath,
							conflictingPageId: conflictPage._id,
							conflictingPagePath: conflictPage.path,
						},
					},
				});
			}
		}

		// Preconditions passed, apply all patches.
		const updatedAt = Date.now();
		await Promise.all(
			plans.map(async (plan) =>
				ctx.db.patch("pages", plan.page._id, {
					archiveOperationId: undefined,
					updatedBy: user.name,
					updatedAt,
					...(plan.targetPath !== plan.page.path ? { path: plan.targetPath } : {}),
					...(plan.targetParentId !== plan.page.parentId ? { parentId: plan.targetParentId } : {}),
				}),
			),
		);

		return Result({ _yay: null });
	},
});

export const get = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "pages"), v.null()),
	handler: async (ctx, args) => {
		const normalizedPageId = ctx.db.normalizeId("pages", args.pageId);
		if (!normalizedPageId) {
			return null;
		}

		const page = await ctx.db.get("pages", normalizedPageId);
		if (!page || page.workspaceId !== args.workspaceId || page.projectId !== args.projectId) {
			return null;
		}

		return page;
	},
});

export const get_page_by_path = query({
	args: { workspaceId: v.string(), projectId: v.string(), path: v.string() },
	returns: v.union(
		v.object({
			workspaceId: v.union(v.string(), v.null()),
			projectId: v.union(v.string(), v.null()),
			pageId: v.id("pages"),
			name: v.string(),
			archiveOperationId: v.optional(v.string()),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const pageConvexId = await resolve_id_from_path(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});

		if (!pageConvexId) return null;
		const page = await ctx.db.get("pages", pageConvexId);

		return page
			? {
					workspaceId: page.workspaceId,
					projectId: page.projectId,
					pageId: page._id,
					name: page.name,
					archiveOperationId: page.archiveOperationId,
				}
			: null;
	},
});

export const read_dir = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
	},
	returns: v.array(v.string()),
	handler: async (ctx, args) => {
		const nodeId = await resolve_tree_node_id_from_path_fn(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});
		if (!nodeId) return [];

		const children = await ctx.db
			.query("pages")
			.withIndex("by_workspaceId_projectId_parentId_archiveOperationId", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("parentId", nodeId)
					.eq("archiveOperationId", undefined),
			)
			.collect();

		// TODO: do not collect
		const names = children.map((page) => page.name);
		return names;
	},
});

export const get_page_info_for_list_dir_pagination = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		parentId: v.union(v.id("pages"), v.literal(pages_ROOT_ID)),
		cursor: paginationOptsValidator.fields.cursor,
	},
	handler: async (ctx, args) => {
		// TODO: do not use paginate
		const result = await ctx.db
			.query("pages")
			.withIndex("by_workspaceId_projectId_parentId_archiveOperationId", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("parentId", args.parentId)
					.eq("archiveOperationId", undefined),
			)
			.paginate({
				cursor: args.cursor,
				numItems: 1,
			});

		return {
			...result,
			page: result.page.map((page) => ({
				name: page.name,
				pageId: page._id,
				updatedAt: page.updatedAt,
			})),
		};
	},
});

export const list_pages = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
		maxDepth: v.number(),
		limit: v.number(),
		include: v.optional(v.string()),
	},
	returns: v.object({
		items: v.array(v.object({ path: v.string(), updatedAt: v.number(), depthTruncated: v.boolean() })),
		truncated: v.boolean(),
	}),
	handler: async (ctx, args) => {
		// TODO: when truncating, we truncate the total rows but we don't tell the LLM if we truncated in depth
		const startNodeId = await resolve_tree_node_id_from_path_fn(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});
		if (!startNodeId) return { items: [], truncated: false };

		// Normalize base path to an absolute path string (leading slash, no trailing slash except root)
		const basePath = args.path;
		const maxDepth = Math.max(0, Math.min(10, args.maxDepth));
		const limit = Math.max(1, Math.min(100, args.limit));
		const include = args.include;

		const matchesInclude = (absPath: string) => (include ? minimatch(absPath, include) : true);

		const results: Array<{ path: string; updatedAt: number; depthTruncated: boolean }> = [];
		let truncated = false;

		// Depth-first traversal using an explicit stack.
		// We iterate children via an indexed query (async iterable) and dive deeper first.
		const stack: Array<{
			parentId: Doc<"pages">["parentId"];
			absPath: string;
			depth: number;
			iterator: AsyncIterator<Doc<"pages">> | null;
		}> = [{ parentId: startNodeId, absPath: basePath, depth: 0, iterator: null }];

		try {
			// Iterate 1 extra time (less or equal `limit`) to flag the truncation
			while (stack.length && results.length <= limit) {
				const frame = stack.at(-1)!;

				// Lazily fetch children by parentId via index; avoid .collect()
				const iterator =
					frame.iterator ??
					ctx.db
						.query("pages")
						.withIndex("by_workspaceId_projectId_parentId_archiveOperationId", (q) =>
							q
								.eq("workspaceId", args.workspaceId)
								.eq("projectId", args.projectId)
								.eq("parentId", frame.parentId)
								.eq("archiveOperationId", undefined),
						)
						[Symbol.asyncIterator]();

				const iteratorItem = await iterator.next();

				// No more children at this frame or page is empty or `maxDepth` is reached
				if (iteratorItem.done) {
					stack.pop();
					// Clean up the iterator
					await iterator.return?.();

					continue;
				}

				const child = iteratorItem.value;
				const childPath =
					frame.absPath === "/"
						? `/${encode_path_segment(child.name)}`
						: `${frame.absPath}/${encode_path_segment(child.name)}`;

				// If include pattern is provided, only add items that match the glob
				if (matchesInclude(childPath)) {
					if (results.length < limit && frame.depth <= maxDepth) {
						results.push({ path: childPath, updatedAt: child.updatedAt, depthTruncated: false });
					}
					// Respect the `maxDepth` and mark the depth truncation
					else if (frame.depth > maxDepth) {
						stack.pop();
						// Clean up the iterator
						await iterator.return?.();

						const lastResult = results.at(-1);
						if (lastResult) {
							lastResult.depthTruncated = true;
						}

						continue;
					}
					// Respect `limit` and mark the truncation
					else {
						truncated = true;
						break;
					}
				}

				// Then, push the child to dive deeper first (pre-order/JSON.stringify-like walk)
				const nextDepth = frame.depth + 1;
				// less or equal `maxDepth` to allow the extra depth iteration
				if (nextDepth <= maxDepth + 1) {
					// Set frame on parent frame to resume iteration
					frame.iterator = iterator;
					stack.push({
						parentId: child._id,
						absPath: childPath,
						depth: nextDepth,
						iterator: null,
					});
				}
			}
		} finally {
			// Clean up the iterators
			await Promise.all(stack.map((frame) => frame.iterator?.return?.()).filter((x) => x != null));
		}

		return { items: results, truncated };
	},
});

export const get_page_last_available_markdown_content_by_path = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
		userId: v.string(),
	},
	returns: v.union(v.object({ content: v.string(), pageId: v.id("pages") }), v.null()),
	handler: async (ctx, args) => {
		const convexId = await resolve_id_from_path(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			path: args.path,
		});

		if (!convexId) return null;

		const page = await ctx.db.get("pages", convexId);

		if (!page) return null;
		if (page.archiveOperationId !== undefined) return null;

		if (!page.markdownContentId) {
			throw should_never_happen("page.markdownContentId is not set", {
				pageId: convexId,
				markdownContentId: page.markdownContentId,
			});
		}

		const overlay = await ctx.db
			.query("ai_chat_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("userId", args.userId as string)
					.eq("pageId", convexId),
			)
			.first();
		if (overlay) return { content: overlay.modifiedContent, pageId: convexId };

		const markdownContentDoc = await ctx.db.get("pages_markdown_content", page.markdownContentId);
		if (!markdownContentDoc) return null;

		return { content: markdownContentDoc.content, pageId: convexId };
	},
});

export const get_page_text_content_by_page_id = query({
	args: { workspaceId: v.string(), projectId: v.string(), pageId: v.id("pages") },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		return "";
	},
});

/**
 * Returns the "best available" page content without doing any heavy reconstruction work.
 *
 * We keep multiple representations of a page:
 * - `pages_markdown_content` (fast to serve to editors/search)
 * - Yjs state (`pages_yjs_snapshots` + `pages_yjs_updates`) as the source-of-truth for collaborative editing
 *
 * The key is the monotonic Yjs `sequence`:
 * - `pages_yjs_docs_last_sequences.last_sequence` is the authoritative "latest" sequence for the page
 * - `pages_markdown_content.yjs_sequence` tells us which Yjs sequence the markdown was derived from
 * - `pages_yjs_snapshots.sequence` tells us which Yjs sequence a snapshot represents
 *
 * Resolution order (stop at the first consistent option):
 * - If markdown's `yjs_sequence` matches `last_sequence`, we can safely return markdown (cheap and already rendered).
 * - Otherwise, if the stored Yjs snapshot's `sequence` matches `last_sequence`, return the snapshot (caller can decode).
 * - Otherwise, return the snapshot plus all incremental Yjs updates so the caller can reconstruct the latest state.
 *
 * Any missing/unauthorized docs cause an early `null` return.
 */
export const try_get_markdown_content_or_fallback_to_yjs_data = query({
	args: { workspaceId: v.string(), projectId: v.string(), pageId: v.id("pages") },
	handler: async (ctx, args) => {
		let result;
		do {
			const page = await ctx.db.get("pages", args.pageId).then((page) => {
				if (!page || page.workspaceId !== args.workspaceId || page.projectId !== args.projectId) return null;
				return page;
			});

			if (!page || !page.markdownContentId || !page.yjsLastSequenceId) {
				throw should_never_happen("page.markdownContentId or page.yjsLastSequenceId is not set", {
					pageId: args.pageId,
					markdownContentId: page?.markdownContentId,
					yjsLastSequenceId: page?.yjsLastSequenceId,
				});
			}

			const [lastYjsSequenceDoc, markdownContentDoc] = await Promise.all([
				ctx.db.get("pages_yjs_docs_last_sequences", page.yjsLastSequenceId).then((doc) => {
					if (!doc || doc.workspace_id !== args.workspaceId || doc.project_id !== args.projectId) return null;
					return doc;
				}),
				ctx.db.get("pages_markdown_content", page.markdownContentId).then((doc) => {
					if (!doc || doc.workspace_id !== args.workspaceId || doc.project_id !== args.projectId) return null;
					return doc;
				}),
			]);

			if (!lastYjsSequenceDoc || !markdownContentDoc) {
				throw should_never_happen("lastYjsSequenceDoc or markdownContentDoc is not valorized", {
					pageId: args.pageId,
					lastYjsSequenceDoc: lastYjsSequenceDoc,
					markdownContentDoc: markdownContentDoc,
				});
			}

			if (markdownContentDoc.yjs_sequence === lastYjsSequenceDoc.last_sequence) {
				result = {
					kind: "markdown_content" as const,
					markdownContentDoc,
				};
				break;
			}

			if (!page.yjsSnapshotId) {
				throw should_never_happen("page.yjsSnapshotId is not set", {
					pageId: args.pageId,
					yjsSnapshotId: page.yjsSnapshotId,
				});
			}

			const yjsSnapshotDoc = await ctx.db.get("pages_yjs_snapshots", page.yjsSnapshotId).then((doc) => {
				if (!doc || doc.workspace_id !== args.workspaceId || doc.project_id !== args.projectId) return null;
				return doc;
			});

			if (!yjsSnapshotDoc) {
				throw should_never_happen("yjsSnapshotDoc is not valorized", {
					pageId: args.pageId,
					yjsSnapshotDoc: yjsSnapshotDoc,
				});
			}

			if (yjsSnapshotDoc.sequence === lastYjsSequenceDoc.last_sequence) {
				result = {
					kind: "yjs_snapshot" as const,
					yjsSnapshotDoc,
				};
				break;
			}

			const yjsUpdatesDocs = await ctx.db
				.query("pages_yjs_updates")
				.withIndex("by_workspace_project_page_id_sequence", (q) =>
					q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
				)
				.order("asc")
				.collect();

			if (yjsUpdatesDocs.length === 0) {
				throw should_never_happen(
					"yjsUpdatesDocs are empty even though the last sequence does not match the snapshot sequence",
					{
						pageId: args.pageId,
						yjsUpdatesDocs: yjsUpdatesDocs,
					},
				);
			}

			result = {
				kind: "yjs_snapshots_with_incremental_updates" as const,
				yjsSnapshotDoc,
				yjsUpdatesDocs,
			};
		} while (0);

		return result;
	},
});

export const get_page_last_yjs_sequence = query({
	args: { workspaceId: v.string(), projectId: v.string(), pageId: v.id("pages") },
	returns: v.union(v.object({ last_sequence: v.number() }), v.null()),
	handler: async (ctx, args) => {
		const page = await ctx.db.get("pages", args.pageId).then((page) => {
			if (!page || page.workspaceId !== args.workspaceId || page.projectId !== args.projectId) return null;
			return page;
		});

		if (!page) {
			return null;
		}

		if (!page.yjsLastSequenceId) {
			throw should_never_happen("page.yjsLastSequenceId is not set", {
				pageId: args.pageId,
				yjsLastSequenceId: page.yjsLastSequenceId,
			});
		}

		const lastYjsSequenceDoc = await ctx.db.get("pages_yjs_docs_last_sequences", page.yjsLastSequenceId).then((doc) => {
			if (!doc || doc.workspace_id !== args.workspaceId || doc.project_id !== args.projectId) return null;
			return doc;
		});

		if (!lastYjsSequenceDoc) {
			throw should_never_happen("lastYjsSequenceDoc is not valorized", {
				pageId: args.pageId,
				yjsLastSequenceId: page.yjsLastSequenceId,
			});
		}

		return { last_sequence: lastYjsSequenceDoc.last_sequence };
	},
});

export const text_search_pages = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		query: v.string(),
		limit: v.number(),
		userId: v.string(),
	},
	returns: v.object({
		items: v.array(
			v.object({
				path: v.string(),
				preview: v.string(),
			}),
		),
	}),
	handler: async (ctx, args): Promise<{ items: Array<{ path: string; preview: string }> }> => {
		const matches = await ctx.db
			.query("pages_markdown_content")
			.withSearchIndex("search_by_content", (q) =>
				q
					.search("content", args.query)
					.eq("workspace_id", args.workspaceId)
					.eq("project_id", args.projectId)
					.eq("is_archived", false),
			)
			.take(Math.max(1, Math.min(100, args.limit)));

		const items: Array<{ path: string; preview: string }> = await Promise.all(
			matches.map(async (page): Promise<{ path: string; preview: string }> => {
				const pageDoc = await ctx.db.get("pages", page.page_id);
				if (!pageDoc || pageDoc.workspaceId !== args.workspaceId || pageDoc.projectId !== args.projectId) {
					return { path: "/", preview: page.content.slice(0, 160) };
				}
				const pending = await ctx.db
					.query("ai_chat_pending_edits")
					.withIndex("by_workspace_project_user_page", (q) =>
						q
							.eq("workspaceId", args.workspaceId)
							.eq("projectId", args.projectId)
							.eq("userId", args.userId)
							.eq("pageId", page.page_id),
					)
					.first();
				const preview = (pending?.modifiedContent ?? page.content).slice(0, 160);
				return { path: pageDoc.path, preview };
			}),
		);

		return { items };
	},
});

export const create_page_by_path = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		path: v.string(),
		userId: v.string(),
	},
	returns: v.union(
		v.object({ _yay: v.object({ pageId: v.id("pages") }) }),
		v.object({ _nay: v.object({ name: v.string(), message: v.string() }) }),
	),
	handler: async (ctx, args) => {
		const { workspaceId, projectId } = args;
		const path = args.path.trim();
		const segments = path_extract_segments_from(path);

		let currentParent: Doc<"pages">["parentId"] = pages_ROOT_ID;
		let lastPageId: Id<"pages"> | null = null;

		for (let i = 0; i < segments.length; i++) {
			const name = segments[i];

			// Does this segment exist?
			const existing = await ctx.db
				.query("pages")
				.withIndex("by_workspaceId_projectId_parentId_name", (q) =>
					q.eq("workspaceId", workspaceId).eq("projectId", projectId).eq("parentId", currentParent).eq("name", name),
				)
				.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
				.first();

			if (!existing) {
				// Create missing segment
				const page = await do_create_page(ctx, {
					workspaceId: workspaceId,
					projectId: projectId,
					parentId: currentParent,
					name: name,
					markdown_content: "",
				});

				if (page._nay) {
					return page;
				}

				currentParent = page._yay;
				lastPageId = page._yay;
			} else {
				// Continue traversal
				currentParent = existing._id;
				lastPageId = existing._id;

				// If it's the leaf and exists already, we should not create; caller decides overwrite path.
				if (i === segments.length - 1) {
					return Result({ _yay: { pageId: lastPageId } });
				}
			}
		}

		if (!lastPageId) {
			throw should_never_happen("lastPageId not resolved after page creation");
		}

		return Result({ _yay: { pageId: lastPageId } });
	},
});

export const ensure_home_page = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
	},
	returns: v.union(
		v.object({ _yay: v.object({ pageId: v.id("pages") }) }),
		v.object({ _nay: v.object({ name: v.string(), message: v.string() }) }),
	),
	handler: async (ctx, args) => {
		// Find homepage (empty name under root)
		const homepage = await ctx.db
			.query("pages")
			.withIndex("by_workspaceId_projectId_parentId_name", (q) =>
				q
					.eq("workspaceId", args.workspaceId)
					.eq("projectId", args.projectId)
					.eq("parentId", pages_ROOT_ID)
					.eq("name", ""),
			)
			.filter((q) => q.eq(q.field("archiveOperationId"), undefined))
			.first();

		if (homepage) {
			return Result({ _yay: { pageId: homepage._id } });
		}

		// Create homepage with empty name
		const result = await do_create_page(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: pages_ROOT_ID,
			name: "",
			markdown_content: "",
		});

		if (result._nay) {
			return result;
		}

		return Result({ _yay: { pageId: result._yay } });
	},
});

// Shared helper for snapshot creation
const store_version_snapshot_args_schema = v.object({
	workspace_id: v.string(),
	project_id: v.string(),
	page_id: v.id("pages"),
	content: v.string(),
	created_by: v.id("users"),
});

export const get_page_snapshots_list = query({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.id("pages"),
		show_archived: v.boolean(),
	},
	returns: v.object({
		snapshots: v.array(doc(app_convex_schema, "pages_snapshots")),
		usersDict: v.record(
			v.id("users"),
			v.object({
				_id: v.id("users"),
				displayName: v.string(),
			}),
		),
	}),
	handler: async (ctx, args) => {
		let snapshotsQuery = ctx.db
			.query("pages_snapshots")
			.withIndex("by_page_id", (q) => q.eq("page_id", args.page_id))
			.order("desc");

		// Filter only not archived snapshots if show_archived is falsy
		if (!args.show_archived) {
			snapshotsQuery = snapshotsQuery.filter((q) => q.eq(q.field("is_archived"), false));
		}

		const snapshots = await snapshotsQuery.collect();

		const usersDict: Record<Id<"users">, { _id: Id<"users">; displayName: string }> = {};

		const uniqueUserIds = Array.from(new Set(snapshots.map((s) => s.created_by)));
		const usersWithAnagraphics = await Promise.all(
			uniqueUserIds.map((userId) => ctx.runQuery(internal.users.get_with_anagraphic, { userId })),
		);

		for (const userWithAnagraphic of usersWithAnagraphics) {
			if (!userWithAnagraphic || !userWithAnagraphic.anagraphic) continue;

			usersDict[userWithAnagraphic.user._id] = {
				_id: userWithAnagraphic.user._id,
				displayName: userWithAnagraphic.anagraphic.displayName,
			};
		}

		return {
			snapshots,
			usersDict,
		};
	},
});

async function do_get_page_snapshot_content(
	ctx: QueryCtx,
	args: { workspace_id: string; project_id: string; page_snapshot_id: Id<"pages_snapshots"> },
) {
	const content = await ctx.db
		.query("pages_snapshots_contents")
		.withIndex("by_workspace_project_page_snapshot_id", (q) =>
			q
				.eq("workspace_id", args.workspace_id)
				.eq("project_id", args.project_id)
				.eq("page_snapshot_id", args.page_snapshot_id),
		)
		.first();

	if (!content) {
		return null;
	}

	const snapshot = await ctx.db.get("pages_snapshots", args.page_snapshot_id);
	if (!snapshot) {
		return null;
	}

	const usersDict: Record<Id<"users">, { _id: Id<"users">; displayName: string }> = {};
	const user = await ctx.db.get("users", snapshot.created_by);
	const anagraphic = user?.anagraphic ? await ctx.db.get("users_anagraphics", user.anagraphic) : null;
	if (user && anagraphic) {
		usersDict[user._id] = { _id: user._id, displayName: anagraphic.displayName };
	}

	return {
		content: content.content,
		page_snapshot_id: content.page_snapshot_id,
		_creationTime: content._creationTime,
		created_by: snapshot.created_by,
		usersDict,
	};
}

export const get_page_snapshot_content = query({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_id: v.id("pages"),
		page_snapshot_id: v.id("pages_snapshots"),
	},
	returns: v.union(
		v.object({
			content: v.string(),
			page_snapshot_id: v.id("pages_snapshots"),
			_creationTime: v.number(),
			created_by: v.id("users"),
			usersDict: v.record(
				v.id("users"),
				v.object({
					_id: v.id("users"),
					displayName: v.string(),
				}),
			),
		}),
		v.null(),
	),
	handler: do_get_page_snapshot_content,
});

export const archive_snapshot = mutation({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_snapshot_id: v.id("pages_snapshots"),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch("pages_snapshots", args.page_snapshot_id, {
			is_archived: true,
		});
	},
});

export const unarchive_snapshot = mutation({
	args: {
		workspace_id: v.string(),
		project_id: v.string(),
		page_snapshot_id: v.id("pages_snapshots"),
	},
	handler: async (ctx, args) => {
		await ctx.db.patch("pages_snapshots", args.page_snapshot_id, {
			is_archived: false,
		});
	},
});

function yjs_merge_updates_to_array_buffer(updates: Uint8Array[]) {
	return pages_u8_to_array_buffer(mergeUpdates(updates));
}

function yjs_create_state_update_from_tiptap_editor(args: { tiptapEditor: Editor }) {
	const yjsDoc = pages_yjs_doc_create_from_tiptap_editor({
		tiptapEditor: args.tiptapEditor,
	});
	return encodeStateAsUpdate(yjsDoc);
}

function yjs_compute_diff_update_with_headless_tiptap_editor(args: {
	pageYjsData: Doc<"pages_yjs_snapshots">;
	headlessEditorWithUpdatedContent: Editor;
	opKind: "snapshot-restore" | "user-edit";
}) {
	const yjsDoc = pages_yjs_doc_create_from_array_buffer_update(args.pageYjsData.snapshot_update);
	const yjsBeforeStateVector = encodeStateVector(yjsDoc);

	pages_yjs_doc_update_from_tiptap_editor({
		mut_yjsDoc: yjsDoc,
		tiptapEditor: args.headlessEditorWithUpdatedContent,
		opKind: args.opKind,
	});

	// TODO: there's a small performance improvement that can be achieved by listening for updates events from ydoc
	const diffUpdate = pages_yjs_compute_diff_update_from_state_vector({ yjsDoc, yjsBeforeStateVector });

	return diffUpdate;
}

async function write_markdown_to_yjs_sync(
	ctx: MutationCtx,
	args: {
		workspaceId: string;
		projectId: string;
		userId: string;
		pageId: Id<"pages">;
		markdownContent: string;
		sessionId: string;
		pageSnapshotId: Id<"pages_snapshots">;
	},
) {
	// Reconstruct the latest Y.Doc from last snapshot
	const pageYjsData = await ctx.db
		.query("pages_yjs_snapshots")
		.withIndex("by_workspace_project_page_id_sequence", (q) =>
			q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
		)
		.order("desc")
		.first();

	if (!pageYjsData) {
		return;
	}

	// Convert markdown to TipTap JSON
	const headlessEditor = pages_headless_tiptap_editor_create({
		initialContent: { markdown: args.markdownContent },
	});

	if (headlessEditor._nay) {
		throw should_never_happen("Could not create headless editor from markdown content", {
			pageId: args.pageId,
			nay: headlessEditor._nay,
		});
	}

	const diffUpdate = yjs_compute_diff_update_with_headless_tiptap_editor({
		pageYjsData,
		headlessEditorWithUpdatedContent: headlessEditor._yay,
		opKind: "snapshot-restore",
	});

	if (!diffUpdate) {
		return;
	}

	const newSnapshotUpdate = yjs_merge_updates_to_array_buffer([
		new Uint8Array(pageYjsData.snapshot_update),
		diffUpdate,
	]);

	const newSequenceData = await yjs_increment_or_create_last_sequence(ctx, {
		workspaceId: args.workspaceId,
		projectId: args.projectId,
		pageId: args.pageId,
	});

	await Promise.all([
		ctx.db.insert("pages_yjs_updates", {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: args.pageId,
			sequence: newSequenceData.last_sequence,
			update: pages_u8_to_array_buffer(diffUpdate),
			origin: {
				type: "USER_SNAPSHOT_RESTORE",
				snapshot_id: args.pageSnapshotId,
			},
			created_by: args.userId,
			created_at: Date.now(),
		}),

		ctx.db.patch("pages_yjs_snapshots", pageYjsData._id, {
			sequence: newSequenceData.last_sequence,
			snapshot_update: newSnapshotUpdate,
			updated_at: Date.now(),
			updated_by: args.userId,
		}),
	]);
}

export const yjs_get_doc_last_snapshot = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
	},
	returns: v.union(doc(app_convex_schema, "pages_yjs_snapshots"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("pages_yjs_snapshots")
			.withIndex("by_workspace_project_page_id_sequence", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.order("desc")
			.first();
	},
});

export const yjs_snapshot_updates = internalMutation({
	args: {
		userId: v.id("users"),
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
	},
	returns: v.union(
		v.object({ _nay: v.object({ name: v.string(), message: v.string() }) }),
		v.object({ _yay: v.null() }),
	),
	handler: async (ctx, args) => {
		const cleanScheduleLocksPromise = ctx.db
			.query("pages_yjs_snapshot_schedules")
			.withIndex("by_page_id", (q) => q.eq("page_id", args.pageId))
			.collect()
			.then((scheduleLocks) =>
				Promise.all(scheduleLocks.map((schedule) => ctx.db.delete("pages_yjs_snapshot_schedules", schedule._id))),
			);

		try {
			const now = Date.now();

			const page = await ctx.db.get("pages", args.pageId);
			if (
				!page ||
				page.workspaceId !== args.workspaceId ||
				page.projectId !== args.projectId ||
				!page.markdownContentId
			) {
				throw should_never_happen("page not found", {
					pageId: args.pageId,
					page: page,
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					markdownContentId: page?.markdownContentId,
				});
			}

			// Load latest snapshot
			const yjsSnapshotData = await ctx.db
				.query("pages_yjs_snapshots")
				.withIndex("by_workspace_project_page_id_sequence", (q) =>
					q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
				)
				.order("desc")
				.first();

			if (!yjsSnapshotData) {
				throw should_never_happen(
					"yjs_snapshot_data or last_sequence_data are null.\n" + //
						"The job should start only if the last sequence exists and is greater than 0\n" + //
						"and only if the yjs snapshot data already exists, the snapshot data should\n" + //
						"be created with the page",
				);
			}

			// Fetch updates since snapshot up to uptoSeq
			const updateDataList = await ctx.db
				.query("pages_yjs_updates")
				.withIndex("by_workspace_project_page_id_sequence", (q) =>
					q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
				)
				.order("asc")
				.collect();

			const lastUpdate = updateDataList.at(-1);
			const sequence = lastUpdate ? lastUpdate.sequence : yjsSnapshotData.sequence;

			// merge last snapshot update with all incremental updates into a single update blob
			const snapshotUpdate = yjs_merge_updates_to_array_buffer([
				new Uint8Array(yjsSnapshotData.snapshot_update),
				...updateDataList.map((u) => new Uint8Array(u.update)),
			]);

			const yjsDoc = pages_yjs_doc_create_from_array_buffer_update(snapshotUpdate);
			const markdown = pages_yjs_doc_get_markdown({ yjsDoc });

			if (markdown._nay) {
				return markdown;
			}

			await Promise.all([
				// Write new snapshot row (append-only)
				ctx.db.patch("pages_yjs_snapshots", yjsSnapshotData._id, {
					sequence,
					snapshot_update: snapshotUpdate,
					updated_by: "system",
					updated_at: now,
				}),

				// Prune compacted updates
				...updateDataList.map((updateData) => ctx.db.delete("pages_yjs_updates", updateData._id)),

				ctx.db.patch("pages_markdown_content", page.markdownContentId, {
					content: markdown._yay,
					yjs_sequence: sequence,
					updated_by: "system",
					updated_at: now,
				}),

				store_version_snapshot(ctx, {
					workspace_id: args.workspaceId,
					project_id: args.projectId,
					page_id: args.pageId,
					content: markdown._yay,
					created_by: args.userId,
				}),
			]);

			return Result({ _yay: null });
		} finally {
			await cleanScheduleLocksPromise;
		}
	},
});

async function yjs_increment_or_create_last_sequence(
	ctx: MutationCtx,
	args: { workspaceId: string; projectId: string; pageId: Id<"pages"> },
) {
	let lastSequenceData = await ctx.db
		.query("pages_yjs_docs_last_sequences")
		.withIndex("by_workspace_project_page_id", (q) =>
			q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
		)
		.order("desc")
		.first();

	const newSequence = lastSequenceData ? lastSequenceData.last_sequence + 1 : 0;

	// Update or create last_sequence tracking
	if (lastSequenceData) {
		await ctx.db.patch("pages_yjs_docs_last_sequences", lastSequenceData._id, { last_sequence: newSequence });
		lastSequenceData.last_sequence = newSequence;
	} else {
		const lastSequenceDataId = await ctx.db.insert("pages_yjs_docs_last_sequences", {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: args.pageId,
			last_sequence: 0,
		});
		lastSequenceData = (await ctx.db.get("pages_yjs_docs_last_sequences", lastSequenceDataId))!;
	}

	return lastSequenceData;
}

export const yjs_push_update = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		update: v.bytes(),
		sessionId: v.string(),
	},
	returns: v.union(
		v.null(),
		v.object({
			newSequence: v.number(),
		}),
	),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);
		const now = Date.now();

		const newSequenceData = await yjs_increment_or_create_last_sequence(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			pageId: args.pageId,
		});

		await ctx.db.insert("pages_yjs_updates", {
			workspace_id: args.workspaceId,
			project_id: args.projectId,
			page_id: args.pageId,
			sequence: newSequenceData.last_sequence,
			update: args.update,
			origin: {
				type: "USER_EDIT",
				session_id: args.sessionId,
			},
			created_by: user.name,
			created_at: now,
		});

		const snapshotScheduleDelayMs =
			newSequenceData.last_sequence > 0 && newSequenceData.last_sequence % 50 === 0 ? 0 : 30_000;

		const schedules = await ctx.db
			.query("pages_yjs_snapshot_schedules")
			.withIndex("by_page_id", (q) => q.eq("page_id", args.pageId))
			.collect();

		const scheduledId = await ctx.scheduler.runAfter(
			snapshotScheduleDelayMs,
			internal.ai_docs_temp.yjs_snapshot_updates,
			{
				userId: user.id,
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				pageId: args.pageId,
			},
		);

		await Promise.all([
			schedules[0]
				? ctx.db.patch("pages_yjs_snapshot_schedules", schedules[0]._id, { scheduled_function_id: scheduledId })
				: ctx.db.insert("pages_yjs_snapshot_schedules", { page_id: args.pageId, scheduled_function_id: scheduledId }),
			...schedules.slice(1).map((schedule) => ctx.db.delete("pages_yjs_snapshot_schedules", schedule._id)),
		]);

		return { newSequence: newSequenceData.last_sequence };
	},
});

export const yjs_get_incremental_updates = query({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
	},
	returns: v.union(
		v.object({
			updates: v.array(doc(app_convex_schema, "pages_yjs_updates")),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const updates = await ctx.db
			.query("pages_yjs_updates")
			.withIndex("by_workspace_project_page_id_sequence", (q) =>
				q.eq("workspace_id", args.workspaceId).eq("project_id", args.projectId).eq("page_id", args.pageId),
			)
			.order("desc")
			.collect();

		if (updates.length === 0) {
			return null;
		}

		return { updates };
	},
});

async function store_version_snapshot(ctx: MutationCtx, args: Infer<typeof store_version_snapshot_args_schema>) {
	// Create snapshot entry
	const snapshotId = await ctx.db.insert("pages_snapshots", {
		workspace_id: args.workspace_id,
		project_id: args.project_id,
		page_id: args.page_id,
		created_by: args.created_by,
		is_archived: false,
	});

	// Create content entry
	await ctx.db.insert("pages_snapshots_contents", {
		workspace_id: args.workspace_id,
		project_id: args.project_id,
		page_snapshot_id: snapshotId,
		content: args.content,
		page_id: args.page_id,
	});

	return snapshotId;
}

export const restore_snapshot = mutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		pageId: v.id("pages"),
		pageSnapshotId: v.id("pages_snapshots"),
		sessionId: v.string(),
		currentMarkdownContent: v.string(),
	},
	returns: v.union(
		v.object({
			_yay: v.null(),
		}),
		v.object({
			_nay: v.object({
				name: v.string(),
				message: v.string(),
			}),
		}),
	),
	handler: async (ctx, args) => {
		const user = await server_convex_get_user_fallback_to_anonymous(ctx);

		const [snapshotContent, page] = await Promise.all([
			do_get_page_snapshot_content(ctx, {
				workspace_id: args.workspaceId,
				project_id: args.projectId,
				page_snapshot_id: args.pageSnapshotId,
			}),
			ctx.db.get("pages", args.pageId).then((doc) => {
				if (!doc || doc.workspaceId !== args.workspaceId || doc.projectId !== args.projectId) return null;
				return doc;
			}),
		]);

		if (
			!snapshotContent ||
			!page ||
			!page.markdownContentId ||
			page.workspaceId !== args.workspaceId ||
			page.projectId !== args.projectId
		) {
			const msg = "Page not found";
			console.error(
				should_never_happen(msg, {
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					pageId: args.pageId,
					snapshotContentNotFound: !snapshotContent,
					pageNotFound: !page,
					markdownContentIdNotFound: !page?.markdownContentId,
				}),
			);
			return Result({
				_nay: {
					name: "nay",
					message: msg,
				},
			});
		}

		const createdBy = user.id;
		const updatedBy = user.name;
		const updatedAt = Date.now();

		// Restoring snapshots can be destructive and we defensively store
		// the current state as a backup snapshot
		// so the user can revert to it if needed.
		await Promise.all([
			// Store current state as a backup snapshot
			store_version_snapshot(ctx, {
				workspace_id: args.workspaceId,
				project_id: args.projectId,
				page_id: args.pageId,
				content: args.currentMarkdownContent,
				created_by: createdBy,
			}),

			// Store the restored content as a new snapshot
			store_version_snapshot(ctx, {
				workspace_id: args.workspaceId,
				project_id: args.projectId,
				page_id: args.pageId,
				content: snapshotContent.content,
				created_by: createdBy,
			}),

			ctx.db.patch("pages", page._id, {
				updatedBy: updatedBy,
				updatedAt: updatedAt,
			}),

			ctx.db.patch("pages_markdown_content", page.markdownContentId, {
				content: snapshotContent.content,
				updated_by: updatedBy,
				updated_at: updatedAt,
			}),

			write_markdown_to_yjs_sync(ctx, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				userId: user.name,
				pageId: args.pageId,
				markdownContent: snapshotContent.content,
				sessionId: args.sessionId,
				pageSnapshotId: args.pageSnapshotId,
			}),
		]);

		return Result({
			_yay: null,
		});
	},
});

/**
 * Internal mutation to cleanup old snapshots based on retention rules.
 * Runs daily at 5AM UTC via cron job.
 *
 * Retention rules:
 * - Older than 30 days: keep only the last snapshot for each week
 * - Older than 7 days (but <= 30 days): keep only the last snapshot for each day
 * - Older than 1 day (but <= 7 days): keep only the last snapshot each hour
 * - <= 1 day old: keep all snapshots
 */
export const cleanup_old_snapshots = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const timestamp60DaysAgo = now - 60 * 24 * 60 * 60 * 1000;

		const latestSnapshotPageIdWithTimeSlot = new Set<string>();
		const deletePromises: Array<Promise<any>> = [];

		const snapshotsToScanCursor = ctx.db
			.query("pages_snapshots")
			.withIndex("by_creation_time", (q) => q.gte("_creationTime", timestamp60DaysAgo))
			.order("desc");

		for await (const snapshot of snapshotsToScanCursor) {
			const age = now - snapshot._creationTime;
			let keepSnapshot = false;

			// If the snapshot is less than 1 day old, keep it
			if (age <= date_MS_DAY) {
				keepSnapshot = true;
			} else {
				// If the snapshot is older than 1 day, we need to determine the time slot it belongs to
				let bucketTimestamp: number;

				if (age > date_MS_DAYS_30) {
					bucketTimestamp = date_get_week_start_timestamp(snapshot._creationTime);
				} else if (age > date_MS_WEEK) {
					bucketTimestamp = date_get_day_start_timestamp(snapshot._creationTime);
				} else {
					bucketTimestamp = date_get_hour_start_timestamp(snapshot._creationTime);
				}

				// If this is the first snapshot for this time slot, it means it's the latest
				// therefore we keep it
				const snapshotTimeSlotKey = `${snapshot.page_id}::${bucketTimestamp}`;
				if (!latestSnapshotPageIdWithTimeSlot.has(snapshotTimeSlotKey)) {
					latestSnapshotPageIdWithTimeSlot.add(snapshotTimeSlotKey);
					keepSnapshot = true;
				}
			}

			if (!keepSnapshot) {
				deletePromises.push(
					// TODO: If we save the content id in the snapshot doc we can use the more efficient .get
					ctx.db
						.query("pages_snapshots_contents")
						.withIndex("by_workspace_project_page_snapshot_id", (q) =>
							q
								.eq("workspace_id", snapshot.workspace_id)
								.eq("project_id", snapshot.project_id)
								.eq("page_snapshot_id", snapshot._id),
						)
						.first()
						.then((content) => content && ctx.db.delete("pages_snapshots_contents", content._id)),
					ctx.db.delete("pages_snapshots", snapshot._id),
				);
			}
		}

		await Promise.all(deletePromises);

		return null;
	},
});

export function pages_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path = "/api/ai-docs-temp/contextual-prompt" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						const bodyValidator = z.object({
							prompt: z.string(),
							option: z.string().optional(),
							command: z.string().optional(),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							try {
								const body = await server_request_json_parse_and_validate(request, bodyValidator);
								if (body._nay) {
									return {
										status: 400,
										body: body._nay,
									} as const;
								}

								const { prompt, option, command } = body._yay;

								if (!prompt || typeof prompt !== "string") {
									return {
										status: 400,
										body: {
											message: "Invalid prompt",
										},
									} as const;
								}

								// Create appropriate system and user prompts based on option (matching liveblocks pattern)
								let systemPrompt = "";
								let userPrompt = "";

								switch (option) {
									case "continue":
										systemPrompt =
											"You are an AI writing assistant that continues existing text based on context from prior text. " +
											"Give more weight/priority to the later characters than the beginning ones. " +
											"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = prompt;
										break;
									case "improve":
										systemPrompt =
											"You are an AI writing assistant that improves existing text. " +
											"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = `The existing text is: ${prompt}`;
										break;
									case "shorter":
										systemPrompt =
											"You are an AI writing assistant that shortens existing text. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = `The existing text is: ${prompt}`;
										break;
									case "longer":
										systemPrompt =
											"You are an AI writing assistant that lengthens existing text. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = `The existing text is: ${prompt}`;
										break;
									case "fix":
										systemPrompt =
											"You are an AI writing assistant that fixes grammar and spelling errors in existing text. " +
											"Limit your response to no more than 200 characters, but make sure to construct complete sentences. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = `The existing text is: ${prompt}`;
										break;
									case "zap":
										systemPrompt =
											"You area an AI writing assistant that generates text based on a prompt. " +
											"You take an input from the user and a command for manipulating the text. " +
											"Use Markdown formatting when appropriate.";
										userPrompt = `For this text: ${prompt}. You have to respect the command: ${command}`;
										break;
									default:
										systemPrompt =
											"You are an AI writing assistant. Help with the given text based on the user's needs.";
										userPrompt = command ? `${command}\n\nText: ${prompt}` : `Continue this text:\n\n${prompt}`;
								}

								// Generate streaming completion using AI SDK v5 UI message stream response
								const result = streamText({
									model: openai("gpt-5-mini"),
									system: systemPrompt,
									messages: [
										{
											role: "user",
											content: userPrompt,
										},
									],
									temperature: 0.7,
									maxOutputTokens: 500,
									experimental_transform: smoothStream({
										delayInMs: 100,
									}),
								});

								return {
									status: 200,
									body: result,
								} as const;
							} catch (error: unknown) {
								console.error("AI generation error:", error);
								return {
									status: 500,
									body: {
										message: error instanceof Error ? error.message : "Internal server error",
									},
								} as const;
							}
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);

								if (result.status === 200) {
									return result.body.toUIMessageStreamResponse({
										onError: (error) => {
											console.error("AI generation error:", error);
											return error instanceof Error ? error.message : String(error);
										},
									});
								}

								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
