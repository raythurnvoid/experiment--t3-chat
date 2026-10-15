import { Workpool } from "@convex-dev/workpool";
import { describe, expect, test, vi } from "vitest";
import { internal } from "../convex/_generated/api.js";
import type { files_type_queries_Request } from "../convex/files_type_queries.ts";
import { organizations_GLOBAL_GITHUB_WORKSPACE_ID } from "../shared/organizations.ts";
import {
	activity_of,
	create_bash_runner,
	function_name_of,
	job_row,
	run_job,
	test_db_files_mount,
} from "./bash.setup.test.ts";
import { files_pending_review_facts_db_change_state } from "./files-pending-review-facts.ts";

async function fixture() {
	let workNumber = 0;
	vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => `find-work-${++workNumber}` as never);
	const runner = await create_bash_runner();
	await runner.run({ command: "printf later &" });
	const row = await job_row(runner, 1);
	const claimed = await runner.t.mutation(internal.ai_chat_files.claim_bash_job, {
		invocationId: row._id,
		workerGeneration: row.job.workerGeneration,
	});
	if (!claimed?.row.job?.shellState || !row.job.workId) throw new Error("Expected a claimed Bash job");
	const request: files_type_queries_Request = {
		organizationId: runner.seeded.organizationId,
		workspaceId: runner.seeded.workspaceId,
		userId: runner.seeded.userId,
		agentSource: {
			organizationId: runner.seeded.organizationId,
			workspaceId: runner.seeded.workspaceId,
			userId: runner.seeded.userId,
			threadId: runner.threadId,
			membershipId: runner.seeded.membershipId,
			membershipLifetime: runner.ctxData.membershipLifetime,
			run: null,
		},
		overlay: true,
		rootPath: "/docs",
		contentType: "text/",
		directoriesOnly: false,
		limit: 50,
	};
	const query = await runner.t.mutation(internal.files_type_queries.begin, request);
	if (query._nay) throw new Error(query._nay.message);
	const stage = {
		invocationId: row._id,
		workId: row.job.workId,
		request,
		checkpoint: {
			phase: "waiting" as const,
			queryId: query._yay.queryId,
			step: query._yay.step,
			commandNumber: 0,
			expandedArgs: ["docs", "--content-type", "text/"],
			lastArg: "text/",
			shellPrefix: `${test_db_files_mount}/docs`,
			dbPrefix: "/docs",
		},
		resume: {
			script: "printf later",
			commandNumber: 1,
			launchedJobNumbers: [],
			shellState: claimed.row.job.shellState,
			cwd: test_db_files_mount,
			cwdTarget: null,
		},
		output: { stdout: "", stderr: "" },
		liveOutput: null,
	};
	return { runner, row, stage, queryId: query._yay.queryId };
}

