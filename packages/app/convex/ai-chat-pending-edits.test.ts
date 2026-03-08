import { expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_mocks_hardcoded } from "./setup.test.ts";
import type { MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import {
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
		workingBranchYjsUpdate: ArrayBuffer;
		modifiedBranchYjsUpdate: ArrayBuffer;
	};
}) {
	const baseYjsDoc = pages_yjs_doc_create_from_array_buffer_update(args.pendingEdit.baseYjsUpdate);
	const workingBranchYjsDoc = pages_yjs_doc_create_from_array_buffer_update(args.pendingEdit.workingBranchYjsUpdate);
	const modifiedBranchYjsDoc = pages_yjs_doc_create_from_array_buffer_update(args.pendingEdit.modifiedBranchYjsUpdate);

	const baseMarkdown = pages_yjs_doc_get_markdown({
		yjsDoc: baseYjsDoc,
	});
	const workingMarkdown = pages_yjs_doc_get_markdown({
		yjsDoc: workingBranchYjsDoc,
	});
	const modifiedMarkdown = pages_yjs_doc_get_markdown({
		yjsDoc: modifiedBranchYjsDoc,
	});

	if (baseMarkdown._nay || workingMarkdown._nay || modifiedMarkdown._nay) {
		throw new Error("Failed to reconstruct pending row markdown");
	}

	return {
		baseMarkdown: baseMarkdown._yay,
		workingMarkdown: workingMarkdown._yay,
		modifiedMarkdown: modifiedMarkdown._yay,
	};
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
		workingMarkdown: seeded.baseMarkdown,
		modifiedMarkdown: changedMarkdown,
	});
	if (unresolved._nay) {
		throw new Error(unresolved._nay.message);
	}
	expect(unresolved._yay).toBeNull();

	const ready = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		workingMarkdown: changedMarkdown,
		modifiedMarkdown: changedMarkdown,
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
		workingMarkdown: changedMarkdown,
		modifiedMarkdown: changedMarkdown,
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
	expect(secondPendingRowMarkdownState.workingMarkdown).toContain("Changed once");
	expect(secondPendingRowMarkdownState.modifiedMarkdown).toContain("Changed once");
	expect(secondPendingRowMarkdownState.workingMarkdown).toBe(secondPendingRowMarkdownState.modifiedMarkdown);

	const discarded = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		workingMarkdown: seeded.baseMarkdown,
		modifiedMarkdown: seeded.baseMarkdown,
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

	const workingMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
	const modifiedMarkdown = `${workingMarkdown}\n\nUnresolved chunk`;
	await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		workingMarkdown,
		modifiedMarkdown,
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
	expect(pendingAfterSaveMarkdownState.workingMarkdown).toBe(pendingAfterSaveMarkdownState.baseMarkdown);
	expect(pendingAfterSaveMarkdownState.modifiedMarkdown).toContain("Accepted chunk");
	expect(pendingAfterSaveMarkdownState.modifiedMarkdown).toContain("Unresolved chunk");

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

	const resolvedMarkdown = `${seeded.baseMarkdown}\n\nFully resolved`;
	const upsertResult = await asUser.mutation(api.ai_chat.upsert_pages_pending_edit_updates, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		workingMarkdown: resolvedMarkdown,
		modifiedMarkdown: resolvedMarkdown,
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
			path: "/pending-edits-save-no-working",
			name: "pending-edits-save-no-working",
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
		workingMarkdown: seeded.baseMarkdown,
		modifiedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
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
	expect(pendingAfterSaveMarkdownState.workingMarkdown).toBe(pendingAfterSaveMarkdownState.baseMarkdown);
	expect(pendingAfterSaveMarkdownState.modifiedMarkdown).toContain("Unresolved only");
	expect(pendingAfterSaveMarkdownState.modifiedMarkdown).toContain("Remote drift");

	const savedMarkdownAfterNoWorkingSave = await t.run(async (ctx) =>
		read_page_markdown_from_yjs({
			ctx,
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			pageId: seeded.pageId,
		}),
	);
	expect(savedMarkdownAfterNoWorkingSave).toContain("# Save base");
	expect(savedMarkdownAfterNoWorkingSave).toContain("Remote drift");
	expect(savedMarkdownAfterNoWorkingSave).not.toContain("Unresolved only");
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
		workingMarkdown: seeded.baseMarkdown,
		modifiedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
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

	const modifiedBranchYjsDoc = pages_yjs_doc_clone({
		yjsDoc: latestBaseYjsDoc,
	});
	const modifiedBranchProjection = pages_yjs_doc_update_from_markdown({
		mut_yjsDoc: modifiedBranchYjsDoc,
		markdown: `${remoteMarkdown}\n\nUnresolved only`,
	});
	if (modifiedBranchProjection._nay) {
		throw new Error("Failed to create modified rebased branch while testing pending edit persistence");
	}

	const persistResult = await asUser.mutation(api.ai_chat.persist_pages_pending_edit_rebased_state, {
		workspaceId: seeded.workspaceId,
		projectId: seeded.projectId,
		pageId: seeded.pageId,
		baseYjsSequence: latestPageState.yjsSequence,
		baseYjsUpdate: latestPageState.yjsUpdate,
		workingBranchYjsUpdate: latestPageState.yjsUpdate,
		modifiedBranchYjsUpdate: pages_u8_to_array_buffer(encodeStateAsUpdate(modifiedBranchYjsDoc)),
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
	expect(pendingAfterPersistMarkdownState.workingMarkdown).toBe(pendingAfterPersistMarkdownState.baseMarkdown);
	expect(pendingAfterPersistMarkdownState.modifiedMarkdown).toContain("Remote drift");
	expect(pendingAfterPersistMarkdownState.modifiedMarkdown).toContain("Unresolved only");
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
		workingMarkdown: seeded.baseMarkdown,
		modifiedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
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
		workingBranchYjsUpdate: latestPageState.yjsUpdate,
		modifiedBranchYjsUpdate: latestPageState.yjsUpdate,
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
		workingBranchYjsUpdate: stalePageState.yjsUpdate,
		modifiedBranchYjsUpdate: stalePageState.yjsUpdate,
	});
	expect(stalePersistResult._nay?.message).toBe(
		"Pending edit base is stale and must be rebuilt from the latest live page state",
	);
});

