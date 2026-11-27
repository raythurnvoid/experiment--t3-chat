import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_file_index,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_db_get_slot_cohort,
	test_finish_transfer_run,
} from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("preview rolls back and strip refuses a missing or different exact snippet", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/note.md",
		textContent: Array.from({ length: 3 }, (_, index) => `# Original ${index}\n\n${"word ".repeat(210)}`).join("\n\n"),
	});
	await test_finish_file_index(t, nodeId);
	const { row, exact } = await t.run(async (ctx) => {
		const row = (await ctx.db.query("files_plain_text_chunks").first())!;
		const exact = (await ctx.db.get("files_text_chunks", row.textChunkId))!;
		await ctx.db.patch("files_plain_text_chunks", row._id, { textChunk: exact.textChunk, path: "/note.md" });
		return { row, exact };
	});
	const old = await t.run((ctx) => ctx.db.get("files_plain_text_chunks", row._id));
	const batch = { oneBatchOnly: true, dryRun: false, cursor: null, batchSize: 16 };
	const all = await t.run((ctx) => ctx.db.query("files_plain_text_chunks").collect());
	expect(all.length).toBeGreaterThan(1);
	const scan = {
		cutoff: all.at(-1)!._creationTime,
		afterTime: null,
		cursor: null,
		digest: "",
		strict: false,
		pageSize: 1,
	};
	const before = await t.action(internal.migrations.hash_search_pages, scan);
	expect(before).toMatchObject({ done: true, rows: all.length, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
	await expect(t.query(internal.migrations.audit_search_chunks, { ...scan, strict: true })).rejects.toThrow(
		"Legacy search fields remain",
	);
	await expect(t.mutation(internal.migrations.preview_search_chunks, { cursor: null })).rejects.toThrow(
		"Search preview rolled back",
	);
	expect(await t.run((ctx) => ctx.db.get("files_plain_text_chunks", row._id))).toEqual(old);
	await t.run((ctx) => ctx.db.patch("files_text_chunks", exact._id, { textChunk: "different" }));
	await expect(t.mutation(internal.migrations.strip_search_chunks, batch)).rejects.toThrow("Search source differs");
	expect(await t.run((ctx) => ctx.db.get("files_plain_text_chunks", row._id))).toEqual(old);
	await t.run((ctx) => ctx.db.patch("files_text_chunks", exact._id, { textChunk: exact.textChunk }));
	await t.mutation(internal.migrations.strip_search_chunks, batch);
	expect(await t.run((ctx) => ctx.db.get("files_plain_text_chunks", row._id))).toEqual(row);
	const after = await t.action(internal.migrations.hash_search_pages, { ...scan, strict: true, pageSize: 128 });
	expect(after).toMatchObject({ done: true, rows: all.length, digest: before.digest, cutoff: before.cutoff });
	await t.run((ctx) => ctx.db.patch("files_text_chunks", exact._id, { textChunk: "changed after strip" }));
	expect(
		(await t.action(internal.migrations.hash_search_pages, { ...scan, strict: true })).digest,
		"the hash covers the returned Markdown",
	).not.toBe(before.digest);
	await t.run((ctx) => ctx.db.patch("files_text_chunks", exact._id, { textChunk: exact.textChunk }));
	await t.run((ctx) => ctx.db.patch("files_plain_text_chunks", row._id, { hasChunkBelow: !row.hasChunkBelow }));
	expect((await t.action(internal.migrations.hash_search_pages, { ...scan, strict: true })).digest).not.toBe(
		before.digest,
	);
	await t.run((ctx) => ctx.db.delete("files_text_chunks", exact._id));
	await expect(t.query(internal.migrations.audit_search_chunks, scan)).rejects.toThrow("Search source differs");
});

