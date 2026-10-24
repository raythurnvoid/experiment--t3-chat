import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_convex, test_finish_pending_update_run, test_spy_handler } from "./setup.test.ts";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import {
	mock_pending_updates_storage,
	seed_signed_in_file_with_markdown,
	upsert_file_pending_update_internal_for_test,
} from "./files_pending_updates.setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_pending_updates_storage();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture() {
	const t = test_convex();
	const file = await t.run((ctx) =>
		seed_signed_in_file_with_markdown({ ctx, path: "/strip.md", name: "strip.md", markdown: "base\n" }),
	);
	const proposed = await upsert_file_pending_update_internal_for_test({
		t,
		...file,
		stagedMarkdown: "accepted\n",
		unstagedMarkdown: "remaining\n",
	});
	if (proposed._nay) throw new Error(proposed._nay.message);
	const proposal = (await t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) =>
				q.eq("userId", file.userId).eq("target.kind", "saved").eq("target.id", file.nodeId),
			)
			.unique(),
	))!;
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: file.userId });
	await t.run((ctx) =>
		ctx.db.patch("files_pending_updates", proposal._id, {
			contentNeedsRebase: true,
			contentRebaseRootKind: "rich_text",
		}),
	);
	return { t, ...file, proposal, asUser };
}

async function start(f: Awaited<ReturnType<typeof fixture>>) {
	const result = await f.asUser.mutation(api.files_pending_update_runs.start, {
		membershipId: f.membershipId,
		requestId: crypto.randomUUID(),
		kind: "accept",
		expectedItemCount: 1,
		items: [
			{
				pendingUpdateId: f.proposal._id,
				reviewedRevision: f.proposal.revision,
				selectedContentStateId: f.proposal.content!.stagedStateId,
			},
		],
	});
	if (result._nay) throw new Error(result._nay.message);
	const runId = result._yay.runId;
	expect(await f.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: f.membershipId, runId })).toEqual({
		_yay: null,
	});
	return runId;
}

test("new Review and cohort headers omit old flags before strip", async () => {
	const f = await fixture();
	const runId = await start(f);
	const review = (await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_update_run_items")
			.withIndex("by_run_order", (q) => q.eq("runId", runId))
			.first(),
	))!;
	expect(review.reviewHeader?.contentNeedsRebase, "new Review capture omits the old marker").toBeUndefined();
	expect(review.reviewHeader?.contentRebaseRootKind).toBeUndefined();
	let captured = false;
	let remainder = false;
	let capturedMarker: boolean | undefined;
	let remainderMarker: boolean | undefined;
	let remainderRoot: "rich_text" | "plain_text" | undefined;
	test_spy_handler(advance_cohort, async (handler, ctx, args) => {
		const result = await handler(ctx, args);
		const { cohortId } = args as { cohortId: Id<"files_move_cohorts"> };
		const item = await ctx.db
			.query("files_move_cohort_items")
			.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohortId))
			.first();
		if (item?.afterProposal) {
			if (!item.contentId) {
				captured = true;
				capturedMarker = item.afterProposal.contentNeedsRebase;
			}
			const content = item.contentId ? await ctx.db.get("files_move_cohort_content", item.contentId) : null;
			if (content?.sealed) {
				remainder = true;
				remainderMarker = item.afterProposal.contentNeedsRebase;
				remainderRoot = item.afterProposal.contentRebaseRootKind;
			}
		}
		return result;
	});
	await test_finish_pending_update_run(f.asUser, runId, { stepwise: true });
	expect(captured).toBe(true);
	expect(remainder).toBe(true);
	expect(capturedMarker, "new cohort capture omits the old marker").toBeUndefined();
	expect(remainderMarker, "fresh remainder omits the old marker").toBeUndefined();
	expect(remainderRoot).toBeUndefined();
	const saved = await f.t.run((ctx) => ctx.db.get("files_pending_updates", f.proposal._id));
	expect(saved?.contentNeedsRebase).toBeUndefined();
	expect(saved?.contentRebaseRootKind).toBeUndefined();
});

