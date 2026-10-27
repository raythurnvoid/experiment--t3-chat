import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { fixture } from "./files_pending_overlay.setup.test.ts";
import { test_finish_file_index, test_meta_search } from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function index_until(
	f: Awaited<ReturnType<typeof fixture>>,
	nodeId: Id<"files_nodes">,
	phase: Doc<"files_index_runs">["phase"],
) {
	await f.t.mutation(internal.files_index.start, { nodeId });
	for (let step = 0; step < 100; step++) {
		const run = await f.t.run(async (ctx) => {
			const state = await ctx.db
				.query("files_index_states")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.unique();
			return state?.activeRunId ? await ctx.db.get("files_index_runs", state.activeRunId) : null;
		});
		if (!run) throw new Error("Expected an active index run");
		if (run.phase === phase) return run;
		const args = { runId: run._id, step: run.step, generation: run.generation };
		if (run.phase === "build_metadata") await f.t.action(internal.files_index.prepare_metadata, args);
		else await f.t.mutation(internal.files_index.advance, args);
	}
	throw new Error(`The index did not reach ${phase}`);
}

test("agent metadata search keeps complete saved results and private drafts across index publication", async () => {
	const f = await fixture(true);
	const saved = await f.saved(null, "saved", "folder");
	await f.create_private("/private", "folder");
	await f.set_metadata("/private", [{ key: "status", value: "draft" }]);
	await f.set_metadata("/saved", [{ key: "status", value: "old" }]);
	await f.settle();
	await test_finish_file_index(f.t, saved._id);

	const check = async (value: string, stage: string) => {
		for (const plan of [
			{ op: "exists" as const, fieldPath: "metadata.status" },
			{ op: "prefix" as const, fieldPath: "metadata.status", value: "" },
		]) {
			const result = await test_meta_search(f.t, { ...f.u, plan });
			expect(
				result.items.map((item) => [item.path, item.match?.stringValue]).toSorted(),
				`${stage}: saved metadata keeps its selected version and private drafts stay visible`,
			).toEqual([
				["/private", plan.op === "exists" ? undefined : "draft"],
				["/saved", plan.op === "exists" ? undefined : value],
			]);
		}
		for (const candidate of ["old", "new"]) {
			const result = await test_meta_search(f.t, {
				...f.u,
				plan: { op: "eq", fieldPath: "metadata.status", value: candidate },
			});
			expect(
				result.items.map((item) => item.path),
				`${stage}: exact metadata matches only the selected index`,
			).toEqual(candidate === value ? ["/saved"] : []);
		}
	};
	await check("old", "before request");
	await f.set_metadata("/saved", [{ key: "status", value: "new" }]);
	await check("old", "source committed");
	await index_until(f, saved._id, "ready");
	await check("old", "candidate ready");
	await index_until(f, saved._id, "install_text");
	await check("old", "old rows tagged");
	const run = await index_until(f, saved._id, "publish");
	await check("old", "new rows installed");

	const common = {
		organizationId: f.u.organizationId,
		workspaceId: f.u.workspaceId,
		visibilityUserId: f.u.userId,
		subject: { kind: "user" as const, userId: f.u.userId, plugin: null },
		overlayUserId: f.u.userId,
		folderPath: "/",
	};
	const view = await f.t.query(internal.files_visible.internal_get_index_view, common);
	if (!view?.cohortId || !view.view) throw new Error("Expected a selected index view");
	for (const source of [
		{ kind: "normal" as const, generation: view.generation },
		{ kind: "cohort" as const, cohortId: view.cohortId, view: view.view, generation: view.generation },
	]) {
		const result = await f.t.query(internal.files_visible.internal_search_metadata_saved, {
			...common,
			savedStream: { kind: "normal", generation: view.generation },
			indexStream: source,
			plan: { op: "prefix", fieldPath: "metadata.status", value: "" },
			numItems: 20,
			position: { rangeStart: null, cursor: null, lastKey: null },
		});
		expect(result._yay?.decided, "native metadata ranges read no stale-version candidates").toBe(
			source.kind === "normal" ? 0 : 1,
		);
		expect(result._yay?.rows.map((row) => row.match?.stringValue)).toEqual(source.kind === "normal" ? [] : ["old"]);
	}

	await f.t.mutation(internal.files_index.advance, { runId: run._id, step: run.step, generation: run.generation });
	await check("new", "after flip before cleanup");
	await test_finish_file_index(f.t, saved._id);
	await check("new", "after cleanup");
});
