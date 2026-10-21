import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PaginationResult } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { pending_chunks, pending_metadata } from "./files_move_pages.ts";
import { files_nodes_db_archive_nodes } from "./files_nodes.ts";
import { run_job } from "./files_pending_overlay.ts";
import { db_replace_file_chunks } from "./files_nodes_content.ts";
import { accept_input, advance as advance_transfer } from "./files_transfer.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_db_get_slot_cohort,
	test_finish_transfer_run,
	test_mocks_fill_db_with,
	test_rename_node,
	test_spy_handler,
} from "./setup.test.ts";
import { r2_confirmed_object_delete } from "./r2_client.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { files_pending_overlay_db_schedule_saved_scope } from "../server/files-pending-overlay.ts";
import { files_pending_review_facts_db_get_state } from "../server/files-pending-review-facts.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";

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

/**
 * A saved file with its saved plain text chunks and metadata docs outside any Move view, and its
 * saved scope job.
 */
async function read_saved_docs(t: ReturnType<typeof test_convex>, nodeId: Id<"files_nodes">) {
	return await t.run(async (ctx) => {
		const node = (await ctx.db.get("files_nodes", nodeId))!;
		const chunks = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
				q
					.eq("organizationId", node.organizationId)
					.eq("workspaceId", node.workspaceId)
					.eq("fileNodeId", nodeId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined),
			)
			.collect();
		const metadata = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_source_fileNode", (q) =>
				q
					.eq("organizationId", node.organizationId)
					.eq("workspaceId", node.workspaceId)
					.eq("sourceKind", "committed")
					.eq("fileNodeId", nodeId)
					.eq("moveView.cohortId", undefined)
					.eq("moveView.view", undefined),
			)
			.collect();
		const job = await ctx.db
			.query("files_pending_overlay_jobs")
			.withIndex("by_kind_key", (q) => q.eq("kind", "saved_scope").eq("key", nodeId))
			.unique();
		return { node, chunks, metadata, job };
	});
}

/**
 * The saved docs whose scope differs from their node.
 */
function stale_docs({ node, chunks, metadata }: Awaited<ReturnType<typeof read_saved_docs>>) {
	const archiveOperationId = node.archiveOperationId ?? undefined;
	return [
		...chunks.filter((doc) => doc.path !== node.path || doc.archiveOperationId !== archiveOperationId),
		...metadata.filter(
			(doc) =>
				doc.path !== node.path ||
				doc.treePath !== node.treePath ||
				doc.archiveOperationId !== archiveOperationId ||
				(doc.sourceKind === "committed" &&
					doc.docKind === "field" &&
					(doc.parentId !== node.parentId ||
						doc.name !== node.name ||
						doc.sortName !== files_sort_text_key(node.name) ||
						doc.isRestrictedScopeRoot !== (node.restrictedScopeNodeId === node._id))),
		),
	];
}

