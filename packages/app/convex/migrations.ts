import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { encode_path_segment } from "../server/server-utils.ts";
import { db_upsert_page_chunks } from "./ai_docs_temp.ts";

async function migrate_pages_snapshots_is_archived_to_archived_at_fn(ctx: MutationCtx) {
	const snapshots = await ctx.db.query("pages_snapshots").collect();
	let patched = 0;

	for (const snapshot of snapshots) {
		const compatSnapshot = snapshot as typeof snapshot & {
			archived_at?: number;
			is_archived?: boolean;
		};

		if (typeof compatSnapshot.archived_at === "number" && compatSnapshot.is_archived === undefined) {
			continue;
		}

		await ctx.db.patch("pages_snapshots", snapshot._id, {
			// Keep an existing archived_at value if one is already present.
			// Backfill legacy archived rows with _creationTime because the legacy
			// schema only stored a boolean and the original archive timestamp is lost.
			archived_at:
				typeof compatSnapshot.archived_at === "number"
					? compatSnapshot.archived_at
					: compatSnapshot.is_archived
						? compatSnapshot._creationTime
						: -1,
			is_archived: undefined,
		} as Partial<Doc<"pages_snapshots">> & {
			archived_at?: number;
			is_archived?: undefined;
		});
		patched += 1;
	}

	return {
		scanned: snapshots.length,
		patched,
	};
}