test("a discarded draft waits for cleanup even after its exact source is gone", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const create = await t.mutation(internal.files_nodes.create_private_node_by_path, {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		path: "/draft.md",
		kind: "file",
	});
	if (!create._yay?.pendingUpdateId) throw new Error("Expected a draft");
	const { pendingUpdateId, target } = create._yay;
	const searchId = await t.run(async (ctx) => {
		const proposal = (await ctx.db.get("files_pending_updates", pendingUpdateId))!;
		const fields = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target,
			pendingUpdateId,
			sourceKind: "pending" as const,
			proposalRevision: proposal.revision,
			chunkIndex: 0,
			startIndex: 0,
			endIndex: 4,
			lineStart: 1,
			lineEnd: 1,
			chunkFlags: 0,
		};
		const textChunkId = await ctx.db.insert("files_text_chunks", { ...fields, textChunk: "draft" });
		const id = await ctx.db.insert("files_plain_text_chunks", {
			...fields,
			textChunkId,
			path: "/draft.md",
			textChunk: "draft",
			plainTextChunk: "draft",
			hasChunkBelow: false,
			hasChunkAbove: false,
		});
		await ctx.db.delete("files_pending_updates", pendingUpdateId);
		await ctx.db.delete("files_text_chunks", textChunkId);
		return id;
	});
	const batch = { oneBatchOnly: true, dryRun: false, cursor: null };
	await expect(t.mutation(internal.migrations.strip_search_chunks, batch)).rejects.toThrow(
		"has no current draft. Wait for its cleanup.",
	);
	expect(await t.run((ctx) => ctx.db.get("files_plain_text_chunks", searchId))).toHaveProperty("textChunk", "draft");
	await t.mutation(internal.files_pending_updates.drain_pending_update_docs, { pendingUpdateId });
	vi.advanceTimersByTime(1);
	await t.finishInProgressScheduledFunctions();
	expect(await t.run((ctx) => ctx.db.get("files_plain_text_chunks", searchId))).toBeNull();
});

test("a legacy Move copy with the next Save's head keeps its old Markdown", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const user = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/note.md",
		textContent: "# Original",
	});
	await test_finish_file_index(t, nodeId);
	const rename = await user.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		nodeId,
		path: "changed.md",
	});
	if (!rename._yay) throw new Error("Expected a rename");
	for (let step = 0; step < 100 && !(await t.run((ctx) => test_db_get_slot_cohort(ctx, db))); step++)
		await t.mutation(internal.files_transfer.advance, { runId: rename._yay.runId });
	const cohort = (await t.run((ctx) => test_db_get_slot_cohort(ctx, db)))!;
	await test_finish_transfer_run(user, rename._yay.runId);
	const saved = await t.run(async (ctx) => {
		const row = (await ctx.db.query("files_plain_text_chunks").first())!;
		if (row.sourceKind !== "committed" || !row.contentHeadId) throw new Error("Expected a published search row");
		const {
			_id: originalHead,
			_creationTime,
			...head
		} = (await ctx.db.get("files_saved_content_heads", row.contentHeadId))!;
		const nextHead = await ctx.db.insert("files_saved_content_heads", head);
		await ctx.db.patch("files_nodes", nodeId, { contentHeadId: nextHead });
		const exact = (await ctx.db.get("files_text_chunks", row.textChunkId))!;
		return { row, originalHead, nextHead, raw: exact.textChunk };
	});
	const legacyId = await test_run_with_flush(t, async (ctx) => {
		const { _id, _creationTime, ...fields } = saved.row;
		// The old Move writer inserted through the current owner's wrapper.
		return await ctx.db.insert("files_plain_text_chunks", {
			...fields,
			path: "/changed.md",
			textChunk: saved.raw,
			moveView: { cohortId: cohort._id, view: "after" },
		});
	});
	await t.run((ctx) => ctx.db.patch("files_plain_text_chunks", legacyId, { moveView: undefined }));
	const read = () => t.run((ctx) => ctx.db.get("files_plain_text_chunks", legacyId));
	expect(await read()).toMatchObject({ contentHeadId: saved.nextHead, textChunkId: saved.row.textChunkId });
	expect(await t.run((ctx) => ctx.db.get("files_text_chunks", saved.row.textChunkId))).toMatchObject({
		contentHeadId: saved.originalHead,
	});
	await expect(
		t.mutation(internal.migrations.strip_search_chunks, { oneBatchOnly: true, dryRun: false, cursor: null }),
	).rejects.toThrow("Search source differs");
	expect(await read()).toHaveProperty("textChunk", saved.raw);
});
