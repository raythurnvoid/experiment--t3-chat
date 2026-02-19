import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { encode_path_segment } from "../server/server-utils.ts";

const delete_all_archived_pages_returns_validator = v.object({
	pages: v.number(),
	pages_markdown_content: v.number(),
	pages_yjs_snapshots: v.number(),
	pages_yjs_updates: v.number(),
	pages_yjs_docs_last_sequences: v.number(),
	pages_yjs_snapshot_schedules: v.number(),
	pages_snapshots: v.number(),
	pages_snapshots_contents: v.number(),
	ai_chat_pending_edits: v.number(),
});

const audit_active_duplicate_materialized_paths_returns_validator = v.object({
	scannedActivePages: v.number(),
	duplicateGroups: v.array(
		v.object({
			workspaceId: v.string(),
			projectId: v.string(),
			path: v.string(),
			pageIds: v.array(v.id("pages")),
		}),
	),
});

const unset_pages_is_archived_flags_returns_validator = v.object({
	scanned: v.number(),
	patched: v.number(),
});

/**
 * Compatibility migration for the rollout phase where `pages.isArchived` is still optional.
 *
 * Run this before dropping `isArchived` from the schema.
 */
async function unset_pages_is_archived_flags_fn(ctx: MutationCtx) {
	const pages = await ctx.db.query("pages").collect();
	let patched = 0;

	for (const page of pages) {
		if (!Object.prototype.hasOwnProperty.call(page as Record<string, unknown>, "isArchived")) {
			continue;
		}

		await ctx.db.patch("pages", page._id, {
			["isArchived"]: undefined,
		} as unknown as Partial<Doc<"pages">>);
		patched += 1;
	}

	return {
		scanned: pages.length,
		patched,
	};
}

