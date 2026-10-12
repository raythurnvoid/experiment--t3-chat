// The Metadata cleanup tests, split from files_pending_overlay_limits.accept.test.ts so the two files can run
// at the same time.
//
// Vitest hides the logs of passing tests. Run with `--silent=false --reporter=default` to see the
// numbers. In an agent shell Vitest picks a reporter that hides them even with `--silent=false`.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { advance as advance_review, start as start_review, seal as seal_review } from "./files_pending_update_runs.ts";
import { compact_metadata_catalog, run_job as run_overlay_job } from "./files_pending_overlay.ts";
import { files_metadata_db_insert_committed } from "./files_metadata.ts";
import {
	test_convex,
	test_finish_pending_update_run,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_spy_handler,
} from "./setup.test.ts";
import { files_metadata_catalog_lower } from "../shared/files-metadata.ts";
import {
	type Metadata,
	budget_recorder,
	finish_scheduled,
	insert_saved_node,
	measure_cohort,
	mock_overlay_limits_storage,
	transaction_cost,
} from "./files_pending_overlay_limits.setup.test.ts";

beforeEach(mock_overlay_limits_storage);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("cohort Accept transaction budgets", () => {
	// A cleanup page reads at most 64 docs or 1 MiB. The index caps keep a metadata doc under about
	// 13 KB (1,024-character paths, 160-character keys, values cut to 1,025 characters), so 64 docs stay
	// far below 1 MiB and only the row bound can end a page.
	test.each(["finish", "stop"] as const)("Metadata cleanup keeps mixed docs on native %s", async (mode) => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const nodes: Doc<"files_nodes">[] = [];
		const folder = await t.run((ctx) => insert_saved_node(ctx, db, { parent: null, name: "metadata", kind: "folder" }));
		for (let index = 0; index < 65; index++) {
			const node = await t.run((ctx) => insert_saved_node(ctx, db, { parent: folder, name: `file-${index}.md`, kind: "file" }));
			const key = `field${index}-`.padEnd(148, "k");
			const value = `value-${index}-`.padEnd(1024, "x");
			await test_run_with_flush(t, (ctx) => files_metadata_db_insert_committed(ctx, {
				...scope, nodeId: node._id, yjsSequence: 1, markdownContent: `---\n${key}: ${value}\n---\n`,
			}));
			nodes.push(node);
		}
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const originals = await t.run(async (ctx) => (await Promise.all(nodes.map((node) => ctx.db.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_fieldPath", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", node._id))
			.collect()))).flat() as Metadata[]);
		expect(originals, "The native metadata producer creates every expected field and value").toHaveLength(130);
		expect(originals.every((row) => row.fieldPath.length === 160), "Mixed metadata keys reach the catalog cap").toBe(true);
		const fieldPaths = [...new Set(originals.map((row) => row.fieldPath).filter((field) => field.length <= 160))];
		const readCatalog = () => t.run(async (ctx) => (await Promise.all(fieldPaths.flatMap((fieldPath) =>
			(["key", "parent", "value"] as const).map((family) => ctx.db.query("files_metadata_catalog")
				.withIndex("by_org_ws_family_parent_lower_field_value", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId)
					.eq("moveView.cohortId", undefined).eq("moveView.view", undefined).eq("family", family)
					.eq("parentId", family === "parent" ? folder._id : undefined).eq("fieldPathLower", files_metadata_catalog_lower(fieldPath)).eq("fieldPath", fieldPath))
				.collect())))).flat().map(({ _id, _creationTime, ...row }) => row));
		const catalogBefore = await readCatalog();
		expect(catalogBefore).toHaveLength(195);
		expect(catalogBefore.every((row) => row.count === 1)).toBe(true);
		const proposalResult = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			...scope, target: { kind: "saved", id: folder._id }, destParent: { kind: "root" }, destName: "moved",
		});
		if (proposalResult._nay) throw new Error(proposalResult._nay.message);
		const proposal = await t.run((ctx) => ctx.db.query("files_pending_updates")
			.withIndex("by_user_target", (q) => q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", folder._id)).unique());
		if (!proposal) throw new Error("Expected the folder Move proposal");
		const { peaks, record, check } = budget_recorder();
		const pages = measure_cohort(record, originals);
		for (const [phase, registered] of [
			["review/start", start_review], ["review/seal", seal_review], ["review/advance", advance_review],
			["catalog/compactor", compact_metadata_catalog], ["overlay", run_overlay_job],
		] as const) test_spy_handler(registered, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			record(phase, transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		const started = await asOwner.mutation(api.files_pending_update_runs.start, {
			membershipId: db.membershipId, requestId: crypto.randomUUID(), kind: "accept", expectedItemCount: 1,
			items: [{ pendingUpdateId: proposal._id, reviewedRevision: proposal.revision, selectedContentStateId: null }],
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId, activityId } = started._yay;
		expect(await asOwner.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId })).toEqual({ _yay: null });
		for (let pass = 0; pass < 1000; pass++) {
			const job = await t.run((ctx) => ctx.db.query("files_pending_overlay_jobs")
				.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId)).first());
			if (job) await t.mutation(internal.files_pending_overlay.run_job, { kind: job.kind, key: job.key, nextAttemptAt: job.nextAttemptAt });
			else await t.action(internal.files_pending_update_runs.plan, { runId, fence: 0 });
			if ((await t.run((ctx) => ctx.db.get("files_pending_update_runs", runId)))?.step !== "planning") break;
			if (pass === 999) throw new Error("Metadata Review planning did not finish");
		}
		await t.mutation(internal.files_pending_update_runs.advance, { runId });
		const unit = await t.run((ctx) => ctx.db.query("files_pending_update_run_units").withIndex("by_run_order", (q) => q.eq("runId", runId)).first());
		if (!unit?.cohortId) throw new Error("Metadata Review did not start a cohort");
		const cohortId = unit.cohortId;
		let stopped = false;
		let completed: Doc<"files_move_cohorts"> | null = null;
		for (let pass = 0; pass < 10_000; pass++) {
			const cohort = await t.run((ctx) => ctx.db.get("files_move_cohorts", cohortId));
			if (!cohort) throw new Error("Missing metadata cohort");
			const staged = pages.filter((page) => page.phase === "sides").reduce((count, page) => count + page.rowIds.length, 0);
			if (mode === "stop" && !stopped && staged >= 66) {
				expect(cohort, "Stop reaches real metadata staging before publication").toMatchObject({ phase: "staging", workPhase: "sides", publishedAt: null, errorCode: null });
				expect(await asOwner.mutation(api.activities.request_stop, { membershipId: db.membershipId, activityId })).toEqual({ _yay: null });
				stopped = true;
				continue;
			}
			const cleanup = pages.filter((page) => page.phase === "finish_sides" || page.phase === "abort_sides");
			if (cleanup.length) {
				expect(cleanup[0]!.rowIds.length, "Saved metadata cleanup takes 64 rows when they fit").toBe(64);
			}
			if (cohort.phase === "complete") { completed = cohort; break; }
			await t.action(internal.files_move_cohorts.run, { cohortId, step: cohort.step, runGeneration: cohort.runJob?.generation ?? null, mode: "step" });
			if (pass === 9999) throw new Error("Metadata cohort did not finish");
		}
		await t.mutation(internal.files_pending_update_runs.settle_cohort, { cohortId });
		await test_finish_pending_update_run(asOwner, runId);
		await finish_scheduled(t, async () => !(await t.run((ctx) => ctx.db.query("files_metadata_catalog_compactors")
			.withIndex("by_org_ws", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId)).first())));
		check("Saved metadata cleanup stays below the budget after the flush");
		expect(completed).toMatchObject({ phase: "complete", visibleView: mode === "stop" ? "before" : "after", errorCode: mode === "stop" ? "stopped" : null });
		if (mode === "stop") expect(completed?.publishedAt).toBeNull();
		else expect(completed?.publishedAt).not.toBeNull();
		expect((await asOwner.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId }))?.activity).toMatchObject({
			status: mode === "stop" ? "canceled" : "succeeded",
			progress: { completed: mode === "stop" ? 0 : 1, canceled: mode === "stop" ? 1 : 0, failed: 0, blocked: 0 },
		});
		const finalNodes = await t.run((ctx) => Promise.all(nodes.map((node) => ctx.db.get("files_nodes", node._id))));
		expect(finalNodes.map((node) => [node?._id, node?.parentId, node?.path, node?.treePath])).toEqual(nodes.map((node) => {
			const path = mode === "stop" ? node.path : node.path.replace("/metadata/", "/moved/");
			return [node._id, folder._id, path, path];
		}));
		const metadata = await t.run(async (ctx) => (await Promise.all(nodes.map((node) => ctx.db.query("files_metadata_docs")
			.withIndex("by_organization_workspace_fileNode_fieldPath", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", node._id)).collect()))).flat() as Metadata[]);
		if (mode === "stop") expect(metadata, "Stop before publication keeps every saved metadata field").toEqual(originals);
		else {
			const metadata_fields = (rows: Doc<"files_metadata_docs">[]) => rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !["_id", "_creationTime", "moveView", "path", "treePath"].includes(key))))
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
			expect(metadata_fields(metadata), "Native Move keeps every saved metadata field and value").toEqual(metadata_fields(originals));
		}
		const paths = new Map(finalNodes.map((node) => [node!._id, node!.path]));
		expect(metadata.every((row) => row.moveView === undefined && row.path === paths.get(row.fileNodeId!) && row.treePath === row.path)).toBe(true);
		expect(finalNodes.every((node) => node?.moveCohortId === undefined)).toBe(true);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual(mode === "stop" ? proposal : null);
		expect(await readCatalog(), "Native metadata cleanup keeps exact catalog counts").toEqual(catalogBefore);
		expect(new Set(pages.find((page) => page.phase === (mode === "stop" ? "abort_sides" : "finish_sides"))!.fileNodeIds).size, "Metadata cleanup pages cross file boundaries").toBeGreaterThan(1);
		console.info("saved metadata page peaks, with the catalog", JSON.stringify({ mode, phases: Object.fromEntries(peaks), pages: pages.map(({ phase, view, rowIds }) => ({ phase, view, rows: rowIds.length })) }));
	}, 180_000);
});
