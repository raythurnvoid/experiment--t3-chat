import { expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_hardcoded } from "./setup.test.ts";
import type { MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import {
	pages_db_reschedule_pending_edit_cleanup_for_user,
	pages_FIRST_VERSION,
	pages_ROOT_ID,
	pages_u8_to_array_buffer,
	pages_yjs_compute_diff_update_from_yjs_doc,
	pages_yjs_doc_clone,
	pages_yjs_doc_create_from_array_buffer_update,
	pages_yjs_doc_get_markdown,
	pages_yjs_doc_update_from_markdown,
} from "../server/pages.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";

async function seed_page_with_markdown(args: {
	ctx: MutationCtx;
	path: string;
	name: string;
	markdown: string;
}) {
	const { ctx, path, name, markdown } = args;
	const workspaceId = test_mocks_hardcoded.workspace_id.workspace_1;
	const projectId = test_mocks_hardcoded.project_id.project_1;

	const userId = await ctx.db.insert("users", {
		clerkUserId: null,
		anonymousAuthToken: null,
	});

	const pageId = await ctx.db.insert("pages", {
		workspaceId,
		projectId,
		path,
		name,
		version: pages_FIRST_VERSION,
		parentId: pages_ROOT_ID,
		createdBy: userId,
		updatedBy: String(userId),
		updatedAt: Date.now(),
		archiveOperationId: undefined,
	});

	const markdownContentId = await ctx.db.insert("pages_markdown_content", {
		workspace_id: workspaceId,
		project_id: projectId,
		page_id: pageId,
		content: markdown,
		is_archived: false,
		yjs_sequence: 0,
		updated_at: Date.now(),
		updated_by: String(userId),
	});

	const baseYjsDoc = new YDoc();
	const baseYjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
		mut_yjsDoc: baseYjsDoc,
		markdown,
	});
	if (baseYjsDocFromMarkdown._nay) {
		throw new Error("Failed to seed base Yjs doc from markdown");
	}

	const baseMarkdownResult = pages_yjs_doc_get_markdown({
		yjsDoc: baseYjsDoc,
	});
	if (baseMarkdownResult._nay) {
		throw new Error("Failed to seed base markdown from Yjs doc");
	}

	const snapshotId = await ctx.db.insert("pages_yjs_snapshots", {
		workspace_id: workspaceId,
		project_id: projectId,
		page_id: pageId,
		sequence: 0,
		snapshot_update: pages_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc)),
		created_by: String(userId),
		updated_by: String(userId),
		updated_at: Date.now(),
	});

	const lastSequenceId = await ctx.db.insert("pages_yjs_docs_last_sequences", {
		workspace_id: workspaceId,
		project_id: projectId,
		page_id: pageId,
		last_sequence: 0,
	});

	await ctx.db.patch("pages", pageId, {
		markdownContentId,
		yjsSnapshotId: snapshotId,
		yjsLastSequenceId: lastSequenceId,
	});

	return {
		workspaceId,
		projectId,
		userId,
		pageId,
		baseMarkdown: baseMarkdownResult._yay,
	};
}

async function read_page_markdown_from_yjs(args: {
	ctx: MutationCtx;
	workspaceId: string;
	projectId: string;
	pageId: Id<"pages">;
}) {
	const { ctx, workspaceId, projectId, pageId } = args;
	const page = await ctx.db.get("pages", pageId);
	if (!page || !page.yjsSnapshotId) {
		throw new Error("Page missing while reading markdown from Yjs");
	}

	const snapshot = await ctx.db.get("pages_yjs_snapshots", page.yjsSnapshotId);
	if (!snapshot) {
		throw new Error("Snapshot missing while reading markdown from Yjs");
	}

	const updates = await ctx.db
		.query("pages_yjs_updates")
		.withIndex("by_workspace_project_page_id_sequence", (q) =>
			q.eq("workspace_id", workspaceId).eq("project_id", projectId).eq("page_id", page._id),
		)
		.order("asc")
		.collect();

	const yjsDoc = pages_yjs_doc_create_from_array_buffer_update(snapshot.snapshot_update, {
		additionalIncrementalArrayBufferUpdates: updates
			.filter((update) => update.sequence > snapshot.sequence)
			.map((update) => update.update),
	});

	const markdown = pages_yjs_doc_get_markdown({ yjsDoc });
	if (markdown._nay) {
		throw new Error("Failed to read markdown from Yjs");
	}

	return markdown._yay;
}

function normalize_pending_edit_markdown(markdown: string) {
	const yjsDoc = new YDoc();
	const updateMarkdownResult = pages_yjs_doc_update_from_markdown({
		mut_yjsDoc: yjsDoc,
		markdown,
	});
	if (updateMarkdownResult._nay) {
		throw new Error("Failed to normalize pending edit markdown");
	}

	const normalizedMarkdown = pages_yjs_doc_get_markdown({
		yjsDoc,
	});
	if (normalizedMarkdown._nay) {
		throw new Error("Failed to read normalized pending edit markdown");
	}

	return normalizedMarkdown._yay;
}