const delete_all_archived_pages_returns_validator = v.object({
	pages: v.number(),
	pages_markdown_content: v.number(),
	pages_pending_edits_last_sequence_saved: v.number(),
	pagesMarkdownChunks: v.number(),
	pagesPlainTextChunks: v.number(),
	pages_yjs_snapshots: v.number(),
	pages_yjs_updates: v.number(),
	pages_yjs_docs_last_sequences: v.number(),
	pages_yjs_snapshot_schedules: v.number(),
	pages_snapshots: v.number(),
	pages_snapshots_contents: v.number(),
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

/**
 * Compatibility migration for the rollout phase where
 * `workspaces_projects_users.updatedAt` is still optional.
 *
 * Run this before dropping `updatedAt` from the schema.
 */
async function unset_workspaces_projects_users_updated_at_fn(ctx: MutationCtx) {
	const projectUsers = await ctx.db.query("workspaces_projects_users").collect();
	let patched = 0;

	for (const projectUser of projectUsers) {
		if (!Object.prototype.hasOwnProperty.call(projectUser as Record<string, unknown>, "updatedAt")) {
			continue;
		}

		await ctx.db.patch("workspaces_projects_users", projectUser._id, {
			["updatedAt"]: undefined,
		} as unknown as Partial<Doc<"workspaces_projects_users">>);
		patched += 1;
	}

	return {
		scanned: projectUsers.length,
		patched,
	};
}

async function rename_default_workspaces_projects_desk_to_home_fn(ctx: MutationCtx) {
	const projects = await ctx.db.query("workspaces_projects").collect();
	let patched = 0;

	for (const project of projects) {
		if (!project.default || project.name !== "Desk") {
			continue;
		}

		await ctx.db.patch("workspaces_projects", project._id, {
			name: "Home",
		});
		patched += 1;
	}

	return {
		scanned: projects.length,
		patched,
	};
}

async function delete_all_archived_pages_and_linked_rows(ctx: MutationCtx) {
	const archivedPages = (await ctx.db.query("pages").collect()).filter((page) => page.archiveOperationId !== undefined);
	if (archivedPages.length === 0) {
		return {
			pages: 0,
			pages_markdown_content: 0,
			pages_pending_edits_last_sequence_saved: 0,
			pagesMarkdownChunks: 0,
			pagesPlainTextChunks: 0,
			pages_yjs_snapshots: 0,
			pages_yjs_updates: 0,
			pages_yjs_docs_last_sequences: 0,
			pages_yjs_snapshot_schedules: 0,
			pages_snapshots: 0,
			pages_snapshots_contents: 0,
		};
	}

	const counts = {
		pages: 0,
		pages_markdown_content: 0,
		pages_pending_edits_last_sequence_saved: 0,
		pagesMarkdownChunks: 0,
		pagesPlainTextChunks: 0,
		pages_yjs_snapshots: 0,
		pages_yjs_updates: 0,
		pages_yjs_docs_last_sequences: 0,
		pages_yjs_snapshot_schedules: 0,
		pages_snapshots: 0,
		pages_snapshots_contents: 0,
	};

	for (const page of archivedPages) {
		const [
			pageMarkdownContentRow,
			pagePendingEditLastSequenceSavedRows,
			pageMarkdownChunkRows,
			pagePlainTextChunkRows,
			pageYjsSnapshotRows,
			pageYjsUpdateRows,
			pageYjsLastSequenceRows,
			pageYjsSnapshotScheduleRows,
			pageSnapshotRows,
		] = await Promise.all([
			page.markdownContentId ? ctx.db.get("pages_markdown_content", page.markdownContentId) : null,
			ctx.db
				.query("pages_pending_edits_last_sequence_saved")
				.withIndex("by_workspace_project_page_user", (q) =>
					q.eq("workspaceId", page.workspaceId).eq("projectId", page.projectId).eq("pageId", page._id),
				)
				.collect(),
			ctx.db
				.query("pages_markdown_chunks")
				.withIndex("by_workspace_project_page_sequenceChunk", (q) =>
					q.eq("workspaceId", page.workspaceId).eq("projectId", page.projectId).eq("pageId", page._id),
				)
				.collect(),
			ctx.db
				.query("pages_plain_text_chunks")
				.withIndex("by_workspace_project_page_sequenceChunk", (q) =>
					q.eq("workspaceId", page.workspaceId).eq("projectId", page.projectId).eq("pageId", page._id),
				)
				.collect(),
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
				.withIndex("by_workspace_project_page_id_archived_at", (q) =>
					q.eq("workspace_id", page.workspaceId).eq("project_id", page.projectId).eq("page_id", page._id),
				)
				.collect(),
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
			...pagePendingEditLastSequenceSavedRows.map((row) =>
				ctx.db.delete("pages_pending_edits_last_sequence_saved", row._id),
			),
			...pagePlainTextChunkRows.map((row) => ctx.db.delete("pages_plain_text_chunks", row._id)),
			...pageMarkdownChunkRows.map((row) => ctx.db.delete("pages_markdown_chunks", row._id)),
			...pageYjsSnapshotRows.map((row) => ctx.db.delete("pages_yjs_snapshots", row._id)),
			...pageYjsUpdateRows.map((row) => ctx.db.delete("pages_yjs_updates", row._id)),
			...pageYjsLastSequenceRows.map((row) => ctx.db.delete("pages_yjs_docs_last_sequences", row._id)),
			...pageYjsSnapshotScheduleRows.map((row) => ctx.db.delete("pages_yjs_snapshot_schedules", row._id)),
			...snapshotLinkedContents.map((row) => ctx.db.delete("pages_snapshots_contents", row._id)),
			...pageSnapshotRows.map((row) => ctx.db.delete("pages_snapshots", row._id)),
		]);

		await ctx.db.delete("pages", page._id);

		counts.pages += 1;
		counts.pages_markdown_content += pageMarkdownContentRow ? 1 : 0;
		counts.pages_pending_edits_last_sequence_saved += pagePendingEditLastSequenceSavedRows.length;
		counts.pagesMarkdownChunks += pageMarkdownChunkRows.length;
		counts.pagesPlainTextChunks += pagePlainTextChunkRows.length;
		counts.pages_yjs_snapshots += pageYjsSnapshotRows.length;
		counts.pages_yjs_updates += pageYjsUpdateRows.length;
		counts.pages_yjs_docs_last_sequences += pageYjsLastSequenceRows.length;
		counts.pages_yjs_snapshot_schedules += pageYjsSnapshotScheduleRows.length;
		counts.pages_snapshots += pageSnapshotRows.length;
		counts.pages_snapshots_contents += snapshotLinkedContents.length;
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

	function resolvePathForPage(pageId: Id<"pages">, visitingIds: Set<Id<"pages">>): string | null {
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
				const parentPath: string | null = resolvePathForPage(parentPage._id, visitingIds);
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
		const canonicalPath = resolvePathForPage(page._id, new Set());
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

export const migrate_pages_snapshots_is_archived_to_archived_at = internalMutation({
	args: {},
	returns: v.object({
		scanned: v.number(),
		patched: v.number(),
	}),
	handler: (ctx) => migrate_pages_snapshots_is_archived_to_archived_at_fn(ctx),
});

export const unset_pages_is_archived_flags = internalMutation({
	args: {},
	returns: v.object({
		scanned: v.number(),
		patched: v.number(),
	}),
	handler: (ctx) => unset_pages_is_archived_flags_fn(ctx),
});

export const unset_workspaces_projects_users_updated_at = internalMutation({
	args: {},
	returns: v.object({
		scanned: v.number(),
		patched: v.number(),
	}),
	handler: (ctx) => unset_workspaces_projects_users_updated_at_fn(ctx),
});

export const rename_default_workspaces_projects_desk_to_home = internalMutation({
	args: {},
	returns: v.object({
		scanned: v.number(),
		patched: v.number(),
	}),
	handler: (ctx) => rename_default_workspaces_projects_desk_to_home_fn(ctx),
});

export const audit_active_duplicate_materialized_paths = internalMutation({
	args: {},
	returns: v.object({
		scannedActivePages: v.number(),
		duplicateGroups: v.array(
			v.object({
				workspaceId: v.string(),
				projectId: v.string(),
				path: v.string(),
				pageIds: v.array(v.id("pages")),
			}),
		),
	}),
	handler: (ctx) => audit_active_duplicate_materialized_paths_fn(ctx),
});

export const backfill_pages_chunk_rows = internalMutation({
	args: {
		limit: v.optional(v.number()),
		_errors: v.optional(
			v.object({
				message: v.literal("Failed to upsert page chunks"),
			}),
		),
	},
	returns: v.object({
		scanned: v.number(),
		rebuilt: v.number(),
		skippedArchived: v.number(),
		skippedMissingMarkdown: v.number(),
	}),
	handler: async (ctx, args) => {
		const pages = await ctx.db.query("pages").collect();
		const limit = Math.max(1, Math.min(10_000, args.limit ?? pages.length));

		let scanned = 0;
		let rebuilt = 0;
		let skippedArchived = 0;
		let skippedMissingMarkdown = 0;

		for (const page of pages) {
			if (scanned >= limit) {
				break;
			}
			scanned += 1;

			if (page.archiveOperationId !== undefined) {
				skippedArchived += 1;
				continue;
			}

			if (!page.markdownContentId) {
				skippedMissingMarkdown += 1;
				continue;
			}

			const markdownContent = await ctx.db.get("pages_markdown_content", page.markdownContentId);
			if (!markdownContent) {
				skippedMissingMarkdown += 1;
				continue;
			}

			const upsertChunksResult = await db_upsert_page_chunks(ctx, {
				workspaceId: page.workspaceId,
				projectId: page.projectId,
				pageId: page._id,
				yjsSequence: markdownContent.yjs_sequence,
				markdownContent: markdownContent.content,
			});
			if (upsertChunksResult._nay) {
				const message = "Failed to upsert page chunks" satisfies NonNullable<(typeof args)["_errors"]>["message"];
				console.error("[migrations.backfill_pages_chunk_rows] Failed to upsert page chunks", {
					message,
					upsertChunksResult,
					workspaceId: page.workspaceId,
					projectId: page.projectId,
					pageId: page._id,
					yjsSequence: markdownContent.yjs_sequence,
				});
				throw new ConvexError({
					message,
				});
			}
			rebuilt += 1;
		}

		return {
			scanned,
			rebuilt,
			skippedArchived,
			skippedMissingMarkdown,
		};
	},
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
