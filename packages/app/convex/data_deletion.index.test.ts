import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("workspace purge drains saved index work and receipts without touching another workspace", async () => {
	const t = test_convex({ transactionLimits: true });
	const victim = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const control = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "control" }));
	const runs = [];
	for (const owner of [victim, control]) {
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: owner.userId });
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: owner.membershipId,
			path: "/note.md",
			textContent: "Original\n",
		});
		expect(
			await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: owner.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toHaveProperty("_yay");
		expect(
			await asUser.action(api.files_nodes_content.replace_file_content, {
				membershipId: owner.membershipId,
				nodeId,
				requestId: "save-before-purge",
				text: "---\nstatus: saved\n---\nNew text\n",
			}),
		).toHaveProperty("_yay");
		await t.mutation(internal.files_index.start, { nodeId });
		for (let step = 0; step < 30; step++) {
			const state = await t.run((ctx) =>
				ctx.db
					.query("files_index_states")
					.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
					.unique(),
			);
			const run = state?.activeRunId ? await t.run((ctx) => ctx.db.get("files_index_runs", state.activeRunId!)) : null;
			if (!run) throw new Error("Expected the native Save index run");
			const args = { runId: run._id, step: run.step, generation: run.generation };
			if (run.phase === "tag_text") {
				runs.push(run);
				break;
			}
			if (run.phase === "build_metadata") await t.action(internal.files_index.prepare_metadata, args);
			else await t.mutation(internal.files_index.advance, args);
		}
	}
	expect(runs, "both workspaces have admitted index work").toHaveLength(2);
	const victimRun = runs[0]!;
	const controlRun = runs[1]!;
	const controlNode = await t.run((ctx) => ctx.db.get("files_nodes", controlRun.fileNodeId));
	const requestId = await t.run((ctx) =>
		data_deletion_db_request(ctx, {
			organizationId: victim.organizationId,
			workspaceId: victim.workspaceId,
			userId: victim.userId,
			scope: "workspace",
			eligibleAt: Date.now(),
		}),
	);
	let done = false;
	for (let pass = 0; pass < 100 && !done; pass++) {
		done = (
			await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
				requestId,
				_test_batchSize: 32,
			})
		).done;
		await t.mutation(internal.files_index.advance, {
			runId: victimRun._id,
			step: victimRun.step,
			generation: victimRun.generation,
		});
	}
	expect(done, "the workspace purge finishes while stale index callbacks arrive").toBe(true);
	for (const table of [
		"files_index_runs",
		"files_index_states",
		"files_index_tickets",
		"files_content_save_requests",
		"files_saved_content_heads",
	] as const) {
		const rows = await t.run((ctx) => ctx.db.query(table).collect());
		expect(
			rows.filter((row) => row.workspaceId === victim.workspaceId),
			`purge removes ${table}`,
		).toEqual([]);
		expect(
			rows.some((row) => row.workspaceId === control.workspaceId),
			`purge keeps other workspace ${table}`,
		).toBe(true);
	}
	for (const table of ["files_index_inputs", "files_index_candidates"] as const) {
		const rows = await t.run((ctx) => ctx.db.query(table).collect());
		expect(
			rows.filter((row) => row.runId === victimRun._id),
			`purge removes ${table}`,
		).toEqual([]);
		expect(
			rows.some((row) => row.runId === controlRun._id),
			`purge keeps other workspace ${table}`,
		).toBe(true);
	}
	expect(await t.run((ctx) => ctx.db.get("files_nodes", controlRun.fileNodeId))).toEqual(controlNode);
	expect(await t.run((ctx) => ctx.db.get("files_index_runs", controlRun._id))).toEqual(controlRun);
});