async function read_page_yjs_state(args: {
	ctx: MutationCtx;
	workspaceId: string;
	projectId: string;
	pageId: Id<"pages">;
}) {
	const { ctx, workspaceId, projectId, pageId } = args;
	const page = await ctx.db.get("pages", pageId);
	if (!page || !page.yjsSnapshotId || !page.yjsLastSequenceId) {
		throw new Error("Page missing while reading Yjs state");
	}

	const [snapshot, lastSequenceDoc, updates] = await Promise.all([
		ctx.db.get("pages_yjs_snapshots", page.yjsSnapshotId),
		ctx.db.get("pages_yjs_docs_last_sequences", page.yjsLastSequenceId),
		ctx.db
			.query("pages_yjs_updates")
			.withIndex("by_workspace_project_page_id_sequence", (q) =>
				q.eq("workspace_id", workspaceId).eq("project_id", projectId).eq("page_id", page._id),
			)
			.order("asc")
			.collect(),
	]);
	if (!snapshot || !lastSequenceDoc) {
		throw new Error("Page Yjs state missing while reading Yjs state");
	}

	const yjsDoc = pages_yjs_doc_create_from_array_buffer_update(snapshot.snapshot_update, {
		additionalIncrementalArrayBufferUpdates: updates
			.filter((update) => update.sequence > snapshot.sequence)
			.map((update) => update.update),
	});

	return {
		yjsUpdate: pages_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc)),
		yjsSequence: lastSequenceDoc.last_sequence,
	};
}

async function build_page_diff_update_from_snapshot(args: {
	ctx: MutationCtx;
	pageId: Id<"pages">;
	markdown: string;
}) {
	const { ctx, pageId, markdown } = args;
	const page = await ctx.db.get("pages", pageId);
	if (!page || !page.yjsSnapshotId) {
		throw new Error("Page missing while preparing diff update from snapshot");
	}

	const snapshot = await ctx.db.get("pages_yjs_snapshots", page.yjsSnapshotId);
	if (!snapshot) {
		throw new Error("Snapshot missing while preparing diff update from snapshot");
	}

	const baseYjsDoc = pages_yjs_doc_create_from_array_buffer_update(snapshot.snapshot_update);
	const targetYjsDoc = pages_yjs_doc_clone({
		yjsDoc: baseYjsDoc,
	});
	const targetYjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
		mut_yjsDoc: targetYjsDoc,
		markdown,
	});
	if (targetYjsDocFromMarkdown._nay) {
		throw new Error("Failed to build target Yjs doc while preparing diff update from snapshot");
	}

	const diffUpdate = pages_yjs_compute_diff_update_from_yjs_doc({
		yjsDoc: targetYjsDoc,
		yjsBeforeDoc: baseYjsDoc,
	});
	if (!diffUpdate) {
		throw new Error("Missing diff update while preparing diff update from snapshot");
	}

	return pages_u8_to_array_buffer(diffUpdate);
}

function read_pending_row_markdown_state(args: {
	pendingEdit: {
		baseYjsUpdate: ArrayBuffer;
		stagedBranchYjsUpdate: ArrayBuffer;
		unstagedBranchYjsUpdate: ArrayBuffer;
	};
}) {
	const baseYjsDoc = pages_yjs_doc_create_from_array_buffer_update(args.pendingEdit.baseYjsUpdate);
	const stagedBranchYjsDoc = pages_yjs_doc_create_from_array_buffer_update(args.pendingEdit.stagedBranchYjsUpdate);
	const unstagedBranchYjsDoc = pages_yjs_doc_create_from_array_buffer_update(args.pendingEdit.unstagedBranchYjsUpdate);

	const baseMarkdown = pages_yjs_doc_get_markdown({
		yjsDoc: baseYjsDoc,
	});
	const stagedMarkdown = pages_yjs_doc_get_markdown({
		yjsDoc: stagedBranchYjsDoc,
	});
	const unstagedMarkdown = pages_yjs_doc_get_markdown({
		yjsDoc: unstagedBranchYjsDoc,
	});

	if (baseMarkdown._nay || stagedMarkdown._nay || unstagedMarkdown._nay) {
		throw new Error("Failed to reconstruct pending row markdown");
	}

	return {
		baseMarkdown: baseMarkdown._yay,
		stagedMarkdown: stagedMarkdown._yay,
		unstagedMarkdown: unstagedMarkdown._yay,
	};
}

async function list_pending_edit_cleanup_tasks(args: {
	ctx: MutationCtx;
	pendingEditId: Id<"pages_pending_edits">;
}) {
	return await args.ctx.db
		.query("pages_pending_edits_cleanup_tasks")
		.withIndex("by_pendingEditId", (q) => q.eq("pendingEditId", args.pendingEditId))
		.collect();
}

async function read_pending_edit_last_sequence_saved_row(args: {
	ctx: MutationCtx;
	workspaceId: string;
	projectId: string;
	userId: Id<"users">;
	pageId: Id<"pages">;
}) {
	return await args.ctx.db
		.query("pages_pending_edits_last_sequence_saved")
		.withIndex("by_workspace_project_user_page", (q) =>
			q
				.eq("workspaceId", args.workspaceId)
				.eq("projectId", args.projectId)
				.eq("userId", args.userId)
				.eq("pageId", args.pageId),
		)
		.first();
}

