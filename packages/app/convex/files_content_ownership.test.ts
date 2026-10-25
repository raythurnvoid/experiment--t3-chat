import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { QueryCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import { api, internal } from "./_generated/api.js";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_pending_update_run,
	test_finish_saved_scope_jobs,
	test_finish_transfer_run,
	test_mocks_fill_db_with,
	test_spy_handler,
} from "./setup.test.ts";
import {
	files_saved_content_collect,
	files_saved_content_db_plain_text_chunks,
	files_saved_content_db_text_chunks,
} from "../server/files-saved-content.ts";
import { files_saved_content_db_get_head } from "../server/files-saved-content-head.ts";
import * as overlay from "../server/files-pending-overlay.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_node_view,
} from "../server/files-saved-placement.ts";

const text = "---\ntopic: ownership\nstatus: saved\n---\nContent stays with this file.\n";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function read_content(ctx: QueryCtx, nodeId: Id<"files_nodes">) {
	const node = await files_saved_placement_db_get_node(ctx.db, nodeId);
	if (!node) throw new Error("Expected the saved file");
	const scope = { organizationId: node.organizationId, workspaceId: node.workspaceId, nodeId };
	const head = await files_saved_content_db_get_head(ctx.db, node);
	if (!head) throw new Error("Expected the saved content head");
	const exact = await files_saved_content_collect(files_saved_content_db_text_chunks(ctx.db, scope));
	const plain = await files_saved_content_collect(files_saved_content_db_plain_text_chunks(ctx.db, scope));
	const view = await files_saved_placement_db_get_node_view(ctx.db, nodeId);
	const metadata = (
		await Promise.all(
			(view ? [undefined, view] : [undefined]).map((tag) =>
				ctx.db
					.query("files_metadata_docs")
					.withIndex("by_contentHead_view_fieldPath", (q) =>
						q.eq("contentHeadId", head._id).eq("moveView.cohortId", tag?.cohortId).eq("moveView.view", tag?.view),
					)
					.collect(),
			),
		)
	).flat();
	const copies = await ctx.db
		.query("files_metadata_docs")
		.withIndex("by_contentHead_fieldPath", (q) => q.eq("contentHeadId", head._id))
		.collect();
	return {
		node,
		headId: head._id,
		view,
		text: exact.map((row) => row.textChunk).join(""),
		exactIds: exact.map((row) => row._id),
		plain: plain.map((row) => ({ index: row.chunkIndex, text: row.plainTextChunk, view: row.moveView })),
		fields: metadata
			.filter((row) => row.docKind === "field")
			.map((row) => row.fieldPath)
			.sort(),
		values: metadata
			.filter((row) => row.docKind === "value")
			.map((row) => [row.fieldPath, row.stringValue])
			.sort(),
		hasAfterCopy: copies.some((row) => row.moveView?.view === "after"),
	};
}