test("raw adoption omits old flags from a retained AFTER header", async () => {
	const f = await fixture();
	const runId = await start(f);
	let injected = false;
	test_spy_handler(advance_cohort, async (handler, ctx, args) => {
		const { cohortId } = args as { cohortId: Id<"files_move_cohorts"> };
		const cohort = await ctx.db.get("files_move_cohorts", cohortId);
		if (!injected && cohort?.workPhase === "finish_nodes") {
			const item = await ctx.db
				.query("files_move_cohort_items")
				.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohortId))
				.first();
			if (item?.afterProposal) {
				await ctx.db.patch("files_move_cohort_items", item._id, {
					afterProposal: { ...item.afterProposal, contentNeedsRebase: true, contentRebaseRootKind: "rich_text" },
				});
				injected = true;
			}
		}
		return await handler(ctx, args);
	});
	await test_finish_pending_update_run(f.asUser, runId, { stepwise: true });
	expect(injected).toBe(true);
	const saved = await f.t.run((ctx) => ctx.db.get("files_pending_updates", f.proposal._id));
	expect(
		saved?.contentNeedsRebase,
		"raw adoption cannot copy an old marker into the canonical remainder",
	).toBeUndefined();
	expect(saved?.contentRebaseRootKind).toBeUndefined();
});

test("all four strips keep draft bytes and every unrelated stored field exact", async () => {
	const f = await fixture();
	const runId = await start(f);
	await test_finish_pending_update_run(f.asUser, runId, { stepwise: true });
	await f.t.run(async (ctx) => {
		await ctx.db.patch("files_pending_updates", f.proposal._id, {
			contentNeedsRebase: true,
			contentRebaseRootKind: "rich_text",
		});
		for (const row of await ctx.db.query("files_move_cohort_items").collect())
			if (row.afterProposal)
				await ctx.db.patch("files_move_cohort_items", row._id, {
					afterProposal: { ...row.afterProposal, contentNeedsRebase: true, contentRebaseRootKind: "rich_text" },
				});
		for (const row of await ctx.db.query("files_pending_update_run_items").collect())
			if (row.reviewHeader)
				await ctx.db.patch("files_pending_update_run_items", row._id, {
					reviewHeader: { ...row.reviewHeader, contentNeedsRebase: true, contentRebaseRootKind: "rich_text" },
				});
		for (const row of await ctx.db.query("files_move_cohorts").collect())
			await ctx.db.patch("files_move_cohorts", row._id, {
				pendingContentVersionReady: true,
				pendingContentMigration: { cursor: null, updatedAt: Date.now() },
			});
	});
	const read = () =>
		f.t.run(async (ctx) => ({
			proposals: await ctx.db.query("files_pending_updates").collect(),
			items: await ctx.db.query("files_move_cohort_items").collect(),
			reviews: await ctx.db.query("files_pending_update_run_items").collect(),
			cohorts: await ctx.db.query("files_move_cohorts").collect(),
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
		}));
	const before = await read();
	for (const name of [
		"strip_pending_content_legacy_flags",
		"strip_pending_content_cohort_flags",
		"strip_pending_content_review_flags",
		"strip_pending_content_cohort_fields",
	] as const) {
		let cursor: string | null = null;
		while (true) {
			const page: { isDone: boolean; continueCursor: string } = await f.t.mutation(internal.migrations[name], {
				cursor,
				batchSize: 1,
				oneBatchOnly: true,
				dryRun: false,
			});
			if (page.isDone) break;
			cursor = page.continueCursor;
		}
	}
	const after = await read();
	const clean = <T extends { contentNeedsRebase?: boolean; contentRebaseRootKind?: "rich_text" | "plain_text" }>(
		row: T,
	) => {
		const { contentNeedsRebase: _marker, contentRebaseRootKind: _root, ...rest } = row;
		return rest;
	};
	expect(after).toEqual({
		...before,
		proposals: before.proposals.map(clean),
		items: before.items.map((row) => ({ ...row, afterProposal: row.afterProposal ? clean(row.afterProposal) : null })),
		reviews: before.reviews.map((row) => ({ ...row, reviewHeader: row.reviewHeader ? clean(row.reviewHeader) : null })),
		cohorts: before.cohorts.map(
			({ pendingContentVersionReady: _ready, pendingContentMigration: _migration, ...rest }) => rest,
		),
	});
	for (const table of [
		"files_pending_updates",
		"files_move_cohort_items",
		"files_pending_update_run_items",
		"files_move_cohorts",
	] as const) {
		const audit = await f.t.query(internal.migrations.audit_pending_content, { table, cursor: null });
		expect(audit.missing).toBe(0);
		expect(audit.legacyFlags).toBe(0);
		expect(audit.bridgeFields).toBe(0);
	}
});