test("upsert_pages_pending_edit_updates replaces updates deterministically", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-status",
			name: "pending-edits-status",
			markdown: "# Base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const changedMarkdown = `${seeded.baseMarkdown}\n\nChanged once`;

	const unresolved = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: changedMarkdown,
	});
	if (unresolved._nay) {
		throw new Error(unresolved._nay.message);
	}
	expect(unresolved._yay).toBeNull();

	const ready = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: changedMarkdown,
		unstagedMarkdown: changedMarkdown,
	});
	if (ready._nay) {
		throw new Error(ready._nay.message);
	}
	expect(ready._yay).toBeNull();

	const firstPendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	expect(firstPendingRow).not.toBeNull();

	const readyAgain = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: changedMarkdown,
		unstagedMarkdown: changedMarkdown,
	});
	if (readyAgain._nay) {
		throw new Error(readyAgain._nay.message);
	}
	expect(readyAgain._yay).toBeNull();

	const secondPendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	expect(secondPendingRow).not.toBeNull();
	expect(secondPendingRow!._id).toBe(firstPendingRow!._id);
	expect(secondPendingRow!.baseYjsSequence).toBe(firstPendingRow!.baseYjsSequence);

	const secondPendingRowMarkdownState = read_pending_row_markdown_state({
		pendingEdit: secondPendingRow!,
	});
	expect(secondPendingRowMarkdownState.stagedMarkdown).toContain("Changed once");
	expect(secondPendingRowMarkdownState.unstagedMarkdown).toContain("Changed once");
	expect(secondPendingRowMarkdownState.stagedMarkdown).toBe(secondPendingRowMarkdownState.unstagedMarkdown);

	const discarded = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: seeded.baseMarkdown,
	});
	if (discarded._nay) {
		throw new Error(discarded._nay.message);
	}
	expect(discarded._yay).toBeNull();

	const pendingAfterDiscard = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	expect(pendingAfterDiscard).toBeNull();
});

test("upsert_pages_pending_edit_updates keeps staged at base when the agent omits stagedMarkdown", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-agent-new-proposal",
			name: "pending-edits-agent-new-proposal",
			markdown: "# Base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const agentMarkdown = normalize_pending_edit_markdown(`${seeded.baseMarkdown}\n\nAgent proposal`);
	const agentUpsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		unstagedMarkdown: agentMarkdown,
	});
	if (agentUpsertResult._nay) {
		throw new Error(agentUpsertResult._nay.message);
	}
	expect(agentUpsertResult._yay).toBeNull();

	const pendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	if (!pendingRow) {
		throw new Error("Missing pending row after creating an agent proposal");
	}

	const pendingRowMarkdownState = read_pending_row_markdown_state({
		pendingEdit: pendingRow,
	});
	expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
	expect(pendingRowMarkdownState.stagedMarkdown).toBe(seeded.baseMarkdown);
	expect(pendingRowMarkdownState.unstagedMarkdown).toBe(agentMarkdown);
});

test("upsert_pages_pending_edit_updates preserves existing staged changes when the agent omits stagedMarkdown", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-agent-preserve-staged",
			name: "pending-edits-agent-preserve-staged",
			markdown: "# Base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const stagedMarkdown = normalize_pending_edit_markdown(`${seeded.baseMarkdown}\n\nUser staged`);
	const firstAgentMarkdown = normalize_pending_edit_markdown(`${stagedMarkdown}\n\nAgent proposal`);
	const stagedPendingEditResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: stagedMarkdown,
		unstagedMarkdown: firstAgentMarkdown,
	});
	if (stagedPendingEditResult._nay) {
		throw new Error(stagedPendingEditResult._nay.message);
	}

	const secondAgentMarkdown = normalize_pending_edit_markdown(`${firstAgentMarkdown}\n\nAgent follow up`);
	const secondAgentUpsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		unstagedMarkdown: secondAgentMarkdown,
	});
	if (secondAgentUpsertResult._nay) {
		throw new Error(secondAgentUpsertResult._nay.message);
	}
	expect(secondAgentUpsertResult._yay).toBeNull();

	const pendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	if (!pendingRow) {
		throw new Error("Missing pending row after the follow-up agent proposal");
	}

	const pendingRowMarkdownState = read_pending_row_markdown_state({
		pendingEdit: pendingRow,
	});
	expect(pendingRowMarkdownState.baseMarkdown).toBe(seeded.baseMarkdown);
	expect(pendingRowMarkdownState.stagedMarkdown).toBe(stagedMarkdown);
	expect(pendingRowMarkdownState.unstagedMarkdown).toBe(secondAgentMarkdown);
});