async function delete_all_archived_pages_and_linked_rows(ctx: MutationCtx) {
	const archivedPages = (await ctx.db.query("pages").collect()).filter((page) => page.archiveOperationId !== undefined);
	if (archivedPages.length === 0) {
		return {
			pages: 0,
			pages_markdown_content: 0,
			pages_yjs_snapshots: 0,
			pages_yjs_updates: 0,
			pages_yjs_docs_last_sequences: 0,
			pages_yjs_snapshot_schedules: 0,
			pages_snapshots: 0,
			pages_snapshots_contents: 0,
			ai_chat_pending_edits: 0,
		};
	}

	const counts = {
		pages: 0,
		pages_markdown_content: 0,
		pages_yjs_snapshots: 0,
		pages_yjs_updates: 0,
		pages_yjs_docs_last_sequences: 0,
		pages_yjs_snapshot_schedules: 0,
		pages_snapshots: 0,
		pages_snapshots_contents: 0,
		ai_chat_pending_edits: 0,
	};

	for (const page of archivedPages) {
		const [
			pageMarkdownContentRow,
			pageYjsSnapshotRows,
			pageYjsUpdateRows,
			pageYjsLastSequenceRows,
			pageYjsSnapshotScheduleRows,
			pageSnapshotRows,
			pagePendingEditsRows,
		] = await Promise.all([
			page.markdownContentId ? ctx.db.get("pages_markdown_content", page.markdownContentId) : null,
			ctx.db
				.query("pages_yjs_snapshots")
				.withIndex("by_workspace_project_page_id_sequence", (q) =>
					q.eq("workspace_id", page.workspaceId).eq("project_id", page.projectId).eq("page_id", page._id),
				)
				.collect(),
			ctx.db
				.query("pages_yjs_updates")
				.withIndex("by_workspace_project_page_id_sequence", (q) =>
					q.eq("workspace_id", page.workspaceId).eq("project_id", page.projectId).eq("page_id", page._id),
				)
				.collect(),
			ctx.db
				.query("pages_yjs_docs_last_sequences")
				.withIndex("by_workspace_project_page_id", (q) =>
					q.eq("workspace_id", page.workspaceId).eq("project_id", page.projectId).eq("page_id", page._id),
				)
				.collect(),
			ctx.db
				.query("pages_yjs_snapshot_schedules")
				.withIndex("by_page_id", (q) => q.eq("page_id", page._id))
				.collect(),
			ctx.db
				.query("pages_snapshots")
				.withIndex("by_page_id", (q) => q.eq("page_id", page._id))
				.collect(),
			ctx.db
				.query("ai_chat_pending_edits")
				.withIndex("by_workspace_project_user_page", (q) =>
					q.eq("workspaceId", page.workspaceId).eq("projectId", page.projectId),
				)
				.collect()
				.then((rows) => rows.filter((row) => row.pageId === page._id)),
		]);

		const pageSnapshotContentRowsNested = await Promise.all(
			pageSnapshotRows.map((row) =>
				ctx.db
					.query("pages_snapshots_contents")
					.withIndex("by_workspace_project_page_snapshot_id", (q) =>
						q.eq("workspace_id", page.workspaceId).eq("project_id", page.projectId).eq("page_snapshot_id", row._id),
					)
					.collect(),
			),
		);
		const snapshotLinkedContents = pageSnapshotContentRowsNested.flat();

		await Promise.all([
			...(pageMarkdownContentRow ? [ctx.db.delete("pages_markdown_content", pageMarkdownContentRow._id)] : []),
			...pageYjsSnapshotRows.map((row) => ctx.db.delete("pages_yjs_snapshots", row._id)),
			...pageYjsUpdateRows.map((row) => ctx.db.delete("pages_yjs_updates", row._id)),
			...pageYjsLastSequenceRows.map((row) => ctx.db.delete("pages_yjs_docs_last_sequences", row._id)),
			...pageYjsSnapshotScheduleRows.map((row) => ctx.db.delete("pages_yjs_snapshot_schedules", row._id)),
			...snapshotLinkedContents.map((row) => ctx.db.delete("pages_snapshots_contents", row._id)),
			...pageSnapshotRows.map((row) => ctx.db.delete("pages_snapshots", row._id)),
			...pagePendingEditsRows.map((row) => ctx.db.delete("ai_chat_pending_edits", row._id)),
		]);

		await ctx.db.delete("pages", page._id);

		counts.pages += 1;
		counts.pages_markdown_content += pageMarkdownContentRow ? 1 : 0;
		counts.pages_yjs_snapshots += pageYjsSnapshotRows.length;
		counts.pages_yjs_updates += pageYjsUpdateRows.length;
		counts.pages_yjs_docs_last_sequences += pageYjsLastSequenceRows.length;
		counts.pages_yjs_snapshot_schedules += pageYjsSnapshotScheduleRows.length;
		counts.pages_snapshots += pageSnapshotRows.length;
		counts.pages_snapshots_contents += snapshotLinkedContents.length;
		counts.ai_chat_pending_edits += pagePendingEditsRows.length;
	}

	return counts;
}

function pages_materialized_path_join(parentPath: string, pageName: string) {
	if (parentPath === "/") {
		const encodedName = encode_path_segment(pageName);
		return encodedName === "" ? "/" : `/${encodedName}`;
	}

	const encodedName = encode_path_segment(pageName);
	return encodedName === "" ? parentPath : `${parentPath}/${encodedName}`;
}