describe("background find checkpoint", () => {
	test.each([false, true])("a GLOBAL mount search keeps its source and checks removal (%s)", async (removed) => {
		const runner = await create_bash_runner();
		const mounted = await runner.t.mutation(internal.github_mounts.upsert_mount, {
			name: "type-search",
			owner: "example",
			repo: "type-search",
			ref: "main",
		});
		if (mounted._nay) throw new Error(mounted._nay.message);
		const sha = "a".repeat(40);
		await runner.t.run((ctx) => ctx.db.patch("github_mounts", mounted._yay.mountId, { lastCommitSha: sha }));
		const created = await runner.t.action(internal.files_nodes_content.create_file_node_internal, {
			workspaceId: organizations_GLOBAL_GITHUB_WORKSPACE_ID,
			path: `/type-search/${sha}/readme.md`,
			rawText: "Source text\n",
		});
		expect(created._nay).toBeUndefined();
		await runner.run({ command: "find /.mounts/type-search --content-type text/ &" });
		const staged = await run_job(runner, 1);
		expect(staged.job.find?.phase).toBe("waiting");
		const query = await runner.t.run((ctx) => ctx.db.get("files_type_queries", staged.job.find!.queryId));
		expect(query?.agentSource?.threadId).toBe(runner.threadId);
		if (removed) await runner.t.run((ctx) => ctx.db.delete("github_mounts", mounted._yay.mountId));
		const finished = await run_job(runner, 1);
		if (removed) {
			expect(finished.status).toBe("interrupted");
			expect((await activity_of(runner, 1))?.status).toBe("canceled");
			expect(finished.result).toBeUndefined();
		} else {
			expect(finished.status).toBe("finished");
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toBe("/.mounts/type-search/readme.md\n");
		}
	});

	test.each(["root", "MIME", "limit", "scope"] as const)(
		"refuses a cursor with a different %s before pausing",
		async (changed) => {
			const { runner, row, stage } = await fixture();
			const request = { ...stage.request };
			if (changed === "root") request.rootPath = "/reports";
			if (changed === "MIME") request.contentType = "application/";
			if (changed === "limit") request.limit = 1;
			if (changed === "scope") request.workspaceId = organizations_GLOBAL_GITHUB_WORKSPACE_ID;
			const result = await runner.t.mutation(internal.ai_chat_files.stage_bash_job_find, { ...stage, request });
			expect(result._nay?.message).toContain("search changed");
			expect((await job_row(runner, 1)).job.find).toBeUndefined();
			expect((await activity_of(runner, row.job.jobNumber))?.status).toBe("running");
		},
	);

	test("a background cursor cannot change the searched folder", async () => {
		const runner = await create_bash_runner();
		const first = await runner.run({ command: "find docs --content-type text/ --limit 1" });
		const next = first.stdout.split("Next page: ")[1]?.trim();
		expect(next).toBeTruthy();
		await runner.run({ command: `${next!.replace("/docs", "/reports")} &` });
		const finished = await run_job(runner, 1);
		expect(finished.status).toBe("finished");
		expect(finished.job.find).toBeUndefined();
		expect(finished.result?.metadata.exitCode).not.toBe(0);
		expect(finished.result?.stdout).toBe("");
		expect(finished.result?.stderr).toContain("search changed");
	});

	test.each(["none", "stage_bash_job_find", "take_bash_job_find_result"])(
		"plain find resumes once after a lost %s reply",
		async (lostReply) => {
			const runner = await create_bash_runner();
			const original = runner.runMutation.getMockImplementation()!;
			let lost = false;
			runner.runMutation.mockImplementation(async (reference, args) => {
				const result = await original(reference, args);
				if (!lost && function_name_of(reference)?.endsWith(`:${lostReply}`)) {
					lost = true;
					throw new Error("reply lost");
				}
				return result;
			});
			await runner.run({
				command:
					'{ echo earlier >> count.txt; echo before; find "$(echo expanded >> count.txt; echo docs)" --content-type text/; echo after; } &',
			});
			const staged = await run_job(runner, 1);
			expect(staged.job.find?.phase).toBe("waiting");
			expect(staged.job.liveOutput?.stdout).toBe("before\n");
			expect((await runner.run({ command: "cat count.txt" })).stdout).toBe("earlier\nexpanded\n");
			await runner.t.run((ctx) => files_pending_review_facts_db_change_state(ctx.db, runner.seeded, { jobs: 1 }));
			const waiting = await run_job(runner, 1);
			expect(waiting.job.find?.phase).toBe("waiting");
			expect(waiting.job.liveOutput?.stdout).toBe("before\n");
			expect(waiting.job.liveOutput?.stderr).toBe("");
			expect((await runner.run({ command: "jobs -o 1" })).stderr).toBe("[job 1 queued; preparing file search]\n");
			await runner.t.run((ctx) => files_pending_review_facts_db_change_state(ctx.db, runner.seeded, { jobs: -1 }));
			const finished = await run_job(runner, 1);
			expect(finished.status).toBe("finished");
			expect(finished.result?.metadata.exitCode, finished.result?.stderr).toBe(0);
			expect(finished.result?.stdout).toMatch(/^before\n[\s\S]*after\n$/);
			expect(finished.result?.stdout.match(/\/docs\/readme.md/g)).toHaveLength(1);
			expect(finished.result?.stdout).not.toContain("preparing");
			expect((await runner.run({ command: "cat count.txt" })).stdout).toBe("earlier\nexpanded\n");
			expect(lost).toBe(lostReply !== "none");
		},
	);

	test("a logical chain keeps its unfinished exit code and explicit continuation", async () => {
		const runner = await create_bash_runner();
		await runner.t.run((ctx) => files_pending_review_facts_db_change_state(ctx.db, runner.seeded, { jobs: 1 }));
		await runner.run({ command: "find docs --content-type text/ && echo after &" });
		const finished = await run_job(runner, 1);
		expect(finished.status).toBe("finished");
		expect(finished.job.find).toBeUndefined();
		expect(finished.result?.metadata.exitCode).toBe(3);
		expect(finished.result?.stdout).toBe("");
		expect(finished.result?.stderr).toContain("find: file search is preparing. Check and continue with:");
		expect(finished.result?.stderr).toContain("--cursor");
	});

	test("keeps one checkpoint, exposes its phase, and fences an older worker after requeue", async () => {
		const { runner, row, stage } = await fixture();
		expect(await runner.t.mutation(internal.ai_chat_files.stage_bash_job_find, stage)).toEqual({ _yay: null });
		expect(await runner.t.mutation(internal.ai_chat_files.stage_bash_job_find, stage)).toEqual({ _yay: null });
		expect(
			(
				await runner.t.mutation(internal.ai_chat_files.stage_bash_job_find, {
					...stage,
					resume: { ...stage.resume, script: "printf changed" },
				})
			)._nay?.name,
		).toBe("request_changed");
		const output = await runner.run({ command: "jobs -o 1" });
		expect(output.metadata.exitCode).toBe(3);
		expect(output.stdout).toBe("");
		expect(output.stderr).toBe("[job 1 running; preparing file search]\n");
		expect((await job_row(runner, 1)).job.liveOutput).toBeUndefined();
		expect(
			await runner.t.mutation(internal.ai_chat_files.requeue_bash_job_find, {
				invocationId: row._id,
				workId: stage.workId,
			}),
		).toBe(true);
		const queued = await job_row(runner, 1);
		expect(queued.job.workerGeneration).toBe(row.job.workerGeneration + 1);
		expect(
			await runner.t.mutation(internal.ai_chat_files.take_bash_job_find_result, {
				invocationId: row._id,
				workId: stage.workId,
				commandNumber: 0,
				result: { stdout: "old", stderr: "", exitCode: 0 },
			}),
		).toBeNull();
		expect((await job_row(runner, 1)).job.find?.phase).toBe("waiting");
	});

	test("replays delivery only to its worker and never resumes a lost delivery", async () => {
		const { runner, row, stage } = await fixture();
		await runner.t.mutation(internal.ai_chat_files.stage_bash_job_find, stage);
		const args = {
			invocationId: row._id,
			workId: stage.workId,
			commandNumber: 0,
			result: { stdout: "/docs/readme.md\n", stderr: "", exitCode: 0 },
		};
		const first = await runner.t.mutation(internal.ai_chat_files.take_bash_job_find_result, args);
		expect(first?.job?.find).toMatchObject({ phase: "delivering", workId: stage.workId, result: args.result });
		const repeated = await runner.t.mutation(internal.ai_chat_files.take_bash_job_find_result, {
			...args,
			result: { ...args.result, stdout: "different" },
		});
		expect(repeated?.job?.find).toEqual(first?.job?.find);
		expect(
			await runner.t.mutation(internal.ai_chat_files.claim_bash_job, {
				invocationId: row._id,
				workerGeneration: row.job.workerGeneration,
			}),
		).toBeNull();
		expect(await activity_of(runner, 1)).toMatchObject({ status: "failed" });
		expect((await job_row(runner, 1)).job.resumeScript).toBeUndefined();
	});

	test("Stop cancels only the checkpoint's query", async () => {
		const { runner, row, stage, queryId } = await fixture();
		await runner.t.mutation(internal.ai_chat_files.stage_bash_job_find, stage);
		const other = await runner.t.run(async (ctx) => {
			const query = await ctx.db.get("files_type_queries", queryId);
			if (!query) throw new Error("Expected query");
			const { _id, _creationTime, ...fields } = query;
			return await ctx.db.insert("files_type_queries", fields);
		});
		const before = await runner.t.run((ctx) => ctx.db.query("files_pending_overlay_jobs").collect());
		expect((await runner.run({ command: "kill 1" })).metadata.exitCode).toBe(0);
		expect(await runner.t.run((ctx) => ctx.db.get("files_type_queries", queryId))).toMatchObject({
			state: "canceled",
			lease: null,
		});
		expect(await runner.t.run((ctx) => ctx.db.get("files_type_queries", other))).toMatchObject({ state: "preparing" });
		expect(await runner.t.run((ctx) => ctx.db.query("files_pending_overlay_jobs").collect())).toEqual(before);
		expect(
			await runner.t.mutation(internal.ai_chat_files.take_bash_job_find_result, {
				invocationId: row._id,
				workId: stage.workId,
				commandNumber: 0,
				result: { stdout: "late", stderr: "", exitCode: 0 },
			}),
		).toBeNull();
	});

	test("does not claim a waiting query after its deadline", async () => {
		const { runner, row, stage, queryId } = await fixture();
		await runner.t.mutation(internal.ai_chat_files.stage_bash_job_find, stage);
		await runner.t.run((ctx) => ctx.db.patch("files_type_queries", queryId, { expiresAt: Date.now() - 1 }));
		expect(
			await runner.t.mutation(internal.ai_chat_files.claim_bash_job, {
				invocationId: row._id,
				workerGeneration: row.job.workerGeneration,
			}),
		).toBeNull();
		expect(await activity_of(runner, 1)).toMatchObject({ status: "timed_out" });
	});
});