test("upsert_pages_pending_edit_updates clears the row when agent changes collapse to base", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-agent-collapse-to-base",
			name: "pending-edits-agent-collapse-to-base",
			markdown: "# Base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const agentMarkdown = normalize_pending_edit_markdown(`${seeded.baseMarkdown}\n\nAgent proposal`);
	const firstAgentUpsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		unstagedMarkdown: agentMarkdown,
	});
	if (firstAgentUpsertResult._nay) {
		throw new Error(firstAgentUpsertResult._nay.message);
	}

	const discardAgentUpsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		unstagedMarkdown: seeded.baseMarkdown,
	});
	if (discardAgentUpsertResult._nay) {
		throw new Error(discardAgentUpsertResult._nay.message);
	}
	expect(discardAgentUpsertResult._yay).toBeNull();

	const pendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	expect(pendingRow).toBeNull();
});

test("pending edit cleanup task follows the latest pending row state", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-cleanup-task",
			name: "pending-edits-cleanup-task",
			markdown: "# Cleanup task base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const firstMarkdown = `${seeded.baseMarkdown}\n\nCleanup task first`;
	const firstUpsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: firstMarkdown,
	});
	if (firstUpsertResult._nay) {
		throw new Error(firstUpsertResult._nay.message);
	}

	const firstPendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	if (!firstPendingRow) {
		throw new Error("Missing first pending row while testing cleanup task scheduling");
	}

	const firstCleanupTasks = await t.run((ctx) =>
		list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: firstPendingRow._id,
		}),
	);
	expect(firstCleanupTasks).toHaveLength(1);
	expect(firstCleanupTasks[0]!.expectedUpdatedAt).toBe(firstPendingRow.updatedAt);

	await new Promise((resolve) => setTimeout(resolve, 2));

	const secondMarkdown = `${seeded.baseMarkdown}\n\nCleanup task second`;
	const secondUpsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: secondMarkdown,
		unstagedMarkdown: secondMarkdown,
	});
	if (secondUpsertResult._nay) {
		throw new Error(secondUpsertResult._nay.message);
	}

	const secondPendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	if (!secondPendingRow) {
		throw new Error("Missing second pending row while testing cleanup task rescheduling");
	}

	const secondCleanupTasks = await t.run((ctx) =>
		list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: secondPendingRow._id,
		}),
	);
	expect(secondCleanupTasks).toHaveLength(1);
	expect(secondCleanupTasks[0]!.expectedUpdatedAt).toBe(secondPendingRow.updatedAt);
	expect(secondCleanupTasks[0]!.scheduledFunctionId).not.toBe(firstCleanupTasks[0]!.scheduledFunctionId);

	const discardResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: seeded.baseMarkdown,
	});
	if (discardResult._nay) {
		throw new Error(discardResult._nay.message);
	}

	const cleanupTasksAfterDiscard = await t.run((ctx) =>
		list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: secondPendingRow._id,
		}),
	);
	expect(cleanupTasksAfterDiscard).toHaveLength(0);
});

test("pages_db_reschedule_pending_edit_cleanup_for_user refreshes existing cleanup tasks", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-reschedule-for-user",
			name: "pending-edits-reschedule-for-user",
			markdown: "# Reschedule base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const changedMarkdown = `${seeded.baseMarkdown}\n\nReschedule pending`;
	const upsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: changedMarkdown,
	});
	if (upsertResult._nay) {
		throw new Error(upsertResult._nay.message);
	}

	const pendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	if (!pendingRow) {
		throw new Error("Missing pending row while testing user cleanup reschedule");
	}

	const firstCleanupTask = await t.run(async (ctx) => {
		const cleanupTasks = await list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: pendingRow._id,
		});
		return cleanupTasks[0] ?? null;
	});
	if (!firstCleanupTask) {
		throw new Error("Missing first cleanup task while testing user cleanup reschedule");
	}

	await t.run((ctx) =>
		pages_db_reschedule_pending_edit_cleanup_for_user(ctx, {
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
		}),
	);

	const secondCleanupTask = await t.run(async (ctx) => {
		const cleanupTasks = await list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: pendingRow._id,
		});
		return cleanupTasks[0] ?? null;
	});
	if (!secondCleanupTask) {
		throw new Error("Missing second cleanup task while testing user cleanup reschedule");
	}

	expect(secondCleanupTask.expectedUpdatedAt).toBe(firstCleanupTask.expectedUpdatedAt);
	expect(secondCleanupTask.scheduledFunctionId).not.toBe(firstCleanupTask.scheduledFunctionId);
});