test("Move and reviewed Archive keep one selected content and metadata view", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/note.md",
		textContent: text,
	});
	await test_finish_saved_scope_jobs(t);
	const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: db.membershipId,
		parentId: "root",
		path: "/target",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	const original = await t.run((ctx) => read_content(ctx, nodeId));
	expect(original.text).toBe(text);
	expect(original.exactIds).toHaveLength(1);
	expect(original.plain).toHaveLength(1);
	// Expose transaction boundaries with one file, without adding a large fixture.
	vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockResolvedValue(false);
	const observations: Array<Awaited<ReturnType<typeof read_content>>> = [];
	const move = await asUser.mutation(api.files_transfer.accept_input, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "move",
		expectedSourceCount: 1,
		sourceIds: [nodeId],
		targetParentId: folder._yay.nodeId,
	});
	if (move._nay) throw new Error(move._nay.message);
	expect(
		await asUser.mutation(api.files_transfer.seal, {
			membershipId: db.membershipId,
			runId: move._yay.runId,
		}),
	).toEqual({ _yay: null });
	await test_finish_transfer_run(asUser, move._yay.runId, async () => {
		const current = await t.run((ctx) => read_content(ctx, nodeId));
		observations.push(current);
		const scope = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			subject: { kind: "user" as const, userId: db.userId, plugin: null },
			path: current.node.path,
		};
		expect(
			await t.query(internal.files_nodes.read_file_content_from_chunks, {
				...scope,
				committedOnly: true,
				mode: { kind: "full", maxBytes: 1_000 },
			}),
		).toMatchObject({ content: text, target: { kind: "saved", id: nodeId } });
		expect(await t.query(internal.files_metadata.get_index_values_by_path, scope)).toMatchObject({
			fields: ["frontmatter.status", "frontmatter.topic"],
			values: [
				{ fieldPath: "frontmatter.status", valueKind: "string", stringValue: "saved" },
				{ fieldPath: "frontmatter.topic", valueKind: "string", stringValue: "ownership" },
			],
		});
	});
	await test_finish_saved_scope_jobs(t);
	const moved = await t.run((ctx) => read_content(ctx, nodeId));
	expect(moved.node.path).toBe("/target/note.md");
	expect(moved.node.updatedAt, "Move keeps the content modified time").toBe(original.node.updatedAt);
	expect(
		observations.some((row) => row.view?.view === "before" && row.hasAfterCopy),
		"observe staged derived copies",
	).toBe(true);
	expect(
		observations.some((row) => row.view?.view === "after"),
		"observe publication before cleanup",
	).toBe(true);

	// Review Archive uses the same location views as Move. The direct Archive door has its own stamp worker.
	vi.setSystemTime(Date.now() + 10_000);
	const archiveTime = Date.now();
	expect(
		await t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target: { kind: "saved", id: nodeId },
		}),
	).toHaveProperty("_yay");
	const proposal = await t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) => q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", nodeId))
			.unique(),
	);
	if (!proposal) throw new Error("Expected the pending Archive");
	const archived = await asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: 1,
		items: [{ pendingUpdateId: proposal._id, reviewedRevision: proposal.revision, selectedContentStateId: null }],
	});
	if (archived._nay) throw new Error(archived._nay.message);
	expect(
		await asUser.mutation(api.files_pending_update_runs.seal, {
			membershipId: db.membershipId,
			runId: archived._yay.runId,
		}),
	).toEqual({ _yay: null });
	const archiveObservations: typeof observations = [];
	test_spy_handler(advance_cohort, async (handler, ctx, args) => {
		const result = await handler(ctx, args);
		archiveObservations.push(await read_content(ctx, nodeId));
		return result;
	});
	await test_finish_pending_update_run(asUser, archived._yay.runId, { stepwise: true });
	await test_finish_saved_scope_jobs(t);
	const final = await t.run((ctx) => read_content(ctx, nodeId));
	expect(final.node.archiveOperationId).not.toBeNull();
	expect(final.node.updatedAt, "Archive keeps its later modified time after cleanup").toBe(archiveTime);
	expect(
		archiveObservations.some((row) => row.view?.view === "before" && row.hasAfterCopy),
		"observe Archive staging",
	).toBe(true);
	expect(
		archiveObservations.some((row) => row.view?.view === "after" && row.node.archiveOperationId !== null),
		"observe Archive publication",
	).toBe(true);
	for (const current of [...observations, moved, ...archiveObservations, final]) {
		expect(current.headId, "location work keeps the saved content owner").toBe(original.headId);
		expect(current.text, "exact reads do not repeat content from another location view").toBe(text);
		expect(current.exactIds).toEqual(original.exactIds);
		expect(
			current.plain.map((row) => ({ index: row.index, text: row.text })),
			"plain text has one doc per chunk",
		).toEqual(original.plain.map((row) => ({ index: row.index, text: row.text })));
		expect(
			current.plain.every((row) => row.view === undefined || row.view.view === current.view?.view),
			"plain text excludes the opposite view",
		).toBe(true);
		expect(current.fields, "frontmatter fields have no opposite-view duplicates").toEqual([
			"frontmatter.status",
			"frontmatter.topic",
		]);
		expect(current.values, "frontmatter values have no opposite-view duplicates").toEqual([
			["frontmatter.status", "saved"],
			["frontmatter.topic", "ownership"],
		]);
	}
});
