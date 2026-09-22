import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

const FOUR_HOURS = 4 * 60 * 60 * 1000;
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: crypto.randomUUID(),
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	return { t, db, scope, asUser, threadId: thread._yay.threadId };
}

async function draft(f: Awaited<ReturnType<typeof fixture>>, path: string) {
	const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
		...f.scope,
		path,
		kind: "folder",
	});
	if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected a private folder");
	const proposal = await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
	if (!proposal || proposal.target.kind !== "private") throw new Error("Expected its proposal");
	return proposal;
}

async function expiry(f: Awaited<ReturnType<typeof fixture>>, pendingUpdateId: Id<"files_pending_updates">) {
	const task = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates_cleanup_tasks")
			.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", pendingUpdateId))
			.unique(),
	);
	if (!task) throw new Error("Expected the expiry task");
	return task;
}

async function expire(f: Awaited<ReturnType<typeof fixture>>, task: Doc<"files_pending_updates_cleanup_tasks">) {
	await f.t.mutation(internal.files_pending_updates.remove_file_pending_update_if_expired, {
		cleanupTaskId: task._id,
		expiryGeneration: task.expiryGeneration,
	});
}

describe("Copy proposal holds", () => {
	test("holds source pages and the private destination as soon as they are accepted", async () => {
		const f = await fixture();
		const source = await draft(f, "/source");
		const second = await draft(f, "/second");
		const parent = await draft(f, "/target/parent");
		const sourceTask = await expiry(f, source._id);
		vi.setSystemTime(sourceTask.expiresAt - 1);
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.db.membershipId,
			threadId: f.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			requestId: "held-intake",
			kind: "copy",
			expectedSourceCount: 2,
			sources: [source.target],
			targetParent: parent.target,
			targetPath: "/target/parent",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.append_sources_for_agent, {
				membershipId: f.db.membershipId,
				threadId: f.threadId,
				runId: started._yay.runId,
				offset: 1,
				sources: [second.target],
			}),
		).toEqual({ _yay: null });
		vi.setSystemTime(sourceTask.expiresAt + 1);
		for (const proposal of [source, second, parent]) {
			await expire(f, await expiry(f, proposal._id));
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual(proposal);
			if (proposal.target.kind !== "private") throw new Error("Expected a private target");
			const id = proposal.target.id;
			expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", id)))?.state).toBe("active");
		}
		const holds = await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect());
		expect(holds.map((hold) => [hold.pendingUpdateId, hold.role])).toEqual([
			[source._id, "source"],
			[parent._id, "destination_parent"],
			[second._id, "source"],
		]);
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect())).toEqual([]);
	});

	test.each(["existing", "created"] as const)(
		"Retry holds an empty %s destination parent before its first page",
		async (kind) => {
			const f = await fixture();
			const source = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
				...f.scope,
				path: "/source",
			});
			if (source._nay) throw new Error(source._nay.message);
			const parent = kind === "existing" ? await draft(f, "/target") : null;
			const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
				membershipId: f.db.membershipId,
				threadId: f.threadId,
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				requestId: "parent-handoff",
				kind: "copy",
				expectedSourceCount: 1,
				sources: [{ kind: "saved", id: source._yay.nodeId }],
				targetParent: parent?.target ?? { kind: "root" },
				targetPath: kind === "existing" ? "/target" : "/",
				targetName: null,
				missingParentNames: kind === "created" ? ["target"] : [],
				conflictPolicy: { file: "error", folder: "error" },
			});
			if (started._nay) throw new Error(started._nay.message);
			const runId = started._yay.runId;
			expect(
				await f.t.mutation(internal.files_transfer.seal_for_agent, {
					membershipId: f.db.membershipId,
					threadId: f.threadId,
					runId,
				}),
			).toEqual({ _yay: null });
			let output = parent;
			for (let step = 0; step < 20; step++) {
				const run = await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
				if (kind === "existing" && run?.step === "apply") break;
				if (kind === "created" && run?.preparedParent?.kind === "private") {
					const id = run.preparedParent.id;
					output = await f.t.run((ctx) =>
						ctx.db
							.query("files_pending_updates")
							.withIndex("by_target", (q) => q.eq("target.kind", "private").eq("target.id", id))
							.unique(),
					);
					break;
				}
				await f.t.mutation(internal.files_transfer.advance, { runId });
			}
			if (!output || output.target.kind !== "private") throw new Error("Expected an empty private parent");
			const targetId = output.target.id;
			const pendingUpdateId = output._id;
			expect(
				(await f.t.run((ctx) => ctx.db.query("files_transfer_items").collect())).every(
					(item) => item.outputTarget === null,
				),
			).toBe(true);
			expect(await f.asUser.mutation(api.files_transfer.stop, { membershipId: f.db.membershipId, runId })).toEqual({
				_yay: null,
			});
			for (let step = 0; step < 3; step++) await f.t.mutation(internal.files_transfer.advance, { runId });
			await f.t.mutation(internal.files_pending_holds.release_producer, {
				producer: { kind: "files_transfer_run", id: runId },
			});
			const cleanup = await expiry(f, output._id);
			vi.setSystemTime(cleanup.expiresAt - 1);
			const retryArgs = { membershipId: f.db.membershipId, runId, requestId: "parent-retry" };
			const retried = await f.asUser.mutation(api.files_transfer.retry_remaining, retryArgs);
			if (retried._nay) throw new Error(retried._nay.message);
			expect(await f.asUser.mutation(api.files_transfer.retry_remaining, retryArgs)).toEqual(retried);
			vi.setSystemTime(cleanup.expiresAt + 1);
			await expire(f, cleanup);
			expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", targetId)))?.state).toBe("active");
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pendingUpdateId))).toEqual(output);
			const holds = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_holds")
					.withIndex("by_producer_pendingUpdate_role", (q) =>
						q
							.eq("producer.kind", "files_transfer_run")
							.eq("producer.id", retried._yay.runId)
							.eq("pendingUpdateId", pendingUpdateId),
					)
					.collect(),
			);
			expect(holds.map((hold) => hold.role)).toEqual(["destination_parent"]);

			// A hold delays expiry, but explicit Discard still closes this exact parent.
			expect(
				await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
					membershipId: f.db.membershipId,
					target: output.target,
					pendingUpdateId: output._id,
					reviewedRevision: output.revision,
				}),
			).toEqual({ _yay: null });
			expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", targetId)))?.state).toBe("discarded");
		},
	);

	test("keeps early output through a long Copy, Stop, and a retry", async () => {
		const f = await fixture();
		let sourceId: Id<"files_nodes"> | undefined;
		for (const path of ["/source", ...Array.from({ length: 20 }, (_, i) => `/source/child-${i}`)]) {
			const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, { ...f.scope, path });
			if (created._nay) throw new Error(created._nay.message);
			if (path === "/source") sourceId = created._yay.nodeId;
		}
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.db.membershipId,
			threadId: f.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "personal",
			requestId: "long-copy",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [{ kind: "saved", id: sourceId! }],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: null,
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.db.membershipId,
				threadId: f.threadId,
				runId,
			}),
		).toEqual({ _yay: null });
		let output: Doc<"files_pending_updates"> | null = null;
		for (let step = 0; step < 50 && !output; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId });
			output = await f.t.run((ctx) => ctx.db.query("files_pending_updates").first());
		}
		const rootId = output?._id;
		await f.t.mutation(internal.files_transfer.advance, { runId });
		output = await f.t.run(
			async (ctx) =>
				(await ctx.db.query("files_pending_updates").collect()).find((proposal) => proposal._id !== rootId) ?? null,
		);
		if (!output || output.target.kind !== "private") throw new Error("Expected the first copied folder");
		const outputId = output.target.id;
		const original = await expiry(f, output._id);
		for (let step = 0; step < 13; step++) {
			vi.setSystemTime(Date.now() + 20 * 60 * 1000);
			await f.t.mutation(internal.files_transfer.advance, { runId });
		}
		expect(Date.now()).toBeGreaterThan(original.expiresAt);
		await expire(f, original);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", outputId)))?.state).toBe("active");
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", output!._id))).toEqual(output);
		expect(
			(await f.asUser.mutation(api.files_transfer.stop, { membershipId: f.db.membershipId, runId }))._nay,
		).toBeUndefined();
		for (let step = 0; step < 10; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId });
			if ((await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.outputReviewUntil !== undefined) break;
		}
		const ended = await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId));
		expect(ended?.outputReviewUntil).toBe(Date.now() + FOUR_HOURS);
		await f.t.mutation(internal.files_pending_holds.release_producer, {
			producer: { kind: "files_transfer_run", id: runId },
		});
		const retained = await expiry(f, output._id);
		expect(retained.expiresAt).toBe(ended!.outputReviewUntil);
		vi.setSystemTime(retained.expiresAt - 1);
		const retried = await f.asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: f.db.membershipId,
			runId,
			requestId: "long-copy-retry",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		await f.t.mutation(internal.files_transfer.advance, { runId: retried._yay.runId });
		vi.setSystemTime(retained.expiresAt + 1);
		await expire(f, retained);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", outputId)))?.state).toBe("active");
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", output!._id))).toEqual(output);
		const newHolds = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_holds")
				.withIndex("by_producer_pendingUpdate_role", (q) =>
					q
						.eq("producer.kind", "files_transfer_run")
						.eq("producer.id", retried._yay.runId)
						.eq("pendingUpdateId", output!._id),
				)
				.collect(),
		);
		expect(newHolds.map((hold) => hold.role)).toEqual(["output"]);
	});
});
