import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { files_ROOT_ID } from "../shared/files.ts";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import { fixture, type Fixture } from "./files_pending_overlay.setup.test.ts";
import { test_finish_file_index } from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function create_upload(f: Fixture, filename: string) {
	const result = await f.asU.mutation(api.files_nodes.create_upload_node, {
		membershipId: f.db.membershipId,
		parentId: files_ROOT_ID,
		filename,
		contentType: "text/plain",
		size: 10,
	});
	if (result._nay) throw new Error(result._nay.message);
	return result._yay.nodeId;
}

async function advance(f: Fixture, run: Doc<"files_index_runs">) {
	const args = { runId: run._id, step: run.step, generation: run.generation };
	if (run.phase === "build_metadata") await f.t.action(internal.files_index.prepare_metadata, args);
	else await f.t.mutation(internal.files_index.advance, args);
}

async function expect_released(f: Fixture, nodeId: Id<"files_nodes">) {
	const state = await f.t.run(async (ctx) => ({
		index: await ctx.db
			.query("files_index_states")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
			.first(),
		slot: await ctx.db
			.query("files_move_workspace_slots")
			.withIndex("by_workspace", (q) => q.eq("organizationId", f.u.organizationId).eq("workspaceId", f.u.workspaceId))
			.first(),
		tickets: await ctx.db.query("files_index_tickets").collect(),
		runs: await ctx.db.query("files_index_runs").collect(),
		inputs: await ctx.db.query("files_index_inputs").collect(),
		candidates: await ctx.db.query("files_index_candidates").collect(),
		metadata: await ctx.db.query("files_metadata_docs").collect(),
		plain: await ctx.db.query("files_plain_text_chunks").collect(),
		jobs: await ctx.db.query("files_pending_overlay_jobs").collect(),
	}));
	expect(state.slot && "indexRunId" in state.slot, "deleted upload releases the workspace publisher").toBeFalsy();
	expect(state.slot?.cohortId ?? null).toBeNull();
	expect(state.index, "deleted upload leaves no retry state").toBeNull();
	for (const rows of [state.tickets, state.runs, state.inputs, state.candidates]) expect(rows).toEqual([]);
	for (const rows of [state.metadata, state.plain])
		expect(
			rows.filter((row) => row.fileNodeId === nodeId),
			"deleted upload leaves no old or new search rows",
		).toEqual([]);
	expect(
		state.jobs.filter(
			(job) => (job.kind === "saved_scope" || job.kind === "saved_places") && job.savedNodeId === nodeId,
		),
		"deleted upload does not recreate scope or place refresh jobs",
	).toEqual([]);

	const nextId = await create_upload(f, "next.txt");
	await test_finish_file_index(f.t, nextId);
	const nextState = await f.t.run((ctx) =>
		ctx.db
			.query("files_index_states")
			.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nextId))
			.first(),
	);
	expect(nextState?.publishedRevision, "the next file publishes after upload cancellation").toBe(1);
}

test.each([false, true])(
	"upload cancellation clears an idle index state (already published: %s)",
	async (published) => {
		const f = await fixture(true);
		const nodeId = await create_upload(f, "canceled.txt");
		if (published) {
			await test_finish_file_index(f.t, nodeId);
			await f.run_job("saved_places", nodeId);
		}
		const existingJobs = new Set(
			await f.t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => job._id)),
		);
		expect(
			await f.asU.mutation(api.files_nodes.discard_failed_upload_node, {
				membershipId: f.db.membershipId,
				nodeId,
			}),
		).toEqual({ _yay: { removed: true } });
		const wake = await f.t.run(async (ctx) =>
			(await ctx.db.system.query("_scheduled_functions").collect()).find(
				(job) => !existingJobs.has(job._id) && job.name === getFunctionName(internal.files_index.start),
			),
		);
		expect(wake, "node deletion schedules cleanup even after its index has finished").toBeDefined();
		await f.t.mutation(internal.files_index.start, wake!.args[0] as { nodeId: Id<"files_nodes"> });
		await expect_released(f, nodeId);
	},
);

test.each(["build_metadata", "tag_text", "install_text", "install_metadata", "publish", "cleanup_metadata"] as const)(
	"upload cancellation releases an index paused at %s",
	async (phase) => {
		const f = await fixture(true);
		const nodeId = await create_upload(f, "canceled.txt");
		await test_finish_file_index(f.t, nodeId);
		await f.run_job("saved_places", nodeId);
		expect(
			await f.asU.mutation(api.files_metadata.set_entries, {
				membershipId: f.db.membershipId,
				fileNodeId: nodeId,
				metadataYaml: Array.from({ length: 40 }, (_, index) => `field${index}: new`).join("\n"),
			}),
		).toHaveProperty("_yay");
		await f.t.mutation(internal.files_index.start, { nodeId });
		const state = await f.t.run((ctx) =>
			ctx.db
				.query("files_index_states")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first(),
		);
		const runId = state!.activeRunId!;
		let paused: Doc<"files_index_runs"> | null = null;
		let metadataGuard: { runId: Id<"files_index_runs">; step: number; generation: number } | null = null;
		for (let step = 0; step < 100; step++) {
			const run = await f.t.run((ctx) => ctx.db.get("files_index_runs", runId));
			if (!run) throw new Error("The native index ended before the pause");
			if (run.phase === "build_metadata") metadataGuard = { runId, step: run.step, generation: run.generation };
			if (run.phase === phase) {
				paused = run;
				break;
			}
			await advance(f, run);
		}
		expect(paused, "the native upload index reaches the chosen pause").not.toBeNull();
		if (phase === "install_metadata") await advance(f, paused!);
		if (phase === "publish") {
			const tagged = await f.t.run((ctx) =>
				ctx.db
					.query("files_metadata_docs")
					.withIndex("by_move_view", (q) => q.eq("moveView.cohortId", runId))
					.collect(),
			);
			expect(
				new Set(tagged.map((row) => row.moveView?.view)),
				"the canceled upload has both complete index sides",
			).toEqual(new Set(["before", "after"]));
		}
		expect(
			await f.asU.mutation(api.files_nodes.discard_failed_upload_node, {
				membershipId: f.db.membershipId,
				nodeId,
			}),
		).toEqual({ _yay: { removed: true } });

		let failure: unknown = null;
		for (let step = 0; step < 100; step++) {
			const run = await f.t.run((ctx) => ctx.db.get("files_index_runs", runId));
			if (!run) break;
			try {
				// Advance also fences a metadata action that was paused outside a transaction.
				await f.t.mutation(internal.files_index.advance, { runId, step: run.step, generation: run.generation });
			} catch (error) {
				failure = error;
				break;
			}
		}
		await expect_released(f, nodeId);
		expect(failure, "deleted upload cleanup completes without retrying a missing source").toBeNull();
		expect(metadataGuard).not.toBeNull();
		await f.t.action(internal.files_index.prepare_metadata, metadataGuard!);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_index_candidates")
					.withIndex("by_run", (q) => q.eq("runId", runId))
					.collect(),
			),
			"a delayed metadata action cannot recreate deleted work",
		).toEqual([]);
	},
);