test("pending scope pages follow the latest saved path and archive state without changing reviewed content", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/project/note.md",
		textContent: "Saved text.\n",
	});
	const destinationFileId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/destination/seed.txt",
		textContent: "",
	});
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const target = { kind: "saved" as const, id: nodeId };
	const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
		...scope,
		target,
	});
	if (batch._nay) throw new Error(batch._nay.message);
	const text = `---\n${Array.from({ length: 12 }, (_, index) => `key${index}: value${index}`).join("\n")}\n---\n${"Pending paragraph.\n\n".repeat(1000)}`;
	expect(
		await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			...scope,
			operationBatchId: batch._yay.operationBatchId,
			role: "unstaged",
			text,
		}),
	).toEqual({ _yay: null });
	expect(
		await t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
			...scope,
			target,
			operationBatchId: batch._yay.operationBatchId,
		}),
	).toEqual({ _yay: null });
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
	const initial = await t.run(async (ctx) => {
		const node = (await ctx.db.get("files_nodes", nodeId))!;
		const destination = (await ctx.db.get("files_nodes", destinationFileId))!;
		const proposal = await ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) => q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", nodeId))
			.unique();
		return { node, destination, proposal };
	});
	expect(initial.proposal).not.toBeNull();
	expect(initial.proposal?.pendingMove).toBeUndefined();
	const readPendingDocs = async () => await t.run(async (ctx) => {
		const node = (await ctx.db.get("files_nodes", nodeId))!;
		const chunks = await ctx.db
			.query("files_plain_text_chunks")
			.withIndex("by_organization_workspace_target_chunkIndex", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("target.kind", "saved")
					.eq("target.id", nodeId),
			)
			.collect();
		const metadata = await ctx.db
			.query("files_metadata_docs")
			.withIndex("by_organization_workspace_target_fieldPath", (q) =>
				q
					.eq("organizationId", db.organizationId)
					.eq("workspaceId", db.workspaceId)
					.eq("target.kind", "saved")
					.eq("target.id", nodeId),
			)
			.collect();
		return { node, chunks, metadata, proposal: await ctx.db.get("files_pending_updates", initial.proposal!._id) };
	});
	const original = await readPendingDocs();
	const scopePages = { chunks: 0, metadata: 0 };
	const pageIds = { chunks: new Set<string>(), metadata: new Set<string>() };
	const stagedDocs: Record<"chunks" | "metadata", Array<{ id: string; fields: Record<string, unknown> }>> = {
		chunks: [],
		metadata: [],
	};
	let stageCohortId: Id<"files_move_cohorts"> | null = null;
	let recordPages = true;
	// A parent may join several pages. Check the actual child results without changing joining.
	for (const [registered, key] of [
		[pending_chunks, "chunks"],
		[pending_metadata, "metadata"],
	] as const)
		test_spy_handler(registered, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			if (
				!recordPages ||
				(args as { pendingUpdateId: Id<"files_pending_updates"> }).pendingUpdateId !== initial.proposal!._id
			)
				return result;
			const page = result as unknown as PaginationResult<
				Doc<"files_plain_text_chunks"> | Doc<"files_metadata_docs">
			>;
			expect(page.page.length, `${key} stage in native pages`).toBeLessThanOrEqual(8);
			if (page.page.length > 0) scopePages[key]++;
			for (const doc of page.page) {
				expect(pageIds[key].has(doc._id), `${key} source docs are staged once`).toBe(false);
				pageIds[key].add(doc._id);
			}
			const cohort = await test_db_get_slot_cohort(ctx, db);
			expect(cohort, "pending scope pages stage before publication").toMatchObject({
				publishedAt: null,
				visibleView: "before",
			});
			if (stageCohortId !== null) expect(cohort?._id).toBe(stageCohortId);
			stageCohortId = cohort!._id;
			expect(
				(await ctx.db.get("files_nodes", nodeId))?.path,
				"the saved path stays visible while scope pages stage",
			).toBe("/project/note.md");
			return result;
		});
	// Observe the parent's real writes. A child page returns before these AFTER copies are inserted.
	for (const registered of [accept_input, advance_transfer, advance_cohort]) {
		test_spy_handler(registered, async (handler, ctx, args) => {
			const insert = vi.spyOn(ctx.db, "insert");
			try {
				const result = await handler(ctx, args);
				if (!recordPages) return result;
				for (const [index, call] of insert.mock.calls.entries()) {
					const key = call[0] === "files_plain_text_chunks" ? "chunks" : call[0] === "files_metadata_docs" ? "metadata" : null;
					const fields = call[1] as Partial<Doc<"files_plain_text_chunks"> | Doc<"files_metadata_docs">>;
					if (
						!key ||
						fields.sourceKind !== "pending" ||
						fields.pendingUpdateId !== initial.proposal!._id ||
						fields.moveView?.view !== "after" ||
						fields.moveView.cohortId !== stageCohortId
					) continue;
					expect(fields.path, `${key} AFTER copies use the destination while staging`).toBe("/destination/project/note.md");
					if (key === "metadata") expect(fields).toMatchObject({ treePath: "/destination/project/note.md" });
					const id = await insert.mock.results[index]!.value as string;
					expect(stagedDocs[key].some((doc) => doc.id === id), `${key} AFTER copies are observed once`).toBe(false);
					stagedDocs[key].push({ id, fields: { ...fields } });
				}
				return result;
			} finally {
				insert.mockRestore();
			}
		});
	}
	const started = await asUser.mutation(api.files_transfer.accept_input, {
		membershipId: db.membershipId,
		requestId: "pending-scope-parent-move",
		kind: "move",
		expectedSourceCount: 1,
		sourceIds: [initial.node.parentId as typeof nodeId],
		targetParentId: initial.destination.parentId,
	});
	if (started._nay) throw new Error(started._nay.message);
	const { runId } = started._yay;
	expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
		_yay: null,
	});
	await test_finish_transfer_run(asUser, runId);
	recordPages = false;
	expect((await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId }))?.activity.status).toBe(
		"succeeded",
	);
	expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/destination/project/note.md");
	expect(scopePages.chunks, "pending search docs span several scope pages").toBeGreaterThan(1);
	expect(scopePages.metadata, "pending metadata docs span several scope pages").toBeGreaterThan(1);
	for (const key of ["chunks", "metadata"] as const) {
		expect([...pageIds[key]].sort(), `${key} pages visit every source doc`).toEqual(
			original[key].map((doc) => doc._id).sort(),
		);
		expect(stagedDocs[key], `Every ${key} AFTER copy is inserted once`).toHaveLength(original[key].length);
		expect(stagedDocs[key].map((doc) => doc.fields), `${key} staged payloads keep every source value`).toEqual(
			expect.arrayContaining(original[key].map(({ _id, _creationTime, ...fields }) => ({
				...fields,
				moveView: { cohortId: stageCohortId, view: "after" },
				path: "/destination/project/note.md",
				...(key === "metadata" ? { treePath: "/destination/project/note.md" } : {}),
			}))),
		);
	}
	const moved = await readPendingDocs();
	expect(moved.chunks.map(({ _id, _creationTime, ...fields }) => fields)).toEqual(
		original.chunks.map(({ _id, _creationTime, ...fields }) => ({ ...fields, path: moved.node.path })),
	);
	expect(moved.metadata.map(({ _id, _creationTime, ...fields }) => fields)).toEqual(
		original.metadata.map(({ _id, _creationTime, ...fields }) => ({
			...fields,
			path: moved.node.path,
			treePath: moved.node.treePath,
		})),
	);
	expect(moved.proposal).toEqual(initial.proposal);
	expect(
		await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId,
			path: "latest.md",
		}),
	).toMatchObject({ _yay: { runId: expect.any(String), activityId: expect.any(String) } });
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
	const repaired = await readPendingDocs();
	expect(repaired.node.path).toBe("/destination/project/latest.md");
	expect(repaired.chunks.length).toBeGreaterThan(4);
	expect(repaired.metadata.length).toBeGreaterThan(4);
	expect(
		repaired.chunks.every((doc) => doc.path === repaired.node.path),
		"all pending search docs follow the latest saved path",
	).toBe(true);
	expect(
		repaired.metadata.every((doc) => doc.path === repaired.node.path && doc.treePath === repaired.node.treePath),
		"all pending metadata docs follow the latest saved path",
	).toBe(true);
	expect(repaired.proposal).toEqual(initial.proposal);
	for (const archived of [true, false]) {
		const args = { membershipId: db.membershipId, nodeIds: [nodeId] };
		expect(
			archived
				? await asUser.mutation(api.files_nodes.archive_nodes, args)
				: await asUser.mutation(api.files_nodes.unarchive_nodes, args),
		).toEqual({ _yay: null });
		await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
		const current = await readPendingDocs();
		expect(current.node.archiveOperationId !== null).toBe(archived);
		expect(
			[...current.chunks, ...current.metadata].every(
				(doc) => doc.archiveOperationId === (current.node.archiveOperationId ?? undefined),
			),
			"pending content docs follow Archive and Restore",
		).toBe(true);
		expect(current.proposal).toEqual(initial.proposal);
	}
}, 60_000);

