// The Accept, folder table and draft budget tests, split from files_archive_runs.scope_budget.test.ts so the
// files can run at the same time. See the comment at the top of that file.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { add_member, archive, find_node, fixture, read_node } from "./files_archive_runs.setup.test.ts";
import {
	test_create_saved_text_file,
	test_LIMITS_AT_75_PERCENT,
	test_max_chunks_markdown,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { files_pending_review_facts_db_get_state } from "../server/files-pending-review-facts.ts";
import { files_pending_update_index_revision } from "../shared/files.ts";
import {
	mock_scope_budget_storage,
	TOP_FOLDER,
	deep_path,
	max_files,
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
	test("Accept of an agent delete also removes the owner's full draft", async () => {
		const f = await fixture({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		const scope = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
		const [nodeId] = await max_files(f, [deep_path("a")]);
		const target = { kind: "saved", id: nodeId! } as const;
		// The owner's draft has about 3,000 chunks too. Then the agent proposes to delete the file.
		const batch = await f.t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{
				...scope,
				target,
				expectedPendingContentVersion: (await f.t.run((ctx) => ctx.db.get("files_nodes", target.id)))!.pendingContentVersion,
			},
		);
		if (batch._nay) throw new Error(batch._nay.message);
		expect(
			await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
				...scope,
				operationBatchId: batch._yay.operationBatchId,
				role: "unstaged",
				text: test_max_chunks_markdown(),
			}),
		).toEqual({ _yay: null });
		expect(
			await f.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
				...scope,
				target,
				operationBatchId: batch._yay.operationBatchId,
			}),
		).toEqual({ _yay: null });
		expect(
			(await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, { ...scope, target }))._nay,
		).toBeUndefined();
		const proposal = (await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).find(
			(row) => row.target.id === nodeId,
		)!;
		expect(proposal.pendingArchive && proposal.content).toBeTruthy();

		const started = await f.asOwner.mutation(api.files_pending_update_runs.start, {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 1,
			items: [
				{
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
					selectedContentStateId: proposal.content?.unstagedStateId ?? null,
				},
			],
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		expect(
			await f.asOwner.mutation(api.files_pending_update_runs.seal, { membershipId: f.db.membershipId, runId }),
		).toEqual({ _yay: null });
		// Run the workers one timer at a time. Running all timers at once jumps to the review's expiry.
		for (let count = 0; ; count++) {
			if (count === 50_000) throw new Error("The Accept did not finish");
			vi.advanceTimersByTime(0);
			await f.t.finishInProgressScheduledFunctions();
			const review = await f.asOwner.query(api.files_pending_update_runs.get, {
				membershipId: f.db.membershipId,
				runId,
			});
			if (review?.run.step === "finished" || vi.getTimerCount() === 0) break;
			vi.advanceTimersToNextTimer();
		}
		await finish_all_jobs(f);

		expect(
			(await f.asOwner.query(api.files_pending_update_runs.get, { membershipId: f.db.membershipId, runId }))?.activity,
		).toMatchObject({ status: "succeeded", progress: { completed: 1 } });
		expect((await read_node(f, nodeId!)).archiveOperationId).not.toBeNull();
		await expect_side_docs_follow(f, [nodeId!]);
	}, 120_000);

	test("Accept by another user is not blocked long after a big Archive", async () => {
		const f = await fixture({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		await max_files(f, [deep_path("a"), deep_path("b")]);
		const archived = await archive(f, [(await find_node(f, TOP_FOLDER))._id]);
		expect(archived._nay).toBeUndefined();
		expect(await step_job_to_end(f, archived._yay ?? null)).toBe("succeeded");

		// A review plan waits while the workspace has pending overlay jobs
		// (files_pending_update_plan_producer.ts). Work left over from the Archive must not count.
		const state = await f.t.run((ctx) => files_pending_review_facts_db_get_state(ctx.db, f.db));
		expect(state?.pendingJobCount ?? 0).toBe(0);
		// So another user's Save of a new file goes through right away.
		const member = await add_member(f);
		// The member pays for their own Save.
		await f.t.run((ctx) => test_mocks_fill_db_with.plan(ctx, { userId: member.userId, plan: "Pay As You Go" }));
		await test_create_saved_text_file(f.t, { membershipId: member.membershipId, path: "/note.md", textContent: "Hi" });
		await finish_all_jobs(f);
	}, 120_000);

	test("folder table sorted by a metadata key does not throw right after Archive", async () => {
		const f = await fixture({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		const [archivedId] = await max_files(f, [deep_path("a")], { head: "---\ntitle: A\n---\n" });
		await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: deep_path("b"),
			textContent: "---\ntitle: B\n---\nx",
		});
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);

		const archived = await archive(f, [archivedId!]);
		expect(archived._nay).toBeUndefined();
		expect(await step_job_to_end(f, archived._yay ?? null)).toBe("succeeded");
		// Read the table before any scheduled job runs: the archived file's metadata docs may still
		// say "active".
		const table = await f.asOwner.query(api.files_tree.list_tree_children_sorted, {
			stream: "normal" as const,
			membershipId: f.db.membershipId,
			parentId: (await read_node(f, archivedId!)).parentId,
			kind: "file",
			sort: [{ field: "frontmatter.title", direction: "asc" }],
			filter: null,
			namePrefix: null,
			restricted: false,
			segment: "value",
			paginationOpts: { numItems: 20, cursor: null },
		});
		expect(table.page.map((row) => row.path)).toEqual([deep_path("b")]);
		await finish_all_jobs(f);
	}, 120_000);

	test("Edit and Discard of the owner's full draft", async () => {
		const f = await fixture({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		const scope = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
		const [nodeId] = await max_files(f, [deep_path("a")], { fill: false });
		const target = { kind: "saved", id: nodeId! } as const;
		const save_draft = async (text: string) => {
			const batch = await f.t.mutation(
				internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
				{
					...scope,
					target,
					expectedPendingContentVersion: (await f.t.run((ctx) => ctx.db.get("files_nodes", target.id)))!.pendingContentVersion,
				},
			);
			if (batch._nay) throw new Error(batch._nay.message);
			expect(
				await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
					...scope,
					operationBatchId: batch._yay.operationBatchId,
					role: "unstaged",
					text,
				}),
			).toEqual({ _yay: null });
			return await f.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
				...scope,
				target,
				operationBatchId: batch._yay.operationBatchId,
			});
		};
		// Run only the jobs that are due now. Running every timer would also expire the draft.
		const run_due_jobs = async () => {
			for (let round = 0; round < 100; round++) {
				vi.advanceTimersByTime(1);
				await f.t.finishInProgressScheduledFunctions();
			}
		};
		// Count the draft's chunks by revision, in pages: old and new chunks together do not fit one read.
		const read_chunk_revisions = async () => {
			const proposal = (await f.t.run((ctx) => ctx.db.query("files_pending_updates").first()))!;
			const revision = files_pending_update_index_revision(proposal);
			const counts = { proposal, current: 0, old: 0 };
			for (const table of ["files_text_chunks", "files_plain_text_chunks"] as const) {
				let cursor: string | null = null;
				for (;;) {
					const page = await f.t.run((ctx) =>
						ctx.db
							.query(table)
							.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", proposal._id))
							.paginate({ cursor, numItems: 1_000 }),
					);
					for (const chunk of page.page)
						counts[chunk.sourceKind === "pending" && chunk.proposalRevision === revision ? "current" : "old"] += 1;
					if (page.isDone) break;
					cursor = page.continueCursor;
				}
			}
			return counts;
		};
		// The agent's grep of the draft. The first 128 old chunks are already deleted, so start far after them.
		const grep = async (pattern: string) =>
			(
				await f.t.query(internal.files_nodes.match_text_file_lines, {
					...scope,
					target,
					pattern,
					ignoreCase: false,
					fixedStrings: true,
					invert: false,
					before: 0,
					after: 0,
					window: { kind: "lines", startLine: 2_000, maxLines: 20 },
				})
			)?.selectedCount;
		const search = async (query: string) =>
			(
				await f.t.query(internal.files_nodes.text_search_files, {
					...scope,
					subject: { kind: "user" as const, userId: scope.userId, plugin: null },
					query,
					numItems: 10,
					cursor: null,
				})
			).items.length;

		const text = test_max_chunks_markdown();
		expect(await save_draft(text)).toEqual({ _yay: null });
		// The edit changes every chunk. Before the fix, deleting the old chunks here passed the limits.
		expect(await save_draft(text.replaceAll("lorem", "dolor"))).toEqual({ _yay: null });
		const edited = await read_chunk_revisions();
		expect(edited.current).toBeGreaterThan(5_800);
		// Most old chunks wait for the drain. Readers already skip them.
		expect(edited.old).toBeGreaterThan(5_000);
		expect(await grep("lorem")).toBe(0);
		expect(await grep("dolor")).toBeGreaterThan(0);
		expect(await search("lorem")).toBe(0);
		expect(await search("dolor")).toBeGreaterThan(0);
		await run_due_jobs();
		expect(await read_chunk_revisions()).toMatchObject({ current: edited.current, old: 0 });

		// Discard, like expiry, deletes the proposal and leaves the big rest to the drain.
		expect(
			await f.asOwner.mutation(api.files_pending_updates.discard_file_pending_update, {
				membershipId: f.db.membershipId,
				target,
				pendingUpdateId: edited.proposal._id,
				reviewedRevision: edited.proposal.revision,
			}),
		).toEqual({ _yay: null });
		await finish_all_jobs(f);
		expect(
			await f.t.run(async (ctx) => [
				...(await ctx.db.query("files_text_chunks").collect()).filter((chunk) => chunk.sourceKind === "pending"),
				...(await ctx.db.query("files_plain_text_chunks").collect()).filter((chunk) => chunk.sourceKind === "pending"),
			]),
		).toEqual([]);
	}, 300_000);
});