test("presence.disconnect shortens cleanup after the last session disconnects", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-disconnect-last-session",
			name: "pending-edits-disconnect-last-session",
			markdown: "# Disconnect base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const changedMarkdown = `${seeded.baseMarkdown}\n\nDisconnect pending`;
	const upsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: changedMarkdown,
	});
	if (upsertResult._nay) {
		throw new Error(upsertResult._nay.message);
	}

	const pendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	if (!pendingRow) {
		throw new Error("Missing pending row while testing last-session disconnect cleanup");
	}

	const firstCleanupTask = await t.run(async (ctx) => {
		const cleanupTasks = await list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: pendingRow._id,
		});
		return cleanupTasks[0] ?? null;
	});
	if (!firstCleanupTask) {
		throw new Error("Missing first cleanup task while testing last-session disconnect cleanup");
	}

	const roomId = `pending-edits-room-${seeded.pageId}`;
	const presenceHeartbeatResult = await asUser.mutation(api.presence.heartbeat, {
		roomId,
		userId: seeded.userId,
		sessionId: "session-last",
		interval: 1_000,
	});

	await asUser.mutation(api.presence.disconnect, {
		sessionToken: presenceHeartbeatResult.sessionToken,
	});

	const sessionsAfterDisconnect = await asUser.query(api.presence.listSessions, {
		roomToken: presenceHeartbeatResult.roomToken,
	});
	expect(sessionsAfterDisconnect).toHaveLength(0);

	const secondCleanupTask = await t.run(async (ctx) => {
		const cleanupTasks = await list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: pendingRow._id,
		});
		return cleanupTasks[0] ?? null;
	});
	if (!secondCleanupTask) {
		throw new Error("Missing second cleanup task while testing last-session disconnect cleanup");
	}

	expect(secondCleanupTask.expectedUpdatedAt).toBe(firstCleanupTask.expectedUpdatedAt);
	expect(secondCleanupTask.scheduledFunctionId).not.toBe(firstCleanupTask.scheduledFunctionId);
});

test("presence.disconnect keeps cleanup unchanged while another session stays online", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-disconnect-multi-session",
			name: "pending-edits-disconnect-multi-session",
			markdown: "# Disconnect multi-session base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const changedMarkdown = `${seeded.baseMarkdown}\n\nDisconnect multi-session pending`;
	const upsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: changedMarkdown,
	});
	if (upsertResult._nay) {
		throw new Error(upsertResult._nay.message);
	}

	const pendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	if (!pendingRow) {
		throw new Error("Missing pending row while testing multi-session disconnect cleanup");
	}

	const firstCleanupTask = await t.run(async (ctx) => {
		const cleanupTasks = await list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: pendingRow._id,
		});
		return cleanupTasks[0] ?? null;
	});
	if (!firstCleanupTask) {
		throw new Error("Missing first cleanup task while testing multi-session disconnect cleanup");
	}

	const roomId = `pending-edits-room-${seeded.pageId}`;
	const firstHeartbeatResult = await asUser.mutation(api.presence.heartbeat, {
		roomId,
		userId: seeded.userId,
		sessionId: "session-first",
		interval: 1_000,
	});
	await asUser.mutation(api.presence.heartbeat, {
		roomId,
		userId: seeded.userId,
		sessionId: "session-second",
		interval: 1_000,
	});

	await asUser.mutation(api.presence.disconnect, {
		sessionToken: firstHeartbeatResult.sessionToken,
	});

	const sessionsAfterDisconnect = await asUser.query(api.presence.listSessions, {
		roomToken: firstHeartbeatResult.roomToken,
	});
	expect(sessionsAfterDisconnect).toHaveLength(1);
	expect(sessionsAfterDisconnect[0]!.sessionId).toBe("session-second");

	const secondCleanupTask = await t.run(async (ctx) => {
		const cleanupTasks = await list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: pendingRow._id,
		});
		return cleanupTasks[0] ?? null;
	});
	if (!secondCleanupTask) {
		throw new Error("Missing second cleanup task while testing multi-session disconnect cleanup");
	}

	expect(secondCleanupTask.expectedUpdatedAt).toBe(firstCleanupTask.expectedUpdatedAt);
	expect(secondCleanupTask.scheduledFunctionId).toBe(firstCleanupTask.scheduledFunctionId);
});

test("save_pages_pending_edit supports partial save and keeps unresolved pending row", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-save",
			name: "pending-edits-save",
			markdown: "# Save base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const stagedMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
	const unstagedMarkdown = `${stagedMarkdown}\n\nUnresolved chunk`;
	await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown,
		unstagedMarkdown,
	});

	const saveResult = await asUser.mutation(api.ai_chat.save_pages_pending_edit, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
	});
	if (saveResult._nay) {
		throw new Error(saveResult._nay.message);
	}
	if (!saveResult._yay) {
		throw new Error("Missing save result _yay while testing partial save");
	}
	expect(saveResult._yay.newSequence).not.toBeNull();

	const pendingEditLastSequenceSaved = await t.run(async (ctx) =>
		read_pending_edit_last_sequence_saved_row({
			ctx,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			pageId: seeded.pageId,
		}),
	);
	expect(pendingEditLastSequenceSaved).not.toBeNull();
	expect(pendingEditLastSequenceSaved!.lastSequenceSaved).toBe(saveResult._yay.newSequence);

	const pendingAfterSave = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	expect(pendingAfterSave).not.toBeNull();
	expect(pendingAfterSave!.baseYjsSequence).toBe(saveResult._yay.newSequence);
	const pendingAfterSaveMarkdownState = read_pending_row_markdown_state({
		pendingEdit: pendingAfterSave!,
	});
	expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("Accepted chunk");
	expect(pendingAfterSaveMarkdownState.baseMarkdown).not.toContain("Unresolved chunk");
	expect(pendingAfterSaveMarkdownState.stagedMarkdown).toBe(pendingAfterSaveMarkdownState.baseMarkdown);
	expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Accepted chunk");
	expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Unresolved chunk");

	const savedMarkdownAfterPartialSave = await t.run(async (ctx) =>
		read_page_markdown_from_yjs({
			ctx,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		}),
	);
	expect(savedMarkdownAfterPartialSave).toContain("Accepted chunk");
	expect(savedMarkdownAfterPartialSave).not.toContain("Unresolved chunk");
});