test("a saved scope job pages a file's saved docs and ends equal to the node after a fast Archive and Restore", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/project/big.md",
		textContent: "Saved.",
	});
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
	// About 330 chunks: more than one job page. A real Save of this size is slow in tests.
	const body = Array.from({ length: 25_000 }, (_, index) => index.toString(36).padStart(15, "-")).join("\n");
	const frontmatter = Array.from({ length: 12 }, (_, index) => `key${index}: value${index}`).join("\n");
	await t.run((ctx) =>
		db_replace_file_chunks(ctx, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			textContent: `---\n${frontmatter}\n---\n${body}`,
		}),
	);
	const saved = await read_saved_docs(t, nodeId);
	expect(saved.chunks.length).toBeGreaterThan(256);
	expect(saved.metadata.length).toBeGreaterThan(12);
	expect(stale_docs(saved)).toEqual([]);
	const reviewJobs = async () =>
		(await t.run((ctx) => files_pending_review_facts_db_get_state(ctx.db, db)))?.pendingJobCount ?? 0;
	const reviewJobsBefore = await reviewJobs();

	const args = { membershipId: db.membershipId, nodeIds: [nodeId] };
	expect(await asUser.mutation(api.files_nodes.archive_nodes, args)).toEqual({ _yay: null });
	const archived = await read_saved_docs(t, nodeId);
	expect(archived.node.archiveOperationId).not.toBeNull();
	expect(stale_docs(archived), "Archive leaves the saved docs to the job").toHaveLength(
		archived.chunks.length + archived.metadata.length,
	);
	expect(archived.job).toMatchObject({ cursor: null });
	expect(await reviewJobs(), "the saved scope job does not hold up reviews").toBe(reviewJobsBefore);

	// First run: all metadata docs, so folder tables catch up first.
	vi.runOnlyPendingTimers();
	await t.finishInProgressScheduledFunctions();
	const metadataDone = await read_saved_docs(t, nodeId);
	expect(
		metadataDone.metadata.filter((doc) => doc.archiveOperationId === undefined),
		"metadata goes first",
	).toEqual([]);
	expect(JSON.parse(metadataDone.job!.cursor!)).toMatchObject({ phase: 1, page: null });

	// Second run: the first page of chunks only.
	vi.runOnlyPendingTimers();
	await t.finishInProgressScheduledFunctions();
	const halfway = await read_saved_docs(t, nodeId);
	expect(JSON.parse(halfway.job!.cursor!)).toMatchObject({ phase: 1, page: expect.any(String) });
	const archivedChunks = halfway.chunks.filter((chunk) => chunk.archiveOperationId !== undefined).length;
	expect(archivedChunks).toBeGreaterThan(0);
	expect(archivedChunks).toBeLessThan(halfway.chunks.length);

	expect(await asUser.mutation(api.files_nodes.unarchive_nodes, args)).toEqual({ _yay: null });
	expect(JSON.parse((await read_saved_docs(t, nodeId)).job!.cursor!), "Restore asks for one more pass").toMatchObject({
		rerun: true,
	});
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
	const restored = await read_saved_docs(t, nodeId);
	expect(restored.node.archiveOperationId).toBeNull();
	expect(restored.job).toBeNull();
	expect(stale_docs(restored), "every saved doc follows the restored node").toEqual([]);
}, 120_000);

