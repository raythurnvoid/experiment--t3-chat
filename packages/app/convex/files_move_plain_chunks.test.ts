import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { advance } from "./files_move_cohorts.ts";
import { files_nodes_db_get_content_version } from "./files_nodes.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import {
	test_create_saved_text_file,
	test_finish_saved_scope_jobs,
	test_finish_transfer_run,
	test_progress_guard,
	test_spy_handler,
} from "./setup.test.ts";
import { create_fixture, create_folder, mock_move_scale_storage } from "./files_move_scale.setup.test.ts";
import { files_saved_placement_db_get_view } from "../server/files-saved-placement.ts";
import type { files_SavedStream } from "../shared/files.ts";

const text = `movechunkneedle\n${"plain line with unchanged text ".repeat(40)}\n`.repeat(12);

beforeEach(() => {
	mock_move_scale_storage();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("plain-chunk-test-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture() {
	const f = await create_fixture();
	const source = await create_folder(f, "/source");
	const target = await create_folder(f, "/target");
	const nodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/source/note.txt",
		textContent: text,
	});
	expect(
		await f.asUser.mutation(api.files_metadata.set_entries, {
			membershipId: f.db.membershipId,
			fileNodeId: nodeId,
			metadataYaml: "marker: yes",
		}),
	).toEqual({ _yay: null });
	await test_finish_saved_scope_jobs(f.t);
	return { ...f, sourceId: source._id, targetId: target._id, nodeId };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function chunks(f: Fixture, nodeId = f.nodeId) {
	return f.t.run((ctx) =>
		ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId).eq("fileNodeId", nodeId),
			)
			.collect(),
	);
}

async function start_move(
	f: Fixture,
	sourceId = f.sourceId,
	targetParentId: Id<"files_nodes"> | "root" = f.targetId,
	replace = false,
) {
	const started = await f.asUser.mutation(api.files_transfer.accept_input, {
		membershipId: f.db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "move",
		sourceIds: [sourceId],
		expectedSourceCount: 1,
		targetParentId,
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await f.asUser.mutation(api.files_transfer.seal, {
			membershipId: f.db.membershipId,
			runId: started._yay.runId,
		}),
	).toEqual({ _yay: null });
	const progress = test_progress_guard();
	while (true) {
		const cohort = await f.t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", started._yay.runId))
				.first(),
		);
		if (cohort) return { ...started._yay, cohortId: cohort._id };
		const run = await f.t.run((ctx) => ctx.db.get("files_transfer_runs", started._yay.runId));
		const activity = await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId));
		if (replace && activity?.status === "awaiting_input") {
			const page = await f.asUser.query(api.files_transfer.list_items, {
				membershipId: f.db.membershipId,
				runId: started._yay.runId,
				state: "conflict",
				paginationOpts: { cursor: null, numItems: 16 },
			});
			const item = page!.page[0]!;
			expect(
				await f.asUser.mutation(api.files_transfer.resolve_conflicts, {
					membershipId: f.db.membershipId,
					runId: started._yay.runId,
					revision: run!.revision,
					choices: [
						{
							itemId: item.itemId,
							choice: "replace",
							reviewedTarget: item.conflict!.target!,
							reviewedVersion: item.conflict!.version,
						},
					],
					applyToRemaining: { file: null, folder: null },
				}),
			).toEqual({ _yay: null });
		}
		progress(run, "start plain chunk Move");
		await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
	}
}

type Move = Awaited<ReturnType<typeof start_move>>;

async function drive_to(
	f: Fixture,
	move: Move,
	workPhase: "sides" | "publish" | "finish_sides" | "finish_nodes" | "complete",
) {
	const progress = test_progress_guard();
	while (true) {
		const cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", move.cohortId)))!;
		if (cohort.workPhase === workPhase) return cohort;
		if (cohort.phase === "complete") throw new Error(`Move ended before ${workPhase}: ${cohort.errorCode}`);
		progress(cohort, `plain chunk Move ${workPhase}`);
		const job = (await f.t.run((ctx) => ctx.db.system.get(cohort.runJob!.id)))!;
		await f.t.action(internal.files_move_run.run, {
			...(job.args[0] as FunctionArgs<typeof internal.files_move_run.run>),
			mode: "step",
		});
	}
}