test("save_pages_pending_edit clears pending row when all changes are resolved", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-save-full",
			name: "pending-edits-save-full",
			markdown: "# Save base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const pendingEditLastSequenceSavedBeforeFirstSave = await asUser.query(
		api.ai_chat.get_pages_pending_edit_last_sequence_saved,
		{
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		},
	);
	expect(pendingEditLastSequenceSavedBeforeFirstSave).toBeNull();

	const resolvedMarkdown = `${seeded.baseMarkdown}\n\nFully resolved`;
	const upsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: resolvedMarkdown,
		unstagedMarkdown: resolvedMarkdown,
	});
	if (upsertResult._nay) {
		throw new Error(upsertResult._nay.message);
	}

	const saveResult = await asUser.mutation(api.ai_chat.save_pages_pending_edit, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
	});
	if (saveResult._nay) {
		throw new Error(saveResult._nay.message);
	}
	if (!saveResult._yay) {
		throw new Error("Missing save result _yay while testing full save");
	}
	expect(saveResult._yay.newSequence).not.toBeNull();

	const pendingEditLastSequenceSaved = await asUser.query(api.ai_chat.get_pages_pending_edit_last_sequence_saved, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
	});
	expect(pendingEditLastSequenceSaved).not.toBeNull();
	expect(pendingEditLastSequenceSaved!.lastSequenceSaved).toBe(saveResult._yay.newSequence);

	const pendingAfterSave = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	expect(pendingAfterSave).toBeNull();

	const savedMarkdownAfterFullSave = await t.run(async (ctx) =>
		read_page_markdown_from_yjs({
			ctx,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		}),
	);
	expect(savedMarkdownAfterFullSave).toContain("Fully resolved");
});

test("save_pages_pending_edit keeps unresolved row based on saved pending base when remote drift exists", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-save-no-staged",
			name: "pending-edits-save-no-staged",
			markdown: "# Save base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
	});

	const remoteDiff = await t.run(async (ctx) =>
		build_page_diff_update_from_snapshot({
			ctx,
			pageId: seeded.pageId,
			markdown: `${seeded.baseMarkdown}\n\nRemote drift`,
		}),
	);

	await asUser.mutation(api.ai_docs_temp.yjs_push_update, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		update: remoteDiff,
		sessionId: "remote-session",
	});

	const saveResult = await asUser.mutation(api.ai_chat.save_pages_pending_edit, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
	});
	if (saveResult._nay) {
		throw new Error(saveResult._nay.message);
	}
	if (!saveResult._yay) {
		throw new Error("Missing save result _yay while testing save without staged changes");
	}
	expect(saveResult._yay.newSequence).toBeNull();

	const pendingEditLastSequenceSaved = await t.run(async (ctx) =>
		read_pending_edit_last_sequence_saved_row({
			ctx,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			pageId: seeded.pageId,
		}),
	);
	expect(pendingEditLastSequenceSaved).not.toBeNull();
	expect(pendingEditLastSequenceSaved!.lastSequenceSaved).toBe(1);

	const pendingAfterSave = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	expect(pendingAfterSave).not.toBeNull();
	expect(pendingAfterSave!.baseYjsSequence).toBe(1);

	const pendingAfterSaveMarkdownState = read_pending_row_markdown_state({
		pendingEdit: pendingAfterSave!,
	});
	expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("# Save base");
	expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("Remote drift");
	expect(pendingAfterSaveMarkdownState.stagedMarkdown).toBe(pendingAfterSaveMarkdownState.baseMarkdown);
	expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Unresolved only");
	expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Remote drift");

	const savedMarkdownAfterNoStagedSave = await t.run(async (ctx) =>
		read_page_markdown_from_yjs({
			ctx,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		}),
	);
	expect(savedMarkdownAfterNoStagedSave).toContain("# Save base");
	expect(savedMarkdownAfterNoStagedSave).toContain("Remote drift");
	expect(savedMarkdownAfterNoStagedSave).not.toContain("Unresolved only");
});

