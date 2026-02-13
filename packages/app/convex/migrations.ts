import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";

export const delete_all_archived_pages = internalMutation({
	args: {},
	returns: v.object({
		pages: v.number(),
		pages_markdown_content: v.number(),
		pages_yjs_snapshots: v.number(),
		pages_yjs_updates: v.number(),
		pages_yjs_docs_last_sequences: v.number(),
		pages_yjs_snapshot_schedules: v.number(),
		pages_snapshots: v.number(),
		pages_snapshots_contents: v.number(),
		ai_chat_pending_edits: v.number(),
	}),
	handler: async (ctx) => {
		const archivedPages = (await ctx.db.query("pages").collect()).filter((page) => page.isArchived);
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
					.withIndex("by_workspace_project_and_page_id_and_sequence", (q) =>
						q.eq("workspace_id", page.workspaceId).eq("project_id", page.projectId).eq("page_id", page._id),
					)
					.collect(),
				ctx.db
					.query("pages_yjs_updates")
					.withIndex("by_workspace_project_and_page_id_and_sequence", (q) =>
						q.eq("workspace_id", page.workspaceId).eq("project_id", page.projectId).eq("page_id", page._id),
					)
					.collect(),
				ctx.db
					.query("pages_yjs_docs_last_sequences")
					.withIndex("by_workspace_project_and_page_id", (q) =>
						q.eq("workspace_id", page.workspaceId).eq("project_id", page.projectId).eq("page_id", page._id),
					)
					.collect(),
				ctx.db.query("pages_yjs_snapshot_schedules").withIndex("by_page_id", (q) => q.eq("page_id", page._id)).collect(),
				ctx.db.query("pages_snapshots").withIndex("by_page_id", (q) => q.eq("page_id", page._id)).collect(),
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
						.withIndex("by_workspace_project_and_page_snapshot_id", (q) =>
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
	},
});
