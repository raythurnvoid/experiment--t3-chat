import { convexToJson } from "convex/values";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_pending_overlay_db_schedule_saved_scope } from "../server/files-pending-overlay.ts";
import { internal } from "./_generated/api.js";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_file_index,
	test_finish_saved_scope_jobs,
	test_mocks_fill_db_with,
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

async function saved_file() {
	const t = test_convex({ transactionLimits: true });
	const { membershipId, userId } = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const nodeId = await test_create_saved_text_file(t, {
		membershipId,
		path: "/note.md",
		textContent: Array.from({ length: 12 }, (_, i) => `# Section ${i}\n\n${"word ".repeat(210)}`).join("\n\n"),
	});
	await test_finish_file_index(t, nodeId);
	await test_finish_saved_scope_jobs(t);
	vi.setSystemTime(Date.now() + 60_000);
	return { t, nodeId, userId };
}

const start = { cutoff: null, afterTime: null, cursor: null, digest: "", strict: false, pageSize: 1 };

test("the old writers' Markdown has the same hash across a resumed audit", async () => {
	const { t } = await saved_file();
	const rows = await t.run((ctx) => ctx.db.query("files_plain_text_chunks").collect());
	expect(rows.length).toBeGreaterThan(8);
	let digest = "";
	for (const { path, textChunk, ...kept } of rows) {
		expect(path).toBe("/note.md");
		expect(textChunk).toContain("word");
		digest = await crypto_sha256_hex(JSON.stringify([digest, convexToJson(kept), textChunk]));
	}
	const first = await t.action(internal.migrations.hash_search_pages, start);
	expect(first).toMatchObject({ done: false, cutoff: Date.now(), rows: 8 });
	const last = await t.action(internal.migrations.hash_search_pages, {
		...start,
		cutoff: first.cutoff,
		cursor: first.cursor,
		digest: first.digest,
		pageSize: 128,
	});
	expect(last).toMatchObject({ done: true, cutoff: first.cutoff, rows: rows.length - first.rows, digest });
	expect(await t.run((ctx) => ctx.db.query("files_plain_text_chunks").collect())).toEqual(rows);
	await t.run((ctx) => ctx.db.delete("files_text_chunks", rows[0]!.textChunkId));
	await expect(t.action(internal.migrations.hash_search_pages, start)).rejects.toThrow("Search source differs");
	expect(await t.run((ctx) => ctx.db.get("files_plain_text_chunks", rows[0]!._id))).toEqual(rows[0]);
});

test("a resumed audit waits for queued index, saved scope, and subtree work", async () => {
	const { t, nodeId, userId } = await saved_file();
	const first = await t.action(internal.migrations.hash_search_pages, start);
	const resume = { ...start, cutoff: first.cutoff, cursor: first.cursor, digest: first.digest, pageSize: 128 };
	const state = await t.run((ctx) =>
		ctx.db
			.query("files_index_states")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.unique(),
	);
	expect(state).toMatchObject({ activeRunId: null, needsRun: false });
	await t.run((ctx) => ctx.db.patch("files_index_states", state!._id, { needsRun: true }));
	await expect(
		t.action(internal.migrations.hash_search_pages, resume),
		"queued index blocks the next page",
	).rejects.toThrow("Wait for Move and index work");
	await t.run(async (ctx) => {
		await ctx.db.patch("files_index_states", state!._id, { needsRun: false });
		await files_pending_overlay_db_schedule_saved_scope(ctx, (await ctx.db.get("files_nodes", nodeId))!);
	});
	await expect(
		t.action(internal.migrations.hash_search_pages, resume),
		"saved scope blocks the next page",
	).rejects.toThrow("Wait for Move and index work");
	await test_finish_saved_scope_jobs(t);
	const op = await t.run((ctx) =>
		ctx.db.insert("files_subtree_ops", {
			kind: "scope",
			rootNodeIds: [nodeId],
			treePaths: ["/note.md"],
			userId,
			organizationId: state!.organizationId,
			workspaceId: state!.workspaceId,
			status: "running",
			blockedByOpId: null,
		}),
	);
	await expect(
		t.action(internal.migrations.hash_search_pages, resume),
		"subtree work blocks the next page",
	).rejects.toThrow("Wait for Move and index work");
	await t.run((ctx) => ctx.db.delete("files_subtree_ops", op));
	expect(await t.action(internal.migrations.hash_search_pages, resume)).toMatchObject({ done: true });
});
