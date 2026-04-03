import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server.js";

const user_purge_args = {
	userId: v.optional(v.string()),
	clerkUserId: v.optional(v.string()),
} as const;

const user_purge_summary = v.object({
	lookup: v.object({
		userId: v.id("users"),
		clerkUserId: v.union(v.string(), v.null()),
		anonymousAuthTokenId: v.union(v.string(), v.null()),
		anagraphicId: v.union(v.string(), v.null()),
		defaultWorkspaceId: v.union(v.string(), v.null()),
		defaultProjectId: v.union(v.string(), v.null()),
	}),
	counts: v.object({
		users: v.number(),
		users_anon_tokens: v.number(),
		users_anagraphics: v.number(),
		limits_per_user: v.number(),
		workspaces: v.number(),
		workspaces_projects: v.number(),
		workspaces_projects_users: v.number(),
		workspaces_data_deletion_requests: v.number(),
		limits_per_workspace: v.number(),
		ai_chat_threads: v.number(),
		ai_chat_threads_messages_aisdk_5: v.number(),
		pages: v.number(),
		pages_pending_edits: v.number(),
		pages_pending_edits_last_sequence_saved: v.number(),
		pages_pending_edits_cleanup_tasks: v.number(),
		pages_markdown_content: v.number(),
		pages_markdown_chunks: v.number(),
		pages_plain_text_chunks: v.number(),
		pages_yjs_snapshots: v.number(),
		pages_yjs_updates: v.number(),
		pages_yjs_docs_last_sequences: v.number(),
		pages_yjs_snapshot_schedules: v.number(),
		pages_snapshots: v.number(),
		pages_snapshots_contents: v.number(),
		chat_messages: v.number(),
	}),
	idStrings: v.object({
		users: v.array(v.string()),
		users_anon_tokens: v.array(v.string()),
		users_anagraphics: v.array(v.string()),
		limits_per_user: v.array(v.string()),
		workspaces: v.array(v.string()),
		workspaces_projects: v.array(v.string()),
		workspaces_projects_users: v.array(v.string()),
		workspaces_data_deletion_requests: v.array(v.string()),
		limits_per_workspace: v.array(v.string()),
		ai_chat_threads: v.array(v.string()),
		ai_chat_threads_messages_aisdk_5: v.array(v.string()),
		pages: v.array(v.string()),
		pages_pending_edits: v.array(v.string()),
		pages_pending_edits_last_sequence_saved: v.array(v.string()),
		pages_pending_edits_cleanup_tasks: v.array(v.string()),
		pages_markdown_content: v.array(v.string()),
		pages_markdown_chunks: v.array(v.string()),
		pages_plain_text_chunks: v.array(v.string()),
		pages_yjs_snapshots: v.array(v.string()),
		pages_yjs_updates: v.array(v.string()),
		pages_yjs_docs_last_sequences: v.array(v.string()),
		pages_yjs_snapshot_schedules: v.array(v.string()),
		pages_snapshots: v.array(v.string()),
		pages_snapshots_contents: v.array(v.string()),
		chat_messages: v.array(v.string()),
	}),
});

function require_user_lookup_args(args: { userId?: string; clerkUserId?: string }) {
	if ((args.userId ? 1 : 0) + (args.clerkUserId ? 1 : 0) !== 1) {
		throw new Error("Provide exactly one of userId or clerkUserId");
	}
}

function sorted_id_strings(values: Iterable<string>) {
	return [...new Set(values)].sort();
}

async function resolve_user_for_purge(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId?: string;
		clerkUserId?: string;
	},
) {
	require_user_lookup_args(args);

	if (args.userId) {
		const userId = ctx.db.normalizeId("users", args.userId);
		if (!userId) {
			return null;
		}

		return await ctx.db.get("users", userId);
	}

	return await ctx.db
		.query("users")
		.withIndex("by_clerk_user_id", (q) => q.eq("clerkUserId", args.clerkUserId!))
		.first();
}