test("presence cleanup removes pages_pending_edits rows for offline users", async () => {
	const t = test_convex();

	const seeded = await t.run(async (ctx) =>
		seed_page_with_markdown({
			ctx,
			path: "/pending-edits-cleanup",
			name: "pending-edits-cleanup",
			markdown: "# Cleanup base",
		}),
	);

	await t.run(async (ctx) => {
		const baseYjsDoc = new YDoc();
		const baseYjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
			mut_yjsDoc: baseYjsDoc,
			markdown: seeded.baseMarkdown,
		});
		if (baseYjsDocFromMarkdown._nay) {
			throw new Error("Failed to build base Yjs doc while seeding cleanup pending edits");
		}

		const changedMarkdown = `${seeded.baseMarkdown}\n\nCleanup pending`;
		const workingYjsDoc = pages_yjs_doc_clone({
			yjsDoc: baseYjsDoc,
		});
		const workingYjsDocFromMarkdown = pages_yjs_doc_update_from_markdown({
			mut_yjsDoc: workingYjsDoc,
			markdown: changedMarkdown,
		});
		if (workingYjsDocFromMarkdown._nay) {
			throw new Error("Failed to build working Yjs doc while seeding cleanup pending edits");
		}

		await ctx.db.insert("pages_pending_edits", {
			workspaceId: seeded.workspaceId,
			projectId: seeded.projectId,
			userId: seeded.userId,
			pageId: seeded.pageId,
			baseYjsSequence: 0,
			baseYjsUpdate: pages_u8_to_array_buffer(encodeStateAsUpdate(baseYjsDoc)),
			workingBranchYjsUpdate: pages_u8_to_array_buffer(encodeStateAsUpdate(workingYjsDoc)),
			modifiedBranchYjsUpdate: pages_u8_to_array_buffer(encodeStateAsUpdate(workingYjsDoc)),
			updatedAt: Date.now(),
		});
	});

	await t.mutation(internal.presence.remove_pending_edits_if_offline, {
		userId: seeded.userId,
	});

	const pendingAfterCleanup = await t.run(async (ctx) =>
		ctx.db
			.query("pages_pending_edits")
			.withIndex("by_workspace_project_user_page", (q) =>
				q
					.eq("workspaceId", seeded.workspaceId)
					.eq("projectId", seeded.projectId)
					.eq("userId", seeded.userId),
			)
			.collect(),
	);
	expect(pendingAfterCleanup).toHaveLength(0);
});
