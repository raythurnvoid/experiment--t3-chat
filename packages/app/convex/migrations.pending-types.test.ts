import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runToCompletion } from "@convex-dev/migrations";
import migrations_test from "@convex-dev/migrations/test";
import { components, internal } from "./_generated/api.js";
import { fixture, parent, target } from "./files_pending_overlay.setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function old_data() {
	const f = await fixture();
	f.t.registerComponent("migrations", migrations_test.schema, migrations_test.modules);
	await f.create_private("/draft.md");
	const saved = await f.saved(null, "saved.md");
	const folder = await f.saved(null, "destination", "folder");
	await f.draft_move(target(saved), parent(folder), "moved.md");
	await f.settle();
	const before = await f.t.run(async (ctx) => {
		const entries = await ctx.db.query("files_pending_type_entries").collect();
		for (const entry of entries) await ctx.db.delete("files_pending_type_entries", entry._id);
		return {
			files: await ctx.db.query("files_nodes").collect(),
			proposals: await ctx.db.query("files_pending_updates").collect(),
			privateNodes: await ctx.db.query("files_pending_nodes").collect(),
		};
	});
	return { ...f, before };
}

test("draft search stays closed during the typed backfill", async () => {
	const f = await fixture();
	const request = {
		...f.u,
		rootPath: "/",
		contentType: "text/",
		directoriesOnly: false,
		limit: 1,
	};
	const pending = await f.t.mutation(internal.files_type_queries.begin, { ...request, overlay: true });
	expect(pending._nay?.message).toBe("Content-type search is being prepared. Try again later.");
	expect(await f.t.run((ctx) => ctx.db.query("files_type_queries").collect())).toEqual([]);
	const saved = await f.t.mutation(internal.files_type_queries.begin, { ...request, overlay: false });
	expect(saved._nay).toBeUndefined();
});

test("old repair cursors share one counted job with the current phases", async () => {
	const f = await old_data();
	const cursor = JSON.stringify({ phase: 4, page: "old-native-cursor" });
	await expect(
		f.t.mutation(internal.files_pending_overlay.repair_user, { ...f.u, cursor }),
		"a queued old repair must reach the counted handoff",
	).resolves.toBeNull();
	await f.t.mutation(internal.files_pending_overlay.repair_user, { ...f.u, cursor });
	const jobs = await f.t.run((ctx) => ctx.db.query("files_pending_overlay_jobs").collect());
	expect(jobs.filter((job) => job.kind === "repair_user")).toHaveLength(1);
	expect(jobs.find((job) => job.kind === "repair_user")?.cursor).toBeNull();
	await f.settle();
	expect(await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect())).toHaveLength(2);
	expect(await f.t.run((ctx) => ctx.db.query("files_pending_overlay_jobs").collect())).toEqual([]);
	expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toEqual(f.before.proposals);
	await f.expect_overlay_true();
});

test("the typed backfill restores actual pending entries and preserves all source data", async () => {
	const f = await old_data();
	const status = await f.t.action((ctx) =>
		runToCompletion(ctx, components.migrations, internal.migrations.backfill_pending_types),
	);
	expect(status.isDone).toBe(true);
	await f.settle();
	const after = await f.t.run(async (ctx) => ({
		files: await ctx.db.query("files_nodes").collect(),
		proposals: await ctx.db.query("files_pending_updates").collect(),
		privateNodes: await ctx.db.query("files_pending_nodes").collect(),
		entries: await ctx.db.query("files_pending_type_entries").collect(),
		jobs: await ctx.db.query("files_pending_overlay_jobs").collect(),
	}));
	expect(after.files).toEqual(f.before.files);
	expect(after.proposals).toEqual(f.before.proposals);
	expect(after.privateNodes).toEqual(f.before.privateNodes);
	expect(after.entries, "one typed entry for each real create or move").toHaveLength(2);
	expect(after.jobs).toEqual([]);
	await f.expect_overlay_true();
	const audit = await f.t.query(internal.migrations.audit_pending_type_source_page, { cursor: null });
	expect(audit.page).toEqual([f.u, f.u]);
	expect(audit.isDone).toBe(true);
});

test("the preview rolls back its cross-table work before returning its safe receipt", async () => {
	const f = await old_data();
	await expect(f.t.mutation(internal.migrations.preview_pending_types, { cursor: null })).rejects.toThrow(
		"Pending type preview rolled back",
	);
	expect(await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect())).toEqual([]);
	expect(await f.t.run((ctx) => ctx.db.query("files_pending_overlay_jobs").collect())).toEqual([]);
	// The same batch without rollback must really write the derived entry.
	await f.t.mutation(internal.migrations.backfill_pending_types, {
		cursor: null,
		batchSize: 1,
		oneBatchOnly: true,
		dryRun: false,
	});
	await f.settle();
	expect(await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect())).toHaveLength(1);
});