async function collect_user_rows(
	ctx: QueryCtx | MutationCtx,
	args: {
		userId?: string;
		clerkUserId?: string;
	},
) {
	const user = await resolve_user_for_purge(ctx, args);
	if (!user) {
		return null;
	}

	const userId = user._id;
	const userIdString = String(userId);

	const [
		users_anon_tokens,
		limits_per_user,
		users_anagraphics_all,
		workspaces_all,
		workspaces_projects_all,
		workspaces_projects_users_all,
		workspaces_data_deletion_requests_all,
		limits_per_workspace_all,
		ai_chat_threads_all,
		ai_chat_threads_messages_all,
		pages_all,
		pages_pending_edits_all,
		pages_pending_edits_last_sequence_saved_all,
		pages_pending_edits_cleanup_tasks_all,
		pages_markdown_content_all,
		pages_markdown_chunks_all,
		pages_plain_text_chunks_all,
		pages_yjs_snapshots_all,
		pages_yjs_updates_all,
		pages_yjs_docs_last_sequences_all,
		pages_yjs_snapshot_schedules_all,
		pages_snapshots_all,
		pages_snapshots_contents_all,
		chat_messages_all,
	] = await Promise.all([
		ctx.db
			.query("users_anon_tokens")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect(),
		ctx.db
			.query("limits_per_user")
			.withIndex("by_userId", (q) => q.eq("userId", userId))
			.collect(),
		ctx.db.query("users_anagraphics").collect(),
		ctx.db.query("workspaces").collect(),
		ctx.db.query("workspaces_projects").collect(),
		ctx.db.query("workspaces_projects_users").collect(),
		ctx.db.query("workspaces_data_deletion_requests").collect(),
		ctx.db.query("limits_per_workspace").collect(),
		ctx.db.query("ai_chat_threads").collect(),
		ctx.db.query("ai_chat_threads_messages_aisdk_5").collect(),
		ctx.db.query("pages").collect(),
		ctx.db.query("pages_pending_edits").collect(),
		ctx.db.query("pages_pending_edits_last_sequence_saved").collect(),
		ctx.db.query("pages_pending_edits_cleanup_tasks").collect(),
		ctx.db.query("pages_markdown_content").collect(),
		ctx.db.query("pages_markdown_chunks").collect(),
		ctx.db.query("pages_plain_text_chunks").collect(),
		ctx.db.query("pages_yjs_snapshots").collect(),
		ctx.db.query("pages_yjs_updates").collect(),
		ctx.db.query("pages_yjs_docs_last_sequences").collect(),
		ctx.db.query("pages_yjs_snapshot_schedules").collect(),
		ctx.db.query("pages_snapshots").collect(),
		ctx.db.query("pages_snapshots_contents").collect(),
		ctx.db.query("chat_messages").collect(),
	]);

	const users_anagraphics = users_anagraphics_all.filter((row) => row.userId === userId);
	const workspaces = workspaces_all.filter((row) => row.ownerUserId === userId);
	const workspace_id_strings = new Set(workspaces.map((row) => String(row._id)));
	const workspaces_projects = workspaces_projects_all.filter((row) =>
		workspace_id_strings.has(String(row.workspaceId)),
	);
	const workspace_project_id_strings = new Set(workspaces_projects.map((row) => String(row._id)));

	const workspaces_projects_users = workspaces_projects_users_all.filter(
		(row) =>
			row.userId === userId ||
			workspace_id_strings.has(String(row.workspaceId)) ||
			workspace_project_id_strings.has(String(row.projectId)),
	);
	const workspaces_data_deletion_requests = workspaces_data_deletion_requests_all.filter(
		(row) =>
			workspace_id_strings.has(String(row.workspaceId)) || workspace_project_id_strings.has(String(row.projectId)),
	);
	const limits_per_workspace = limits_per_workspace_all.filter((row) =>
		workspace_id_strings.has(String(row.workspaceId)),
	);

	const ai_chat_threads = ai_chat_threads_all.filter(
		(row) =>
			row.createdBy === userId ||
			row.updatedBy === userId ||
			workspace_id_strings.has(row.workspaceId) ||
			workspace_project_id_strings.has(row.projectId),
	);
	const ai_chat_thread_id_strings = new Set(ai_chat_threads.map((row) => String(row._id)));
	const ai_chat_threads_messages_aisdk_5 = ai_chat_threads_messages_all.filter(
		(row) =>
			row.createdBy === userId ||
			ai_chat_thread_id_strings.has(String(row.threadId)) ||
			workspace_id_strings.has(row.workspaceId) ||
			workspace_project_id_strings.has(row.projectId),
	);

	const pages = pages_all.filter(
		(row) =>
			row.createdBy === userId ||
			workspace_id_strings.has(row.workspaceId) ||
			workspace_project_id_strings.has(row.projectId),
	);
	const page_id_strings = new Set(pages.map((row) => String(row._id)));

	const pages_pending_edits = pages_pending_edits_all.filter(
		(row) =>
			row.userId === userIdString ||
			page_id_strings.has(String(row.pageId)) ||
			workspace_id_strings.has(row.workspaceId) ||
			workspace_project_id_strings.has(row.projectId),
	);
	const pending_edit_id_strings = new Set(pages_pending_edits.map((row) => String(row._id)));

	const pages_pending_edits_last_sequence_saved = pages_pending_edits_last_sequence_saved_all.filter(
		(row) =>
			row.userId === userIdString ||
			page_id_strings.has(String(row.pageId)) ||
			workspace_id_strings.has(row.workspaceId) ||
			workspace_project_id_strings.has(row.projectId),
	);
	const pages_pending_edits_cleanup_tasks = pages_pending_edits_cleanup_tasks_all.filter((row) =>
		pending_edit_id_strings.has(String(row.pendingEditId)),
	);

	const pages_markdown_content = pages_markdown_content_all.filter(
		(row) =>
			page_id_strings.has(String(row.page_id)) ||
			workspace_id_strings.has(row.workspace_id) ||
			workspace_project_id_strings.has(row.project_id),
	);
	const pages_markdown_chunks = pages_markdown_chunks_all.filter(
		(row) =>
			page_id_strings.has(String(row.pageId)) ||
			workspace_id_strings.has(row.workspaceId) ||
			workspace_project_id_strings.has(row.projectId),
	);
	const pages_plain_text_chunks = pages_plain_text_chunks_all.filter(
		(row) =>
			page_id_strings.has(String(row.pageId)) ||
			workspace_id_strings.has(row.workspaceId) ||
			workspace_project_id_strings.has(row.projectId),
	);
	const pages_yjs_snapshots = pages_yjs_snapshots_all.filter(
		(row) =>
			page_id_strings.has(String(row.page_id)) ||
			workspace_id_strings.has(row.workspace_id) ||
			workspace_project_id_strings.has(row.project_id),
	);
	const pages_yjs_updates = pages_yjs_updates_all.filter(
		(row) =>
			page_id_strings.has(String(row.page_id)) ||
			workspace_id_strings.has(row.workspace_id) ||
			workspace_project_id_strings.has(row.project_id),
	);
	const pages_yjs_docs_last_sequences = pages_yjs_docs_last_sequences_all.filter(
		(row) =>
			page_id_strings.has(String(row.page_id)) ||
			workspace_id_strings.has(row.workspace_id) ||
			workspace_project_id_strings.has(row.project_id),
	);
	const pages_yjs_snapshot_schedules = pages_yjs_snapshot_schedules_all.filter((row) =>
		page_id_strings.has(String(row.page_id)),
	);
	const pages_snapshots = pages_snapshots_all.filter(
		(row) =>
			row.created_by === userId ||
			page_id_strings.has(String(row.page_id)) ||
			workspace_id_strings.has(row.workspace_id) ||
			workspace_project_id_strings.has(row.project_id),
	);
	const page_snapshot_id_strings = new Set(pages_snapshots.map((row) => String(row._id)));
	const pages_snapshots_contents = pages_snapshots_contents_all.filter(
		(row) =>
			page_snapshot_id_strings.has(String(row.page_snapshot_id)) ||
			page_id_strings.has(String(row.page_id)) ||
			workspace_id_strings.has(row.workspace_id) ||
			workspace_project_id_strings.has(row.project_id),
	);
	const chat_messages = chat_messages_all.filter(
		(row) => workspace_id_strings.has(row.workspaceId) || workspace_project_id_strings.has(row.projectId),
	);

	return {
		user,
		users_anon_tokens,
		users_anagraphics,
		limits_per_user,
		workspaces,
		workspaces_projects,
		workspaces_projects_users,
		workspaces_data_deletion_requests,
		limits_per_workspace,
		ai_chat_threads,
		ai_chat_threads_messages_aisdk_5,
		pages,
		pages_pending_edits,
		pages_pending_edits_last_sequence_saved,
		pages_pending_edits_cleanup_tasks,
		pages_markdown_content,
		pages_markdown_chunks,
		pages_plain_text_chunks,
		pages_yjs_snapshots,
		pages_yjs_updates,
		pages_yjs_docs_last_sequences,
		pages_yjs_snapshot_schedules,
		pages_snapshots,
		pages_snapshots_contents,
		chat_messages,
	};
}