test("upsert_pages_pending_edit_updates and persist_pages_pending_edit_rebased_state do not write last saved sequence marker", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-save-marker-non-save-paths",
			name: "pending-edits-save-marker-non-save-paths",
			markdown: "# Save marker base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const pendingEditLastSequenceSavedBeforeChanges = await asUser.query(
		api.ai_chat.get_pages_pending_edit_last_sequence_saved,
		{
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		},
	);
	expect(pendingEditLastSequenceSavedBeforeChanges).toBeNull();

	await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
	});

	const pendingEditLastSequenceSavedAfterUpsert = await asUser.query(
		api.ai_chat.get_pages_pending_edit_last_sequence_saved,
		{
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		},
	);
	expect(pendingEditLastSequenceSavedAfterUpsert).toBeNull();

	const latestPageState = await t.run(async (ctx) =>
		read_page_yjs_state({
			ctx,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		}),
	);
	const latestBaseYjsDoc = pages_yjs_doc_create_from_array_buffer_update(latestPageState.yjsUpdate);
	const unstagedBranchYjsDoc = pages_yjs_doc_clone({
		yjsDoc: latestBaseYjsDoc,
	});
	const unstagedBranchProjection = pages_yjs_doc_update_from_markdown({
		mut_yjsDoc: unstagedBranchYjsDoc,
		markdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
	});
	if (unstagedBranchProjection._nay) {
		throw new Error("Failed to create unstaged branch while testing save marker non-save paths");
	}

	const persistResult = await asUser.mutation(api.ai_chat.persist_pages_pending_edit_rebased_state, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		baseYjsSequence: latestPageState.yjsSequence,
		baseYjsUpdate: latestPageState.yjsUpdate,
		stagedBranchYjsUpdate: latestPageState.yjsUpdate,
		unstagedBranchYjsUpdate: pages_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
	});
	if (persistResult._nay) {
		throw new Error(persistResult._nay.message);
	}

	const pendingEditLastSequenceSavedAfterPersist = await asUser.query(
		api.ai_chat.get_pages_pending_edit_last_sequence_saved,
		{
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		},
	);
	expect(pendingEditLastSequenceSavedAfterPersist).toBeNull();
});

test("persist_pages_pending_edit_rebased_state stores the rebased row as the new authoritative pending state", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-persist-rebased",
			name: "pending-edits-persist-rebased",
			markdown: "# Sync base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
	});

	const remoteMarkdown = `${seeded.baseMarkdown}\n\nRemote drift`;
	const remoteDiff = await t.run(async (ctx) =>
		build_page_diff_update_from_snapshot({
			ctx,
			pageId: seeded.pageId,
			markdown: remoteMarkdown,
		}),
	);

	await asUser.mutation(api.ai_docs_temp.yjs_push_update, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		update: remoteDiff,
		sessionId: "remote-session",
	});

	const latestPageState = await t.run(async (ctx) =>
		read_page_yjs_state({
			ctx,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		}),
	);
	const latestBaseYjsDoc = pages_yjs_doc_create_from_array_buffer_update(latestPageState.yjsUpdate);

	const unstagedBranchYjsDoc = pages_yjs_doc_clone({
		yjsDoc: latestBaseYjsDoc,
	});
	const unstagedBranchProjection = pages_yjs_doc_update_from_markdown({
		mut_yjsDoc: unstagedBranchYjsDoc,
		markdown: `${remoteMarkdown}\n\nUnresolved only`,
	});
	if (unstagedBranchProjection._nay) {
		throw new Error("Failed to create unstaged rebased branch while testing pending edit persistence");
	}

	const persistResult = await asUser.mutation(api.ai_chat.persist_pages_pending_edit_rebased_state, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		baseYjsSequence: latestPageState.yjsSequence,
		baseYjsUpdate: latestPageState.yjsUpdate,
		stagedBranchYjsUpdate: latestPageState.yjsUpdate,
		unstagedBranchYjsUpdate: pages_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
	});
	if (persistResult._nay) {
		throw new Error(persistResult._nay.message);
	}
	expect(persistResult._yay.pendingEdit).not.toBeNull();
	expect(persistResult._yay.pendingEdit!.baseYjsSequence).toBe(1);

	const pendingAfterPersist = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	expect(pendingAfterPersist).not.toBeNull();

	const pendingAfterPersistMarkdownState = read_pending_row_markdown_state({
		pendingEdit: pendingAfterPersist!,
	});
	expect(pendingAfterPersistMarkdownState.baseMarkdown).toContain("Remote drift");
	expect(pendingAfterPersistMarkdownState.stagedMarkdown).toBe(pendingAfterPersistMarkdownState.baseMarkdown);
	expect(pendingAfterPersistMarkdownState.unstagedMarkdown).toContain("Remote drift");
	expect(pendingAfterPersistMarkdownState.unstagedMarkdown).toContain("Unresolved only");
});

test("persist_pages_pending_edit_rebased_state clears the pending row when the rebased branches match the live base", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-persist-clear",
			name: "pending-edits-persist-clear",
			markdown: "# Sync base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
	});

	const latestPageState = await t.run(async (ctx) =>
		read_page_yjs_state({
			ctx,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		}),
	);

	const clearResult = await asUser.mutation(api.ai_chat.persist_pages_pending_edit_rebased_state, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		baseYjsSequence: latestPageState.yjsSequence,
		baseYjsUpdate: latestPageState.yjsUpdate,
		stagedBranchYjsUpdate: latestPageState.yjsUpdate,
		unstagedBranchYjsUpdate: latestPageState.yjsUpdate,
	});
	if (clearResult._nay) {
		throw new Error(clearResult._nay.message);
	}
	expect(clearResult._yay.pendingEdit).toBeNull();

	const pendingAfterClear = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	expect(pendingAfterClear).toBeNull();
});