async function saved_search(
	f: Fixture,
	clause: FunctionArgs<typeof api.files_nodes.search_saved>["clause"],
	folderPath?: string,
	member = { asUser: f.asUser, membershipId: f.db.membershipId },
) {
	const view = await f.t.run((ctx) => files_saved_placement_db_get_view(ctx.db, f.db));
	const streams: files_SavedStream[] = [{ kind: "normal", generation: view.generation }];
	if (view.cohortId && view.view)
		streams.push({
			kind: "cohort",
			generation: view.generation,
			cohortId: view.cohortId,
			view: view.view,
		});
	const rows = new Map<string, { nodeId: string; path: string }>();
	for (const savedStream of streams) {
		let cursor: string | null = null;
		do {
			const page: FunctionReturnType<typeof api.files_nodes.search_saved> = await member.asUser.query(
				api.files_nodes.search_saved,
				{
					membershipId: member.membershipId,
					savedStream,
					clause,
					folderPath,
					paginationOpts: { cursor, numItems: 16 },
				},
			);
			for (const row of page.page) {
				if (row.kind === "problem") throw new Error(row.message);
				rows.set(row.nodeId, { nodeId: row.nodeId, path: row.path });
			}
			cursor = page.isDone ? null : page.continueCursor;
		} while (cursor !== null);
	}
	return [...rows.values()];
}

async function assert_reads(f: Fixture, path: string) {
	const content = await f.t.query(internal.files_nodes.read_file_content_from_chunks, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
		path,
		committedOnly: true,
		mode: { kind: "full", maxBytes: text.length + 100 },
	});
	expect(content).toMatchObject({ target: { kind: "saved", id: f.nodeId }, content: text });
	const matches = await f.t.query(internal.files_nodes.match_plain_text_file_lines, {
		organizationId: f.db.organizationId,
		workspaceId: f.db.workspaceId,
		userId: f.db.userId,
		target: { kind: "saved", id: f.nodeId },
		pattern: "movechunkneedle",
		ignoreCase: false,
		fixedStrings: true,
		invert: false,
	});
	expect(matches).toMatchObject({ target: { kind: "saved", id: f.nodeId }, selectedCount: 12, scanTruncated: false });
	expect(await saved_search(f, { kind: "content", text: "movechunkneedle" })).toEqual([{ nodeId: f.nodeId, path }]);
	const rows = [];
	let cursor: string | null = null;
	do {
		const page: FunctionReturnType<typeof internal.files_nodes.text_search_files> = await f.t.query(
			internal.files_nodes.text_search_files,
			{
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				hasWorkspaceRead: true,
				query: "movechunkneedle",
				numItems: 16,
				cursor,
			},
		);
		expect(page.retrySmaller).toBe(false);
		rows.push(...page.items);
		cursor = page.isDone ? null : page.continueCursor;
	} while (cursor !== null);
	expect(new Set(rows.map((row) => row.path))).toEqual(new Set([path]));
	expect(rows.every((row) => row.target.kind === "saved" && row.target.id === f.nodeId)).toBe(true);
}

async function assert_reused(f: Fixture, original: Awaited<ReturnType<typeof chunks>>) {
	const current = await chunks(f);
	expect(current.map((row) => row._id).sort(), "pure Move keeps original plain chunk IDs").toEqual(
		original.map((row) => row._id).sort(),
	);
	expect(
		current.every((row) => row.moveView === undefined),
		"pure Move leaves original chunks untagged",
	).toBe(true);
	expect(current.map((row) => row.textChunk).join("")).toBe(text);
}

async function finish(f: Fixture, move: Move) {
	await test_finish_transfer_run(f.asUser, move.runId);
	await test_finish_saved_scope_jobs(f.t);
	expect(
		await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "saved_scope").eq("key", f.nodeId))
				.unique(),
		),
	).toBeNull();
	const node = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
	expect(
		(await chunks(f)).every((row) => row.path === node.path),
		"reused chunk path cache finishes",
	).toBe(true);
}