function summarize_user_rows(rows: NonNullable<Awaited<ReturnType<typeof collect_user_rows>>>) {
	return {
		lookup: {
			userId: rows.user._id,
			clerkUserId: rows.user.clerkUserId,
			anonymousAuthTokenId: rows.user.anonymousAuthToken ?? null,
			anagraphicId: rows.user.anagraphic ?? null,
			defaultWorkspaceId: rows.user.defaultWorkspaceId ?? null,
			defaultProjectId: rows.user.defaultProjectId ?? null,
		},
		counts: {
			users: 1,
			users_anon_tokens: rows.users_anon_tokens.length,
			users_anagraphics: rows.users_anagraphics.length,
			limits_per_user: rows.limits_per_user.length,
			workspaces: rows.workspaces.length,
			workspaces_projects: rows.workspaces_projects.length,
			workspaces_projects_users: rows.workspaces_projects_users.length,
			workspaces_data_deletion_requests: rows.workspaces_data_deletion_requests.length,
			limits_per_workspace: rows.limits_per_workspace.length,
			ai_chat_threads: rows.ai_chat_threads.length,
			ai_chat_threads_messages_aisdk_5: rows.ai_chat_threads_messages_aisdk_5.length,
			pages: rows.pages.length,
			pages_pending_edits: rows.pages_pending_edits.length,
			pages_pending_edits_last_sequence_saved: rows.pages_pending_edits_last_sequence_saved.length,
			pages_pending_edits_cleanup_tasks: rows.pages_pending_edits_cleanup_tasks.length,
			pages_markdown_content: rows.pages_markdown_content.length,
			pages_markdown_chunks: rows.pages_markdown_chunks.length,
			pages_plain_text_chunks: rows.pages_plain_text_chunks.length,
			pages_yjs_snapshots: rows.pages_yjs_snapshots.length,
			pages_yjs_updates: rows.pages_yjs_updates.length,
			pages_yjs_docs_last_sequences: rows.pages_yjs_docs_last_sequences.length,
			pages_yjs_snapshot_schedules: rows.pages_yjs_snapshot_schedules.length,
			pages_snapshots: rows.pages_snapshots.length,
			pages_snapshots_contents: rows.pages_snapshots_contents.length,
			chat_messages: rows.chat_messages.length,
		},
		idStrings: {
			users: [String(rows.user._id)],
			users_anon_tokens: sorted_id_strings(rows.users_anon_tokens.map((row) => String(row._id))),
			users_anagraphics: sorted_id_strings(rows.users_anagraphics.map((row) => String(row._id))),
			limits_per_user: sorted_id_strings(rows.limits_per_user.map((row) => String(row._id))),
			workspaces: sorted_id_strings(rows.workspaces.map((row) => String(row._id))),
			workspaces_projects: sorted_id_strings(rows.workspaces_projects.map((row) => String(row._id))),
			workspaces_projects_users: sorted_id_strings(rows.workspaces_projects_users.map((row) => String(row._id))),
			workspaces_data_deletion_requests: sorted_id_strings(
				rows.workspaces_data_deletion_requests.map((row) => String(row._id)),
			),
			limits_per_workspace: sorted_id_strings(rows.limits_per_workspace.map((row) => String(row._id))),
			ai_chat_threads: sorted_id_strings(rows.ai_chat_threads.map((row) => String(row._id))),
			ai_chat_threads_messages_aisdk_5: sorted_id_strings(
				rows.ai_chat_threads_messages_aisdk_5.map((row) => String(row._id)),
			),
			pages: sorted_id_strings(rows.pages.map((row) => String(row._id))),
			pages_pending_edits: sorted_id_strings(rows.pages_pending_edits.map((row) => String(row._id))),
			pages_pending_edits_last_sequence_saved: sorted_id_strings(
				rows.pages_pending_edits_last_sequence_saved.map((row) => String(row._id)),
			),
			pages_pending_edits_cleanup_tasks: sorted_id_strings(
				rows.pages_pending_edits_cleanup_tasks.map((row) => String(row._id)),
			),
			pages_markdown_content: sorted_id_strings(rows.pages_markdown_content.map((row) => String(row._id))),
			pages_markdown_chunks: sorted_id_strings(rows.pages_markdown_chunks.map((row) => String(row._id))),
			pages_plain_text_chunks: sorted_id_strings(rows.pages_plain_text_chunks.map((row) => String(row._id))),
			pages_yjs_snapshots: sorted_id_strings(rows.pages_yjs_snapshots.map((row) => String(row._id))),
			pages_yjs_updates: sorted_id_strings(rows.pages_yjs_updates.map((row) => String(row._id))),
			pages_yjs_docs_last_sequences: sorted_id_strings(
				rows.pages_yjs_docs_last_sequences.map((row) => String(row._id)),
			),
			pages_yjs_snapshot_schedules: sorted_id_strings(rows.pages_yjs_snapshot_schedules.map((row) => String(row._id))),
			pages_snapshots: sorted_id_strings(rows.pages_snapshots.map((row) => String(row._id))),
			pages_snapshots_contents: sorted_id_strings(rows.pages_snapshots_contents.map((row) => String(row._id))),
			chat_messages: sorted_id_strings(rows.chat_messages.map((row) => String(row._id))),
		},
	};
}