test("persist_pages_pending_edit_rebased_state rejects stale live bases", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-persist-stale",
			name: "pending-edits-persist-stale",
			markdown: "# Sync base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const stalePageState = await t.run(async (ctx) =>
		read_page_yjs_state({
			ctx,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		}),
	);

	const remoteDiff = await t.run(async (ctx) =>
		build_page_diff_update_from_snapshot({
			ctx,
			pageId: seeded.pageId,
			markdown: `${seeded.baseMarkdown}\n\nRemote drift`,
		}),
	);

	await asUser.mutation(api.ai_docs_temp.yjs_push_update, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		update: remoteDiff,
		sessionId: "remote-session",
	});

	const stalePersistResult = await asUser.mutation(api.ai_chat.persist_pages_pending_edit_rebased_state, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		baseYjsSequence: stalePageState.yjsSequence,
		baseYjsUpdate: stalePageState.yjsUpdate,
		stagedBranchYjsUpdate: stalePageState.yjsUpdate,
		unstagedBranchYjsUpdate: stalePageState.yjsUpdate,
	});
	expect(stalePersistResult._nay?.message).toBe(
		"Pending edit base is stale and must be rebuilt from the latest live page state",
	);
});

test("remove_pages_pending_edit_if_expired ignores stale scheduled runs", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-cleanup-stale",
			name: "pending-edits-cleanup-stale",
			markdown: "# Cleanup stale base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const firstMarkdown = `${seeded.baseMarkdown}\n\nCleanup pending first`;
	const firstUpsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: firstMarkdown,
	});
	if (firstUpsertResult._nay) {
		throw new Error(firstUpsertResult._nay.message);
	}

	const firstPendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	if (!firstPendingRow) {
		throw new Error("Missing first pending row while testing stale cleanup");
	}

	const firstCleanupTask = await t.run(async (ctx) => {
		const cleanupTasks = await list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: firstPendingRow._id,
		});
		return cleanupTasks[0] ?? null;
	});
	if (!firstCleanupTask) {
		throw new Error("Missing first cleanup task while testing stale cleanup");
	}

	await new Promise((resolve) => setTimeout(resolve, 2));

	const secondMarkdown = `${seeded.baseMarkdown}\n\nCleanup pending second`;
	const secondUpsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: secondMarkdown,
		unstagedMarkdown: secondMarkdown,
	});
	if (secondUpsertResult._nay) {
		throw new Error(secondUpsertResult._nay.message);
	}

	await t.mutation(internal.ai_chat.remove_pages_pending_edit_if_expired, {
		pendingEditId: firstPendingRow._id,
		expectedUpdatedAt: firstCleanupTask.expectedUpdatedAt,
	});

	const pendingAfterStaleCleanup = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	expect(pendingAfterStaleCleanup).not.toBeNull();

	const cleanupTasksAfterStaleCleanup = await t.run((ctx) =>
		list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: firstPendingRow._id,
		}),
	);
	expect(cleanupTasksAfterStaleCleanup).toHaveLength(1);
	expect(cleanupTasksAfterStaleCleanup[0]!.expectedUpdatedAt).toBe(pendingAfterStaleCleanup!.updatedAt);
});

test("remove_pages_pending_edit_if_expired deletes matching pending edits", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-cleanup-expired",
			name: "pending-edits-cleanup-expired",
			markdown: "# Cleanup expired base",
		}),
	);
	const asUser = t.withIdentity({
		issuer: "https://clerk.test",
		external_id: seeded.userId,
		name: "Test User",
	});

	const changedMarkdown = `${seeded.baseMarkdown}\n\nCleanup expired`;
	const upsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		stagedMarkdown: seeded.baseMarkdown,
		unstagedMarkdown: changedMarkdown,
	});
	if (upsertResult._nay) {
		throw new Error(upsertResult._nay.message);
	}

	const pendingRow = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	if (!pendingRow) {
		throw new Error("Missing pending row while testing expired cleanup");
	}

	const cleanupTask = await t.run(async (ctx) => {
		const cleanupTasks = await list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: pendingRow._id,
		});
		return cleanupTasks[0] ?? null;
	});
	if (!cleanupTask) {
		throw new Error("Missing cleanup task while testing expired cleanup");
	}

	await t.mutation(internal.ai_chat.remove_pages_pending_edit_if_expired, {
		pendingEditId: pendingRow._id,
		expectedUpdatedAt: cleanupTask.expectedUpdatedAt,
	});

	const pendingAfterCleanup = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId)
					.eq("pageId", seeded.pageId),
			)
			.first(),
	);
	expect(pendingAfterCleanup).toBeNull();

	const cleanupTasksAfterCleanup = await t.run((ctx) =>
		list_pending_edit_cleanup_tasks({
			ctx,
			pendingEditId: pendingRow._id,
		}),
	);
	expect(cleanupTasksAfterCleanup).toHaveLength(0);
});
