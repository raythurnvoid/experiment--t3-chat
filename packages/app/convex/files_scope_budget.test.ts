// Budget tests for the doors that change a file's scope: Archive, Restore, replace and agent
// delete. Each file has about 3,000 chunks (the most a 900 KB file can have) at a 1,024-char
// path, because every plain text chunk stores the path. The limits are set to 75% of the Convex
// limits, so any transaction past the 25% margin throws, also in scheduled jobs.

import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { activities_is_active } from "./activities_db.ts";
import { api, internal } from "./_generated/api.js";
import {
	add_member,
	archive,
	fixture,
	read_node,
	restore,
	step,
	type Fixture,
} from "./files_archive_runs.setup.test.ts";
import {
	test_create_saved_text_file,
	test_fill_saved_file_with_max_chunks,
	test_LIMITS_AT_75_PERCENT,
	test_max_chunks_markdown,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { files_pending_review_facts_db_get_state } from "../server/files-pending-review-facts.ts";
import type { Id } from "./_generated/dataModel.js";
import { r2_confirmed_object_delete } from "./r2_client.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { files_NAME_MAX_LENGTH, files_PATH_MAX_LENGTH, files_pending_update_index_revision } from "../shared/files.ts";

// Scheduled functions never run on their own under fake timers. Each test drives them. R2 is faked.
beforeEach(() => {
	vi.useFakeTimers();
	const objects = new Map<string, string | ArrayBuffer>();
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockImplementation(async (_ctx, key) => {
		objects.delete(key);
	});
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (customKey) => {
		const key = customKey ?? crypto.randomUUID();
		return { key, url: `https://r2.test/upload?key=${encodeURIComponent(key)}` };
	});
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			const path = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (path.startsWith("https://r2.test/upload?key=")) {
				const key = decodeURIComponent(path.slice("https://r2.test/upload?key=".length));
				const body = init?.body;
				if (typeof body === "string" || body instanceof ArrayBuffer) objects.set(key, body);
				else if (body instanceof Uint8Array) objects.set(key, files_u8_to_array_buffer(body));
				else return new Response(null, { status: 400 });
				return new Response(null, { status: 200 });
			}
			if (!path.startsWith("https://r2.test/object?key=")) return new Response(null, { status: 404 });
			const body = objects.get(decodeURIComponent(path.slice("https://r2.test/object?key=".length)));
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body, { status: 200 });
		}),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/** A folder 3 levels deep, so a file in it with a 252-char name has the longest path. */
const DEEP_FOLDER = `/${["0", "1", "2"].map((digit) => digit.repeat(files_NAME_MAX_LENGTH)).join("/")}`;
const TOP_FOLDER = DEEP_FOLDER.slice(0, files_NAME_MAX_LENGTH + 1);

function deep_path(letter: string) {
	const path = `${DEEP_FOLDER}/${letter.repeat(files_NAME_MAX_LENGTH - 3)}.md`;
	expect(path).toHaveLength(files_PATH_MAX_LENGTH);
	return path;
}

/**
 * Saved files, each with about 3,000 chunks. With `fill: false` they stay small: call
 * `fill_max_chunks` later.
 */
async function max_files(f: Fixture, paths: string[], options: { head?: string; fill?: boolean } = {}) {
	const nodeIds: Array<Id<"files_nodes">> = [];
	for (const path of paths) {
		nodeIds.push(await test_create_saved_text_file(f.t, { membershipId: f.db.membershipId, path, textContent: "x" }));
		await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	}
	if (options.fill !== false) await fill_max_chunks(f, nodeIds, options.head);
	return nodeIds;
}

async function fill_max_chunks(f: Fixture, nodeIds: Array<Id<"files_nodes">>, head?: string) {
	for (const nodeId of nodeIds)
		expect(await test_fill_saved_file_with_max_chunks(f.t, nodeId, head)).toBeGreaterThan(2900);
}

async function find_node_id(f: Fixture, path: string) {
	return await f.t.run(
		async (ctx) => (await ctx.db.query("files_nodes").collect()).find((node) => node.path === path)!._id,
	);
}

/**
 * Run the steps of an Archive or Restore job until it ends or waits. Returns the activity status.
 * A job that ended in the user's call returns no job.
 */
async function step_job_to_end(
	f: Fixture,
	job: { runId: Id<"files_archive_runs">; activityId: Id<"activities"> } | null,
) {
	let status = "succeeded";
	for (let count = 0; job && count < 100; count++) {
		await step(f, job.runId);
		status = (await f.t.run((ctx) => ctx.db.get("activities", job.activityId)))!.status;
		if (!activities_is_active(status as never) || status === "awaiting_input") break;
	}
	return status;
}