export const preview_purge_user_data = internalQuery({
	args: user_purge_args,
	returns: v.union(user_purge_summary, v.null()),
	handler: async (ctx, args) => {
		const rows = await collect_user_rows(ctx, args);
		if (!rows) {
			return null;
		}

		return summarize_user_rows(rows);
	},
});

export const purge_user_data = internalMutation({
	args: user_purge_args,
	returns: v.union(user_purge_summary, v.null()),
	handler: async (ctx, args) => {
		const rows = await collect_user_rows(ctx, args);
		if (!rows) {
			return null;
		}

		await Promise.all(
			rows.pages_pending_edits_cleanup_tasks.map((row) => ctx.db.delete("pages_pending_edits_cleanup_tasks", row._id)),
		);
		await Promise.all(
			rows.pages_yjs_snapshot_schedules.map((row) => ctx.db.delete("pages_yjs_snapshot_schedules", row._id)),
		);
		await Promise.all(
			rows.ai_chat_threads_messages_aisdk_5.map((row) => ctx.db.delete("ai_chat_threads_messages_aisdk_5", row._id)),
		);
		await Promise.all(rows.ai_chat_threads.map((row) => ctx.db.delete("ai_chat_threads", row._id)));
		await Promise.all(rows.chat_messages.map((row) => ctx.db.delete("chat_messages", row._id)));
		await Promise.all(
			rows.pages_pending_edits_last_sequence_saved.map((row) =>
				ctx.db.delete("pages_pending_edits_last_sequence_saved", row._id),
			),
		);
		await Promise.all(rows.pages_pending_edits.map((row) => ctx.db.delete("pages_pending_edits", row._id)));
		await Promise.all(rows.pages_plain_text_chunks.map((row) => ctx.db.delete("pages_plain_text_chunks", row._id)));
		await Promise.all(rows.pages_markdown_chunks.map((row) => ctx.db.delete("pages_markdown_chunks", row._id)));
		await Promise.all(rows.pages_yjs_snapshots.map((row) => ctx.db.delete("pages_yjs_snapshots", row._id)));
		await Promise.all(rows.pages_yjs_updates.map((row) => ctx.db.delete("pages_yjs_updates", row._id)));
		await Promise.all(
			rows.pages_yjs_docs_last_sequences.map((row) => ctx.db.delete("pages_yjs_docs_last_sequences", row._id)),
		);
		await Promise.all(rows.pages_snapshots_contents.map((row) => ctx.db.delete("pages_snapshots_contents", row._id)));
		await Promise.all(rows.pages_snapshots.map((row) => ctx.db.delete("pages_snapshots", row._id)));
		await Promise.all(rows.pages_markdown_content.map((row) => ctx.db.delete("pages_markdown_content", row._id)));
		await Promise.all(rows.pages.map((row) => ctx.db.delete("pages", row._id)));
		await Promise.all(
			rows.workspaces_data_deletion_requests.map((row) => ctx.db.delete("workspaces_data_deletion_requests", row._id)),
		);
		await Promise.all(rows.workspaces_projects_users.map((row) => ctx.db.delete("workspaces_projects_users", row._id)));
		await Promise.all(rows.workspaces_projects.map((row) => ctx.db.delete("workspaces_projects", row._id)));
		await Promise.all(rows.limits_per_workspace.map((row) => ctx.db.delete("limits_per_workspace", row._id)));
		await Promise.all(rows.workspaces.map((row) => ctx.db.delete("workspaces", row._id)));
		await Promise.all(rows.users_anon_tokens.map((row) => ctx.db.delete("users_anon_tokens", row._id)));
		await Promise.all(rows.limits_per_user.map((row) => ctx.db.delete("limits_per_user", row._id)));
		await Promise.all(rows.users_anagraphics.map((row) => ctx.db.delete("users_anagraphics", row._id)));
		await ctx.db.delete("users", rows.user._id);

		return summarize_user_rows(rows);
	},
});