test("a saved scope job waits while a Move holds its file, then follows the moved file", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/project/note.md",
		textContent: "---\ntitle: Note\ntags: [a, b]\n---\nSaved text.\n",
	});
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
	const saved = await read_saved_docs(t, nodeId);
	expect(saved.chunks.length).toBeGreaterThan(0);
	expect(saved.metadata.length).toBeGreaterThan(0);

	const renamed = await asUser.mutation(api.files_nodes.rename_node, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		nodeId,
		path: "renamed.md",
	});
	if (!renamed._yay) throw new Error(renamed._nay?.message ?? "Expected the Rename job");
	const { runId } = renamed._yay;
	// Drive the Rename until its Move holds the file.
	const holder = () =>
		t.run(async (ctx) => {
			const cohort = await test_db_get_slot_cohort(ctx, db);
			const reservation = await ctx.db
				.query("files_move_source_reservations")
				.withIndex("by_source", (q) => q.eq("source.kind", "saved").eq("source.id", nodeId))
				.unique();
			return cohort && reservation?.cohortId === cohort._id ? cohort : null;
		});
	for (let pass = 0; pass < 100 && !(await holder()); pass++) {
		const cohort = await t.run((ctx) => test_db_get_slot_cohort(ctx, db));
		if (cohort)
			await asUser.action(internal.files_move_run.run, {
				cohortId: cohort._id,
				step: cohort.step,
				runGeneration: cohort.runJob?.generation ?? null,
				mode: "step",
			});
		else await t.mutation(internal.files_transfer.advance, { runId });
	}
	const cohort = await holder();
	expect(cohort, "the Move holds the file").not.toBeNull();

	await t.run(async (ctx) =>
		files_pending_overlay_db_schedule_saved_scope(ctx, (await ctx.db.get("files_nodes", nodeId))!),
	);
	const job = (await read_saved_docs(t, nodeId)).job!;
	await t.mutation(internal.files_pending_overlay.run_job, {
		kind: job.kind,
		key: job.key,
		nextAttemptAt: job.nextAttemptAt,
	});
	expect((await read_saved_docs(t, nodeId)).job?.blockedByCohortId, "the job waits for the Move").toBe(cohort!._id);
	// A new write does not start a parked job: the Move wakes it. The test ran the job by hand, so
	// cancel its scheduled run, like a run that ended.
	await t.run((ctx) => ctx.scheduler.cancel(job.scheduledFunctionId));
	await t.run(async (ctx) =>
		files_pending_overlay_db_schedule_saved_scope(ctx, (await ctx.db.get("files_nodes", nodeId))!),
	);
	expect((await read_saved_docs(t, nodeId)).job?.scheduledFunctionId, "a parked job stays parked").toBe(
		job.scheduledFunctionId,
	);

	await test_finish_transfer_run(asUser, runId);
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
	const moved = await read_saved_docs(t, nodeId);
	expect(moved.node.path).toBe("/project/renamed.md");
	expect(moved.job, "the Move wakes the job, and the job ends").toBeNull();
	expect(stale_docs(moved)).toEqual([]);
}, 60_000);

