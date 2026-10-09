import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex, test_rename_node, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import { r2_confirmed_object_delete } from "./r2_client.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";

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
	const started = await asUser.mutation(api.files_transfer.start, {
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
	for (let step = 0; step < 24; step++) {
		await t.mutation(internal.files_transfer.advance, { runId });
		const receipt = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId });
		if (receipt?.activity.status === "succeeded") break;
	}
	// Finish the real subtree walk before driving the pending side-doc pages.
	for (let step = 0; step < 10; step++) {
		const walks = await t.run((ctx) => ctx.db.query("files_subtree_op_walks").collect());
		if (walks.length === 0) break;
		for (const walk of walks)
			await t.mutation(internal.files_subtree_ops.advance, { opId: walk.opId, step: walk.step });
	}
	expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.path).toBe("/destination/project/note.md");
	const readJob = async () =>
		await t.run((ctx) =>
			ctx.db
				.query("files_pending_overlay_jobs")
				.withIndex("by_kind_key", (q) => q.eq("kind", "saved_node").eq("key", nodeId))
				.unique(),
		);
	expect(await readJob(), "file path-only changes queue pending scope repair").not.toBeNull();
	let reachedScopePage = false;
	for (let step = 0; step < 10; step++) {
		const currentJob = await readJob();
		if (!currentJob) break;
		await t.mutation(internal.files_pending_overlay.run_job, {
			kind: currentJob.kind,
			key: currentJob.key,
			nextAttemptAt: currentJob.nextAttemptAt,
		});
		const job = await readJob();
		const cursor = job?.cursor ? (JSON.parse(job.cursor) as { phase: number; page: string | null }) : null;
		if (cursor?.phase === 4 && cursor.page) {
			reachedScopePage = true;
			break;
		}
	}
	expect(reachedScopePage, "pending search docs span several scope pages").toBe(true);
	expect(
		await test_rename_node(t, asUser, {
			membershipId: db.membershipId,
			nodeId,
			path: "latest.md",
		}),
	).toMatchObject({ _yay: { runId: expect.any(String), activityId: expect.any(String) } });
	await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 5_000);
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