async function backfill_pages_materialized_path(ctx: MutationCtx) {
	const pages = await ctx.db.query("pages").collect();
	const pagesById = new Map<Id<"pages">, Doc<"pages">>();
	for (const page of pages) {
		pagesById.set(page._id, page);
	}

	const pathByPageId = new Map<Id<"pages">, string | null>();

	function resolve_path_for_page(pageId: Id<"pages">, visitingIds: Set<Id<"pages">>): string | null {
		const cached = pathByPageId.get(pageId);
		if (cached !== undefined) {
			return cached;
		}

		if (visitingIds.has(pageId)) {
			pathByPageId.set(pageId, null);
			return null;
		}

		const page = pagesById.get(pageId);
		if (!page) {
			pathByPageId.set(pageId, null);
			return null;
		}

		visitingIds.add(pageId);
		let pagePath: string | null;
		if (page.parentId === "root") {
			pagePath = pages_materialized_path_join("/", page.name);
		} else {
			const parentPage = pagesById.get(page.parentId);
			if (!parentPage || parentPage.workspaceId !== page.workspaceId || parentPage.projectId !== page.projectId) {
				pagePath = null;
			} else {
				const parentPath: string | null = resolve_path_for_page(parentPage._id, visitingIds);
				pagePath = parentPath ? pages_materialized_path_join(parentPath, page.name) : null;
			}
		}
		visitingIds.delete(pageId);
		pathByPageId.set(pageId, pagePath);
		return pagePath;
	}

	let patched = 0;
	let alreadyCorrect = 0;
	let skippedInvalid = 0;

	for (const page of pages) {
		const canonicalPath = resolve_path_for_page(page._id, new Set());
		if (!canonicalPath) {
			skippedInvalid += 1;
			continue;
		}

		if (page.path === canonicalPath) {
			alreadyCorrect += 1;
			continue;
		}

		await ctx.db.patch("pages", page._id, {
			path: canonicalPath,
		});
		patched += 1;
	}

	return {
		scanned: pages.length,
		patched,
		alreadyCorrect,
		skippedInvalid,
	};
}

async function audit_active_duplicate_materialized_paths_fn(ctx: MutationCtx) {
	const activePages = (await ctx.db.query("pages").collect()).filter((page) => page.archiveOperationId === undefined);
	const duplicateGroupsByKey = new Map<
		string,
		{
			workspaceId: string;
			projectId: string;
			path: string;
			pageIds: Array<Id<"pages">>;
		}
	>();

	for (const page of activePages) {
		const groupKey = `${page.workspaceId}\u0000${page.projectId}\u0000${page.path}`;
		const existingGroup = duplicateGroupsByKey.get(groupKey);
		if (existingGroup) {
			existingGroup.pageIds.push(page._id);
			continue;
		}

		duplicateGroupsByKey.set(groupKey, {
			workspaceId: page.workspaceId,
			projectId: page.projectId,
			path: page.path,
			pageIds: [page._id],
		});
	}

	const duplicateGroups = Array.from(duplicateGroupsByKey.values())
		.filter((group) => group.pageIds.length > 1)
		.sort((a, b) => {
			if (a.workspaceId !== b.workspaceId) {
				return a.workspaceId.localeCompare(b.workspaceId);
			}
			if (a.projectId !== b.projectId) {
				return a.projectId.localeCompare(b.projectId);
			}
			return a.path.localeCompare(b.path);
		});

	return {
		scannedActivePages: activePages.length,
		duplicateGroups,
	};
}

export const delete_all_archived_pages = internalMutation({
	args: {},
	returns: delete_all_archived_pages_returns_validator,
	handler: (ctx) => delete_all_archived_pages_and_linked_rows(ctx),
});

export const unset_pages_is_archived_flags = internalMutation({
	args: {},
	returns: unset_pages_is_archived_flags_returns_validator,
	handler: (ctx) => unset_pages_is_archived_flags_fn(ctx),
});

export const audit_active_duplicate_materialized_paths = internalMutation({
	args: {},
	returns: audit_active_duplicate_materialized_paths_returns_validator,
	handler: (ctx) => audit_active_duplicate_materialized_paths_fn(ctx),
});

export const migrate_pages_materialized_paths_and_delete_archived_pages = internalMutation({
	args: {},
	returns: v.object({
		pathBackfill: v.object({
			scanned: v.number(),
			patched: v.number(),
			alreadyCorrect: v.number(),
			skippedInvalid: v.number(),
		}),
		deletedArchived: delete_all_archived_pages_returns_validator,
	}),
	handler: async (ctx) => {
		const deletedArchived = await delete_all_archived_pages_and_linked_rows(ctx);
		const pathBackfill = await backfill_pages_materialized_path(ctx);
		console.info("[migrations.migrate_pages_materialized_paths_and_delete_archived_pages] success", {
			pathBackfill,
			deletedArchived,
		});
		return {
			pathBackfill,
			deletedArchived,
		};
	},
});