test("an Archive that names a node twice makes one saved scope job", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/project/twice.md",
		textContent: "---\ntitle: Twice\n---\nSaved text.\n",
	});
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);

	await t.run((ctx) =>
		files_nodes_db_archive_nodes({
			ctx,
			nodeIds: [nodeId, nodeId],
			updatedBy: db.userId,
			now: Date.now(),
		}),
	);
	const jobs = await t.run((ctx) =>
		ctx.db
			.query("files_pending_overlay_jobs")
			.withIndex("by_kind_key", (q) => q.eq("kind", "saved_scope").eq("key", nodeId))
			.collect(),
	);
	// Two docs would make every run and every later schedule throw on `.unique()`.
	expect(jobs, "one job doc per node").toHaveLength(1);
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
	const archived = await read_saved_docs(t, nodeId);
	expect(archived.job).toBeNull();
	expect(stale_docs(archived)).toEqual([]);
}, 60_000);

test("a Restore starts a saved scope job again when its run was lost", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/project/lost.md",
		textContent: "---\ntitle: Lost\n---\nSaved text.\n",
	});
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
	const args = { membershipId: db.membershipId, nodeIds: [nodeId] };
	// The bulk archive always uses a job. The archive door copies a small item's docs inline instead.
	await t.run((ctx) => files_nodes_db_archive_nodes({ ctx, nodeIds: [nodeId], updatedBy: db.userId, now: Date.now() }));
	// A failed run leaves the job doc the same as a lost one.
	const lost = (await read_saved_docs(t, nodeId)).job!;
	expect(lost, "Archive leaves a saved scope job for recovery").not.toBeNull();
	await t.run((ctx) => ctx.scheduler.cancel(lost.scheduledFunctionId));

	expect(await asUser.mutation(api.files_nodes.unarchive_nodes, args)).toEqual({ _yay: null });
	const restarted = (await read_saved_docs(t, nodeId)).job!;
	const run = await t.run((ctx) => ctx.db.system.get("_scheduled_functions", restarted.scheduledFunctionId));
	expect(run?.state.kind, "Restore starts the lost job again").toBe("pending");
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
	const restored = await read_saved_docs(t, nodeId);
	expect(restored.job).toBeNull();
	expect(stale_docs(restored)).toEqual([]);
}, 60_000);

