// Budget tests for the doors that change a file's scope: Archive, Restore, replace and agent
// delete. Each file has about 3,000 chunks (the most a 900 KB file can have) at a 1,024-char
// path, because every plain text chunk stores the path. The limits are set to 75% of the Convex
// limits, so any transaction past the 25% margin throws, also in scheduled jobs.
//
// The upload-urls test is in files_archive_runs.scope_budget_upload.test.ts and the Accept, folder table and
// draft tests are in files_archive_runs.scope_budget_accept.test.ts, so the three files can run at the same time.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { archive, find_node, fixture, read_node, restore } from "./files_archive_runs.setup.test.ts";
import { test_LIMITS_AT_75_PERCENT } from "./setup.test.ts";
import {
	mock_scope_budget_storage,
	TOP_FOLDER,
	deep_path,
	max_files,
	fill_max_chunks,
	step_job_to_end,
	finish_all_jobs,
	expect_side_docs_follow,
} from "./files_archive_runs.scope_budget.setup.test.ts";

// Scheduled functions never run on their own under fake timers. Each test drives them. R2 is faked.
beforeEach(mock_scope_budget_storage);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("scope change budgets with 3,000-chunk files at the longest path", () => {
	test("folder Archive", async () => {
		const f = await fixture({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		const nodeIds = await max_files(f, [deep_path("a"), deep_path("b")]);

		const archived = await archive(f, [(await find_node(f, TOP_FOLDER))._id]);
		expect(archived._nay).toBeUndefined();
		expect(await step_job_to_end(f, archived._yay ?? null)).toBe("succeeded");
		await finish_all_jobs(f);

		expect((await read_node(f, nodeIds[0]!)).archiveOperationId).not.toBeNull();
		await expect_side_docs_follow(f, nodeIds);
	}, 120_000);

	test("folder Restore", async () => {
		const f = await fixture({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		const nodeIds = await max_files(f, [deep_path("a"), deep_path("b")], { fill: false });
		const topId = (await find_node(f, TOP_FOLDER))._id;
		// Archive while the files are small, then give the archived files their full text.
		expect(await step_job_to_end(f, (await archive(f, [topId]))._yay ?? null)).toBe("succeeded");
		await fill_max_chunks(f, nodeIds);

		const restored = await restore(f, [topId]);
		expect(restored._nay).toBeUndefined();
		expect(await step_job_to_end(f, restored._yay ?? null)).toBe("succeeded");
		await finish_all_jobs(f);

		expect((await read_node(f, nodeIds[0]!)).archiveOperationId).toBeNull();
		await expect_side_docs_follow(f, nodeIds);
	}, 120_000);

	test("Restore with Replace", async () => {
		const f = await fixture({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		const [restoredId] = await max_files(f, [deep_path("a")], { fill: false });
		expect(await step_job_to_end(f, (await archive(f, [restoredId!]))._yay ?? null)).toBe("succeeded");
		// A new file now takes the archived file's name.
		const [occupantId] = await max_files(f, [deep_path("a")], { fill: false });
		await fill_max_chunks(f, [restoredId!, occupantId!]);

		// Replace restores the file and archives the file in its place in one step.
		const restored = await restore(f, [restoredId!]);
		expect(restored._nay).toBeUndefined();
		const job = restored._yay!;
		expect(await step_job_to_end(f, job)).toBe("awaiting_input");
		const run = (await f.t.run((ctx) => ctx.db.get("files_archive_runs", job.runId)))!;
		expect(
			await f.asOwner.mutation(api.files_archive_runs.resolve_conflicts, {
				membershipId: f.db.membershipId,
				runId: job.runId,
				revision: run.revision,
				choice: "replace",
				applyToRemaining: { file: null, folder: null },
			}),
		).toEqual({ _yay: null });
		expect(await step_job_to_end(f, job)).toBe("succeeded");
		await finish_all_jobs(f);

		expect((await read_node(f, restoredId!)).archiveOperationId).toBeNull();
		expect((await read_node(f, occupantId!)).archiveOperationId).not.toBeNull();
		await expect_side_docs_follow(f, [restoredId!, occupantId!]);
	}, 120_000);
});