async function add_member(f: Fixture, name: string, role: "viewer" | "member" = "viewer") {
	const member = await f.t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: `plain-${name}` });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
		});
		await access_control_db_ensure_role_assignment(ctx, {
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			userId,
			role,
			now: Date.now(),
		});
		return { userId, membershipId };
	});
	return { ...member, asUser: f.t.withIdentity({ issuer: "https://clerk.test", external_id: member.userId }) };
}

describe("Move unchanged plain chunks", () => {
	test("serves before and after paths without copying chunk payloads", async () => {
		const f = await fixture();
		const original = await chunks(f);
		expect(original.length, "the supported writer makes more than one chunk page").toBeGreaterThan(8);
		const version = await f.t.run(async (ctx) =>
			files_nodes_db_get_content_version(ctx, (await ctx.db.get("files_nodes", f.nodeId))!),
		);
		const owner = await add_member(f, "draft-owner", "member");
		const batch = await owner.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: owner.membershipId,
			target: { kind: "saved", id: f.nodeId },
		});
		if (batch._nay) throw new Error(batch._nay.message);
		for (const role of ["staged", "unstaged"] as const)
			expect(
				await owner.asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
					membershipId: owner.membershipId,
					operationBatchId: batch._yay.operationBatchId,
					role,
					text: "privatebranchneedle",
				}),
			).toEqual({ _yay: null });
		const draft = await owner.asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: owner.membershipId,
			target: { kind: "saved", id: f.nodeId },
			operationBatchId: batch._yay.operationBatchId,
		});
		if (draft._nay) throw new Error(draft._nay.message);
		expect(
			await f.asUser.mutation(api.files_sharing.set_node_share_link, {
				membershipId: f.db.membershipId,
				nodeId: f.nodeId,
				enabled: true,
			}),
		).toEqual({ _yay: null });
		const token = (await f.asUser.query(api.files_sharing.get_node_share_state, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
		}))!.link!.token;
		expect(
			await f.t.query(api.files_share_links.get_share_link_view, { token }),
			"the original public token works",
		).not.toBeNull();
		let transactions = 0;
		let chunkWrites = 0;
		let writtenDocs = 0;
		test_spy_handler(advance, async (handler, ctx, args) => {
			const before = (await ctx.db.get(
				"files_move_cohorts",
				(args as { cohortId: Id<"files_move_cohorts"> }).cohortId,
			))!;
			const patch = vi.spyOn(ctx.db, "patch");
			const insert = vi.spyOn(ctx.db, "insert");
			try {
				const result = await handler(ctx, args);
				if (before.publishedAt === null) {
					transactions++;
					writtenDocs += (await ctx.meta.getTransactionMetrics()).documentsWritten.used;
					chunkWrites += patch.mock.calls.filter(
						([table, id]) => table === "files_plain_text_chunks" && original.some((row) => row._id === id),
					).length;
					chunkWrites += insert.mock.calls.filter(
						([table, row]) =>
							table === "files_plain_text_chunks" && "sourceKind" in row && row.sourceKind === "committed",
					).length;
				}
				return result;
			} finally {
				patch.mockRestore();
				insert.mockRestore();
			}
		});
		const move = await start_move(f);
		await drive_to(f, move, "publish");
		console.info(
			"Plain chunk Move publication work",
			JSON.stringify({ transactions, writtenDocs, chunkWrites, chunks: original.length }),
		);
		await assert_reused(f, original);
		expect(chunkWrites, "Move writes no reused committed plain chunks before publication").toBe(0);
		await assert_reads(f, "/source/note.txt");
		expect(
			await saved_search(
				f,
				{ kind: "metadata", plan: { op: "eq", fieldPath: "metadata.marker", value: "yes" } },
				"/source",
			),
		).toEqual([{ nodeId: f.nodeId, path: "/source/note.txt" }]);
		await drive_to(f, move, "finish_sides");
		await assert_reads(f, "/target/source/note.txt");
		await expect(
			saved_search(f, { kind: "metadata", plan: { op: "eq", fieldPath: "metadata.marker", value: "yes" } }, "/source"),
		).rejects.toThrow("Folder not found");
		expect(
			await saved_search(
				f,
				{ kind: "metadata", plan: { op: "eq", fieldPath: "metadata.marker", value: "yes" } },
				"/target/source",
			),
		).toEqual([{ nodeId: f.nodeId, path: "/target/source/note.txt" }]);
		expect(
			await f.t.query(api.files_share_links.get_share_link_view, { token }),
			"reparented public token ends at publication",
		).toBeNull();
		await drive_to(f, move, "finish_nodes");
		await assert_reused(f, original);
		await finish(f, move);
		await assert_reused(f, original);
		await assert_reads(f, "/target/source/note.txt");
		expect(
			await f.t.run(async (ctx) =>
				files_nodes_db_get_content_version(ctx, (await ctx.db.get("files_nodes", f.nodeId))!),
			),
		).toEqual(version);
		expect(await saved_search(f, { kind: "content", text: "privatebranchneedle" })).toEqual([]);
		expect(
			await owner.asUser.query(internal.files_nodes.read_file_content_from_chunks, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: owner.userId,
				path: "/target/source/note.txt",
				overlayUserId: owner.userId,
				mode: { kind: "full", maxBytes: 100 },
			}),
		).toMatchObject({ target: { kind: "saved", id: f.nodeId }, content: "privatebranchneedle" });
		console.info(
			"Plain chunk Move work",
			JSON.stringify({ transactions, writtenDocs, chunkWrites, chunks: original.length }),
		);
	}, 120_000);

	test("replacement still stages changed archive membership", async () => {
		const f = await fixture();
		const replacedId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/target/note.txt",
			textContent: text,
		});
		const original = await chunks(f);
		const replacedChunks = await chunks(f, replacedId);
		const move = await start_move(f, f.nodeId, f.targetId, true);
		await drive_to(f, move, "publish");
		await assert_reused(f, original);
		const staged = await chunks(f, replacedId);
		expect(staged.filter((row) => row.moveView?.view === "before")).toHaveLength(replacedChunks.length);
		expect(staged.filter((row) => row.moveView?.view === "after")).toHaveLength(replacedChunks.length);
		expect(
			staged.filter((row) => row.moveView?.view === "after").every((row) => row.archiveOperationId === move.cohortId),
			"changed archive membership gets search chunks for the after view",
		).toBe(true);
		await finish(f, move);
		const archived = await chunks(f, replacedId);
		expect(archived).toHaveLength(replacedChunks.length);
		expect(archived.every((row) => row.moveView === undefined && row.archiveOperationId === move.cohortId)).toBe(true);
		await assert_reused(f, original);
		await assert_reads(f, "/target/note.txt");
	}, 120_000);

	test.each([false, true])(
		"Stop after publication=%s keeps shared chunks",
		async (published) => {
			const f = await fixture();
			const original = await chunks(f);
			const move = await start_move(f);
			await drive_to(f, move, published ? "finish_sides" : "publish");
			expect(
				await f.asUser.mutation(api.files_transfer.stop, {
					membershipId: f.db.membershipId,
					runId: move.runId,
				}),
			).toEqual({ _yay: null });
			await finish(f, move);
			await assert_reused(f, original);
			await assert_reads(f, published ? "/target/source/note.txt" : "/source/note.txt");
		},
		120_000,
	);

	test("a later Move repairs the current path while an earlier cache job waits", async () => {
		const f = await fixture();
		const original = await chunks(f);
		const first = await start_move(f);
		await drive_to(f, first, "complete");
		await f.t.mutation(internal.files_transfer.settle_cohort, { cohortId: first.cohortId });
		await f.t.mutation(internal.files_transfer.advance, { runId: first.runId });
		expect(await f.t.run((ctx) => ctx.db.get("activities", first.activityId))).toMatchObject({ status: "succeeded" });
		const cache = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "saved_scope").eq("key", f.nodeId))
				.unique(),
		);
		expect(cache, "physical finish queues the reused chunk cache repair").not.toBeNull();
		await f.t.mutation(internal.files_pending_overlay.run_job, {
			kind: cache!.kind,
			key: cache!.key,
			nextAttemptAt: cache!.nextAttemptAt,
		});
		expect(
			(await f.t.run((ctx) => ctx.db.get("files_pending_overlay_jobs", cache!._id)))?.cursor,
			"the first cache pass started before the later Move",
		).not.toBeNull();
		expect((await chunks(f)).every((row) => row.path === "/source/note.txt")).toBe(true);
		await assert_reads(f, "/target/source/note.txt");
		const second = await start_move(f, f.sourceId, "root");
		await drive_to(f, second, "complete");
		await finish(f, first);
		await finish(f, second);
		await assert_reused(f, original);
		await assert_reads(f, "/source/note.txt");
		expect((await chunks(f)).every((row) => row.path === "/source/note.txt")).toBe(true);
	}, 120_000);

	test("keeps a separately archived child's chunks and repairs their cache path", async () => {
		const f = await fixture();
		expect(
			(
				await f.asUser.mutation(api.files_nodes.archive_nodes, {
					membershipId: f.db.membershipId,
					nodeIds: [f.nodeId],
				})
			)._nay,
		).toBeUndefined();
		await test_finish_saved_scope_jobs(f.t);
		const original = await chunks(f);
		const archiveId = original[0]!.archiveOperationId;
		expect(archiveId).toBeDefined();
		const move = await start_move(f);
		await drive_to(f, move, "publish");
		await assert_reused(f, original);
		await drive_to(f, move, "finish_sides");
		expect(await saved_search(f, { kind: "content", text: "movechunkneedle" })).toEqual([]);
		await finish(f, move);
		await assert_reused(f, original);
		expect((await chunks(f)).every((row) => row.archiveOperationId === archiveId)).toBe(true);
		expect(
			(
				await f.asUser.mutation(api.files_nodes.unarchive_nodes, {
					membershipId: f.db.membershipId,
					nodeIds: [f.nodeId],
				})
			)._nay,
		).toBeUndefined();
		await test_finish_saved_scope_jobs(f.t);
		await assert_reads(f, "/target/source/note.txt");
	}, 120_000);

	test("scope changes use current access while sharing normal chunks", async () => {
		const f = await fixture();
		const readers = [await add_member(f, "losing"), await add_member(f, "gaining")];
		for (const [index, nodeId] of [f.sourceId, f.targetId].entries()) {
			expect(
				await f.asUser.mutation(api.files_sharing.restrict_node, { membershipId: f.db.membershipId, nodeId }),
			).toEqual({ _yay: null });
			expect(
				await f.asUser.mutation(api.files_sharing.set_node_share_grant, {
					membershipId: f.db.membershipId,
					nodeId,
					principal: { kind: "user", userId: readers[index]!.userId },
					level: "read",
				}),
			).toEqual({ _yay: null });
		}
		// Drive the real scope repair before starting this Move.
		while (true) {
			const op = await f.t.run((ctx) => ctx.db.query("files_subtree_ops").first());
			if (!op) break;
			const walk = (await f.t.run((ctx) =>
				ctx.db
					.query("files_subtree_op_walks")
					.withIndex("by_op", (q) => q.eq("opId", op._id))
					.unique(),
			))!;
			await f.t.mutation(internal.files_subtree_ops.advance, { opId: op._id, step: walk.step });
		}
		const original = await chunks(f);
		const read = (index: number) =>
			readers[index]!.asUser.query(api.files_nodes.get_file_node_for_membership, {
				membershipId: readers[index]!.membershipId,
				fileNodeId: f.nodeId,
			});
		expect(await read(0)).not.toBeNull();
		expect(await read(1)).toBeNull();
		const move = await start_move(f, f.nodeId);
		await drive_to(f, move, "publish");
		expect(await read(0)).not.toBeNull();
		expect(await read(1)).toBeNull();
		await drive_to(f, move, "finish_sides");
		expect(await read(0), "old scope reader loses access at publication").toBeNull();
		expect(await read(1), "new scope reader gains the current placement").toMatchObject({ path: "/target/note.txt" });
		expect(await saved_search(f, { kind: "content", text: "movechunkneedle" }, undefined, readers[0]!)).toEqual([]);
		expect(await saved_search(f, { kind: "content", text: "movechunkneedle" }, undefined, readers[1]!)).toEqual([
			{ nodeId: f.nodeId, path: "/target/note.txt" },
		]);
		await assert_reused(f, original);
		await finish(f, move);
		await assert_reused(f, original);
	}, 120_000);
});