test("an area change copies few metadata docs at once, and walks many in a job without the text chunks", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const plainId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/team/plain.txt",
		textContent: "Saved text.\n",
	});
	const noteId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/team/note.md",
		textContent: "---\ntitle: Note\n---\nSaved text.\n",
	});
	const frontmatter = Array.from({ length: 17 }, (_, index) => `key${index}: value${index}`).join("\n");
	const bigId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/team/big.md",
		textContent: `---\n${frontmatter}\n---\nSaved text.\n`,
	});
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
	expect((await read_saved_docs(t, plainId)).metadata).toEqual([]);
	const note = await read_saved_docs(t, noteId);
	expect(note.metadata.length).toBeGreaterThan(0);
	const big = await read_saved_docs(t, bigId);
	expect(big.metadata.length, "more docs than the step copies itself").toBeGreaterThan(16);
	// Only a walk of the chunks would fix these stale chunks.
	const staleChunkIds = [note.chunks[0]!._id, big.chunks[0]!._id];
	await t.run(async (ctx) => {
		for (const chunkId of staleChunkIds) await ctx.db.patch("files_plain_text_chunks", chunkId, { path: "/stale" });
	});
	const jobKeys: string[] = [];
	test_spy_handler(run_job, async (handler, ctx, args) => {
		const { kind, key } = args as { kind: string; key: string };
		if (kind === "saved_scope") jobKeys.push(key);
		return await handler(ctx, args);
	});

	const folderId = note.node.parentId as Id<"files_nodes">;
	expect(
		(await asUser.mutation(api.files_sharing.restrict_node, { membershipId: db.membershipId, nodeId: folderId }))._nay,
	).toBeUndefined();
	const areas = (docs: Doc<"files_metadata_docs">[]) =>
		docs.map((doc) => doc.sourceKind === "committed" && doc.restrictedScopeNodeId);
	const noteRestricted = await read_saved_docs(t, noteId);
	expect(noteRestricted.job, "a file with few metadata docs gets no job").toBeNull();
	expect(areas(noteRestricted.metadata), "its metadata docs follow the area in the request").toEqual(
		noteRestricted.metadata.map(() => folderId),
	);
	expect(JSON.parse((await read_saved_docs(t, bigId)).job!.cursor!)).toMatchObject({ metadataOnly: true });

	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
	expect(new Set(jobKeys), "only the file with many metadata docs runs a job").toEqual(new Set([bigId]));
	const bigRestricted = await read_saved_docs(t, bigId);
	expect(bigRestricted.job).toBeNull();
	expect(areas(bigRestricted.metadata), "the job moves the metadata docs to the area").toEqual(
		bigRestricted.metadata.map(() => folderId),
	);
	const chunks = [...(await read_saved_docs(t, noteId)).chunks, ...bigRestricted.chunks];
	expect(
		staleChunkIds.map((chunkId) => chunks.find((chunk) => chunk._id === chunkId)?.path),
		"an area change skips the text chunks",
	).toEqual(["/stale", "/stale"]);
}, 60_000);