/**
 * Run every scheduled job, like the jobs that copy the node's scope onto its docs. convex-test keeps a
 * failed scheduled job as a row and does not throw, so check the rows.
 */
async function finish_all_jobs(f: Fixture) {
	await f.t.finishAllScheduledFunctions(vi.runAllTimers);
	const failed = await f.t.run(async (ctx) =>
		(await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.state.kind === "failed"),
	);
	expect(failed.map((job) => [job.name, job.state])).toEqual([]);
}

/**
 * When all jobs are done, every saved chunk and metadata doc says the same as its node. One read per
 * file: all chunks of one file fit in one transaction.
 */
async function expect_side_docs_follow(f: Fixture, nodeIds: Array<Id<"files_nodes">>) {
	for (const nodeId of nodeIds) {
		const mismatches = await f.t.run(async (ctx) => {
			const node = (await ctx.db.get("files_nodes", nodeId))!;
			const sideDocs = [
				...(await ctx.db
					.query("files_plain_text_chunks")
					.withIndex("by_organization_workspace_source_fileNode_yjsSequence_chunkIndex", (q) =>
						q
							.eq("organizationId", node.organizationId)
							.eq("workspaceId", node.workspaceId)
							.eq("sourceKind", "committed")
							.eq("fileNodeId", nodeId),
					)
					.collect()),
				...(await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
						q.eq("organizationId", node.organizationId).eq("workspaceId", node.workspaceId).eq("fileNodeId", nodeId),
					)
					.collect()),
			].filter((doc) => doc.sourceKind === "committed");
			return sideDocs
				.filter((doc) => (doc.archiveOperationId ?? null) !== node.archiveOperationId || doc.path !== node.path)
				.map((doc) => ({
					table: "fieldPath" in doc ? "metadata" : "chunk",
					archiveOperationId: doc.archiveOperationId ?? null,
				}))
				.slice(0, 3);
		});
		expect(mismatches).toEqual([]);
	}
}

describe("scope change budgets with 3,000-chunk files at the longest path", () => {
	test("folder Archive", async () => {
		const f = await fixture({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		const nodeIds = await max_files(f, [deep_path("a"), deep_path("b")]);

		const archived = await archive(f, [await find_node_id(f, TOP_FOLDER)]);
		expect(archived._nay).toBeUndefined();
		expect(await step_job_to_end(f, archived._yay ?? null)).toBe("succeeded");
		await finish_all_jobs(f);

		expect((await read_node(f, nodeIds[0]!)).archiveOperationId).not.toBeNull();
		await expect_side_docs_follow(f, nodeIds);
	}, 120_000);

	test("folder Restore", async () => {
		const f = await fixture({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		const nodeIds = await max_files(f, [deep_path("a"), deep_path("b")], { fill: false });
		const topId = await find_node_id(f, TOP_FOLDER);
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

	test("upload-urls replaces 20 files", async () => {
		const f = await fixture({ transactionLimits: test_LIMITS_AT_75_PERCENT });
		// FILES_UPLOAD_URLS_MAX_ITEMS in public_api.ts: the most files one call can replace.
		const paths = Array.from({ length: 20 }, (_, index) => deep_path(String.fromCharCode(97 + index)));
		const nodeIds = await max_files(f, paths);
		await f.t.run((ctx) => ctx.db.patch("users", f.db.userId, { clerkUserId: "clerk-scope-budget-owner" }));
		const key = await f.asOwner.mutation(api.public_api.api_credential_create, {
			membershipId: f.db.membershipId,
			serviceAccountId: null,
			name: "Importer",
			scopes: ["files:write"],
		});
		if (key._nay) throw new Error(key._nay.message);

		const created = await f.t.mutation(internal.public_api.create_file_upload_targets, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId: f.db.userId,
			principalRef: { kind: "user_api_key", credentialId: key._yay.credentialId },
			items: paths.map((path) => ({ path, contentType: "text/markdown", size: 3 })),
			skipProcessing: false,
			overwrite: "replace",
		});
		expect(created._nay).toBeUndefined();
		await finish_all_jobs(f);

		for (const nodeId of nodeIds) expect((await read_node(f, nodeId)).archiveOperationId).not.toBeNull();
		await expect_side_docs_follow(f, nodeIds);
	}, 300_000);

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
		const archived = await archive(f, [await find_node_id(f, TOP_FOLDER)]);
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
		const table = await f.asOwner.query(api.files_nodes.list_tree_children_sorted, {
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
				{ ...scope, target },
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
					hasWorkspaceRead: true,
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
