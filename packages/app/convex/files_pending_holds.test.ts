import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { activities_db_finish } from "./activities_db.ts";
import {
	files_pending_holds_db_acquire,
	files_pending_holds_db_finish,
	files_pending_holds_db_release,
	files_pending_holds_db_release_producer_batch,
} from "./files_pending_holds.ts";
import { files_db_reschedule_pending_update_cleanup_for_user } from "../server/files.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";

const FOUR_HOURS = 4 * 60 * 60 * 1000;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const source = await t.mutation(internal.files_nodes.create_folder_node_by_path, { ...scope, path: "/source" });
	if (source._nay) throw new Error(source._nay.message);
	const started = await asUser.mutation(api.files_transfer.start, {
		membershipId: db.membershipId,
		requestId: crypto.randomUUID(),
		kind: "copy",
		expectedSourceCount: 1,
		sourceIds: [source._yay.nodeId],
		targetParentId: "root",
	});
	if (started._nay) throw new Error(started._nay.message);
	const producer = { kind: "files_transfer_run" as const, id: started._yay.runId };
	return { t, db, scope, asUser, producer, sourceId: source._yay.nodeId };
}

async function draft(f: Awaited<ReturnType<typeof fixture>>, path = "/draft") {
	const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
		...f.scope,
		path,
		kind: "folder",
	});
	if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected the private folder");
	const proposal = await f.t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
	if (!proposal || proposal.target.kind !== "private") throw new Error("Expected a private proposal");
	const node = await f.t.run((ctx) =>
		ctx.db.get("files_pending_nodes", proposal.target.id as Id<"files_pending_nodes">),
	);
	if (!node) throw new Error("Expected the private node");
	return { proposal, node };
}

async function hold(
	f: Awaited<ReturnType<typeof fixture>>,
	d: Awaited<ReturnType<typeof draft>>,
	role: Doc<"files_pending_holds">["role"] = "output",
) {
	expect(
		await f.t.run((ctx) =>
			files_pending_holds_db_acquire(ctx, {
				producer: f.producer,
				pendingUpdateId: d.proposal._id,
				target: d.proposal.target,
				privateGeneration: d.node.creationGeneration,
				expectedRevision: d.proposal.revision,
				role,
			}),
		),
	).toEqual({ _yay: null });
}

async function task(f: Awaited<ReturnType<typeof fixture>>, proposal: Doc<"files_pending_updates">) {
	const cleanup = await f.t.run((ctx) =>
		ctx.db
			.query("files_pending_updates_cleanup_tasks")
			.withIndex("by_pendingUpdate", (q) => q.eq("pendingUpdateId", proposal._id))
			.unique(),
	);
	if (!cleanup) throw new Error("Expected the expiry task");
	return cleanup;
}

async function expire(f: Awaited<ReturnType<typeof fixture>>, cleanup: Doc<"files_pending_updates_cleanup_tasks">) {
	await f.t.mutation(internal.files_pending_updates.remove_file_pending_update_if_expired, {
		cleanupTaskId: cleanup._id,
		expiryGeneration: cleanup.expiryGeneration,
	});
}

async function finish(
	f: Awaited<ReturnType<typeof fixture>>,
	status: "succeeded" | "partial" | "failed" | "canceled" | "timed_out" = "succeeded",
) {
	await f.t.run(async (ctx) => {
		await activities_db_finish(ctx, { sourceId: f.producer.id, status, errorMessage: null, now: Date.now() });
		await files_pending_holds_db_finish(ctx, { producer: f.producer });
	});
}

describe("proposal hold expiry", () => {
	test("an active output survives its deadline without a fake edit", async () => {
		const f = await fixture();
		const d = await draft(f);
		await hold(f, d);
		const original = await task(f, d.proposal);
		vi.setSystemTime(original.expiresAt + 1);
		await expire(f, original);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", d.node._id))).toEqual(d.node);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", d.proposal._id))).toEqual(d.proposal);
		const delayed = await task(f, d.proposal);
		expect(delayed.expiresAt).toBe(original.expiresAt);
		expect(delayed.expiryGeneration).toBe(original.expiryGeneration + 1);
		expect(delayed._id).toBe(original._id);
		const scheduled = await f.t.run((ctx) => ctx.db.system.get("_scheduled_functions", delayed.scheduledFunctionId!));
		expect(scheduled?.scheduledTime).toBe(Date.now() + 60_000);
	});

	test.each([false, true])("terminal output survives an old callback; release first=%s", async (releaseFirst) => {
		const f = await fixture();
		const d = await draft(f);
		await hold(f, d);
		const original = await task(f, d.proposal);
		vi.setSystemTime(original.expiresAt + 1);
		const endedAt = Date.now();
		await finish(f);
		if (releaseFirst) await f.t.mutation(internal.files_pending_holds.release_producer, { producer: f.producer });
		await expire(f, original);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", d.node._id)))?.state).toBe("active");
		const retained = await task(f, d.proposal);
		expect(retained.expiresAt).toBe(endedAt + FOUR_HOURS);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", d.proposal._id))).toEqual(d.proposal);
		vi.setSystemTime(endedAt + FOUR_HOURS - 1);
		await expire(f, retained);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", d.node._id)))?.state).toBe("active");
		vi.setSystemTime(endedAt + FOUR_HOURS);
		await expire(f, retained);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", d.node._id)))?.state).toBe("discarded");
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.sourceId))).not.toBeNull();
	});

	test.each(["succeeded", "partial", "failed", "canceled", "timed_out"] as const)(
		"%s fixes one terminal window and replay cannot extend it",
		async (status) => {
			const f = await fixture();
			const d = await draft(f);
			await hold(f, d);
			const endedAt = Date.now();
			await finish(f, status);
			vi.setSystemTime(endedAt + 1000);
			await finish(f, status);
			expect((await f.t.run((ctx) => ctx.db.get("files_transfer_runs", f.producer.id)))?.outputReviewUntil).toBe(
				endedAt + FOUR_HOURS,
			);
		},
	);

	test("source release keeps another role on the same proposal and does not change its deadline", async () => {
		const f = await fixture();
		const d = await draft(f);
		await hold(f, d, "source");
		await hold(f, d, "destination_parent");
		await hold(f, d, "destination_parent");
		const before = await task(f, d.proposal);
		await f.t.run((ctx) =>
			files_pending_holds_db_release(ctx, { producer: f.producer, pendingUpdateId: d.proposal._id, role: "source" }),
		);
		expect((await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).map((hold) => hold.role)).toEqual([
			"destination_parent",
		]);
		expect(await task(f, d.proposal)).toEqual(before);
		vi.setSystemTime(before.expiresAt + 1);
		await expire(f, before);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", d.node._id)))?.state).toBe("active");
	});

	test("presence after finish survives late release and an old callback", async () => {
		const f = await fixture();
		const d = await draft(f);
		await hold(f, d);
		const original = await task(f, d.proposal);
		await finish(f);
		vi.setSystemTime(Date.now() + FOUR_HOURS - 1000);
		await f.t.run((ctx) => files_db_reschedule_pending_update_cleanup_for_user(ctx, f.scope));
		const refreshed = await task(f, d.proposal);
		await f.t.mutation(internal.files_pending_holds.release_producer, { producer: f.producer });
		expect((await task(f, d.proposal)).expiresAt).toBe(refreshed.expiresAt);
		vi.setSystemTime(original.expiresAt + 1);
		await expire(f, original);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", d.node._id)))?.state).toBe("active");
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", d.proposal._id))).toEqual(d.proposal);
	});

	test("a stale expiry token cannot delete a draft even after both deadlines pass", async () => {
		const f = await fixture();
		const d = await draft(f);
		const original = await task(f, d.proposal);
		vi.setSystemTime(Date.now() + 60_000);
		await f.t.run((ctx) => files_db_reschedule_pending_update_cleanup_for_user(ctx, f.scope));
		const refreshed = await task(f, d.proposal);
		expect(refreshed.expiryGeneration).toBe(original.expiryGeneration + 1);
		vi.setSystemTime(refreshed.expiresAt);
		await expire(f, original);
		expect(await task(f, d.proposal)).toEqual(refreshed);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", d.node._id))).toEqual(d.node);
		await expire(f, refreshed);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", d.node._id)))?.state).toBe("discarded");
	});

	test("an expired ancestor waits for a held descendant without acquiring ancestor holds", async () => {
		const f = await fixture();
		const parent = await draft(f, "/parent");
		const child = await draft(f, "/parent/child");
		await hold(f, child, "source");
		const parentTask = await task(f, parent.proposal);
		vi.setSystemTime(parentTask.expiresAt + 1);
		await expire(f, parentTask);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", parent.node._id)))?.state).toBe("active");
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", child.node._id)))?.state).toBe("active");
	});

	test("source folder holds protect descendants before discovery reaches them", async () => {
		const f = await fixture();
		const parent = await draft(f, "/parent");
		await draft(f, "/parent/middle");
		const leaf = await draft(f, "/parent/middle/leaf");
		await hold(f, parent, "source");
		const cleanup = await task(f, leaf.proposal);
		vi.setSystemTime(cleanup.expiresAt + 1);
		await expire(f, cleanup);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", leaf.node._id)))?.state).toBe("active");
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", leaf.proposal._id))).toEqual(leaf.proposal);
		await finish(f);
		// A source hold adds no output-review window, even before its release page runs.
		await expire(f, await task(f, leaf.proposal));
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", leaf.node._id)))?.state).toBe("discarded");
	});

	test("only source holds are inherited, not an ancestor's output hold", async () => {
		const f = await fixture();
		const parent = await draft(f, "/parent");
		const leaf = await draft(f, "/parent/leaf");
		await hold(f, parent, "output");
		const cleanup = await task(f, leaf.proposal);
		vi.setSystemTime(cleanup.expiresAt);
		await expire(f, cleanup);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", leaf.node._id)))?.state).toBe("discarded");
	});

	test("ancestor expiry drains eight stale source holds before checking the next producer", async () => {
		const f = await fixture();
		const parent = await draft(f, "/parent");
		const leaf = await draft(f, "/parent/leaf");
		let current = f;
		for (let i = 0; i < 8; i++) {
			await hold(current, parent, "source");
			await finish(current);
			const next = await f.asUser.mutation(api.files_transfer.start, {
				membershipId: f.db.membershipId,
				requestId: `ancestor-${i}`,
				kind: "copy",
				expectedSourceCount: 1,
				sourceIds: [f.sourceId],
				targetParentId: "root",
			});
			if (next._nay) throw new Error(next._nay.message);
			current = { ...f, producer: { kind: "files_transfer_run", id: next._yay.runId } };
		}
		await hold(current, parent, "source");
		const cleanup = await task(f, leaf.proposal);
		vi.setSystemTime(cleanup.expiresAt);
		await expire(f, cleanup);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).toHaveLength(1);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", leaf.node._id)))?.state).toBe("active");
		await expire(f, await task(f, leaf.proposal));
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", leaf.node._id)))?.state).toBe("active");
		await finish(current);
		await expire(f, await task(f, leaf.proposal));
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", leaf.node._id)))?.state).toBe("discarded");
	});

	test("ready output replaces only its preparing role", async () => {
		const f = await fixture();
		const d = await draft(f);
		await hold(f, d, "source");
		await hold(f, d, "preparing_output");
		await hold(f, d, "output");
		expect(
			(await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).map((hold) => hold.role).sort(),
		).toEqual(["output", "source"]);
	});

	test("a retry keeps a late output alive before its manifest page is cloned", async () => {
		const f = await fixture();
		await finish(f);
		for (let i = 0; i < 51; i++) {
			const created = await f.t.mutation(internal.files_nodes.create_folder_node_by_path, {
				...f.scope,
				path: `/source/folder-${i}`,
			});
			if (created._nay) throw new Error(created._nay.message);
		}
		const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.db.membershipId,
			clientGeneratedId: "retry-retention",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.db.membershipId,
			threadId: thread._yay.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			requestId: "retained-copy",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [{ kind: "saved", id: f.sourceId }],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: "copied",
			missingParentNames: [],
			conflictPolicy: { file: "error", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.db.membershipId,
				threadId: thread._yay.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 300; step++) {
			const activity = await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId));
			if (activity?.progress?.completed === 51) break;
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		}
		expect((await f.t.run((ctx) => ctx.db.get("activities", started._yay.activityId)))?.progress?.completed).toBe(51);
		expect(
			await f.asUser.mutation(api.files_transfer.stop, {
				membershipId: f.db.membershipId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 5; step++)
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		const producer = { kind: "files_transfer_run" as const, id: started._yay.runId };
		while (!(await f.t.run((ctx) => files_pending_holds_db_release_producer_batch(ctx, { producer }))).done) {
			/* Drain two pages. */
		}
		const output = await f.t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", producer.id).eq("order", 50))
				.unique(),
		);
		if (output?.outputTarget?.kind !== "private") throw new Error("Expected the late private output");
		const privateNodeId = output.outputTarget.id;
		const proposal = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_target", (q) => q.eq("target.kind", "private").eq("target.id", privateNodeId))
				.unique(),
		);
		if (!proposal) throw new Error("Expected the late output proposal");
		const cleanup = await task(f, proposal);
		vi.setSystemTime(cleanup.expiresAt - 1);
		const retried = await f.asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: f.db.membershipId,
			runId: producer.id,
			requestId: "retained-retry",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		await f.t.mutation(internal.files_transfer.advance, { runId: retried._yay.runId });
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", retried._yay.runId))).toMatchObject({
			step: "retry",
			retryCursor: 49,
		});
		vi.setSystemTime(cleanup.expiresAt + 1);
		await expire(f, cleanup);
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", privateNodeId)))?.state).toBe("active");
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual(proposal);
		await f.t.mutation(internal.files_transfer.advance, { runId: retried._yay.runId });
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_holds")
					.withIndex("by_producer_pendingUpdate_role", (q) =>
						q
							.eq("producer.kind", "files_transfer_run")
							.eq("producer.id", retried._yay.runId)
							.eq("pendingUpdateId", proposal._id)
							.eq("role", "output"),
					)
					.unique(),
			),
		).not.toBeNull();
	});

	test("explicit Discard wins over an active output hold and recovery drops it", async () => {
		const f = await fixture();
		const d = await draft(f);
		await hold(f, d);
		expect(
			await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
				membershipId: f.db.membershipId,
				target: d.proposal.target,
				pendingUpdateId: d.proposal._id,
				reviewedRevision: d.proposal.revision,
			}),
		).toEqual({ _yay: null });
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", d.node._id)))?.state).toBe("discarded");
		await f.t.mutation(internal.files_pending_holds.recover, {});
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).toEqual([]);
		await finish(f);
		await f.t.mutation(internal.files_pending_holds.release_producer, { producer: f.producer });
		expect((await f.t.run((ctx) => ctx.db.get("files_pending_nodes", d.node._id)))?.state).toBe("discarded");
	});

	test("producer release drains at most 32 holds without deleting proposals", async () => {
		const f = await fixture();
		for (let i = 0; i < 33; i++) await hold(f, await draft(f, `/draft-${i}`));
		await finish(f);
		expect(
			await f.t.run((ctx) => files_pending_holds_db_release_producer_batch(ctx, { producer: f.producer })),
		).toEqual({ done: false, deletedCount: 32 });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_holds").collect())).toHaveLength(1);
		expect(
			await f.t.run((ctx) => files_pending_holds_db_release_producer_batch(ctx, { producer: f.producer })),
		).toEqual({ done: true, deletedCount: 1 });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_updates").collect())).toHaveLength(33);
	});
});

describe("saved replacement retry expiry", () => {
	beforeEach(() => {
		const objects = new Map<string, BodyInit>();
		let workCount = 0;
		vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => `hold-copy-${++workCount}` as never);
		vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
		vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
		vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
			key,
			url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
		}));
		vi.spyOn(R2.prototype, "getUrl").mockImplementation(
			async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
				const key = url.searchParams.get("key") ?? "";
				if (url.pathname === "/upload" && init?.method === "PUT") {
					objects.set(key, init.body ?? "");
					return new Response(null, { status: 200 });
				}
				const body = objects.get(key);
				return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
			}),
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	test.each(
		(["unchanged", "same_proposal_renamed", "same_proposal_replaced", "new_proposal"] as const).flatMap((change) =>
			[false, true].map((advanceFirst) => ({ change, advanceFirst })),
		),
	)(
		"binds the retry bridge to its exact saved replacement: $change (cloned=$advanceFirst)",
		async ({ change, advanceFirst }) => {
			const f = await fixture();
			await finish(f);
			const personal = await f.t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, {
					userId: f.db.userId,
					organizationName: "personal",
					workspaceName: "home",
				}),
			);
			const sourceIds: Id<"files_nodes">[] = [];
			for (const path of ["/replace.txt", "/remaining.txt"])
				sourceIds.push(
					await test_create_saved_text_file(f.t, {
						membershipId: personal.membershipId,
						path,
						textContent: "New bytes\n",
					}),
				);
			const destinationId = await test_create_saved_text_file(f.t, {
				membershipId: f.db.membershipId,
				path: "/replace.txt",
				textContent: "Old bytes\n",
			});
			const destinationBefore = await f.t.run((ctx) => ctx.db.get("files_nodes", destinationId));
			const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
				membershipId: f.db.membershipId,
				clientGeneratedId: "replacement-hold",
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const startCopy = async (ids: Id<"files_nodes">[]) => {
				const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
					membershipId: f.db.membershipId,
					threadId: thread._yay.threadId,
					sourceWorkspace: "personal",
					destinationWorkspace: "current",
					requestId: crypto.randomUUID(),
					kind: "copy",
					expectedSourceCount: ids.length,
					sources: ids.map((id) => ({ kind: "saved" as const, id })),
					targetParent: { kind: "root" },
					targetPath: "/",
					targetName: null,
					missingParentNames: [],
					conflictPolicy: { file: "replace", folder: "error" },
				});
				if (started._nay) throw new Error(started._nay.message);
				expect(
					await f.t.mutation(internal.files_transfer.seal_for_agent, {
						membershipId: f.db.membershipId,
						threadId: thread._yay.threadId,
						runId: started._yay.runId,
					}),
				).toEqual({ _yay: null });
				return started._yay.runId;
			};
			const copyFirst = async (runId: Id<"files_transfer_runs">) => {
				for (let step = 0; step < 20; step++) {
					await f.t.mutation(internal.files_transfer.advance, { runId });
					const item = await f.t.run((ctx) =>
						ctx.db
							.query("files_transfer_items")
							.withIndex("by_run_order", (q) => q.eq("runId", runId).eq("order", 0))
							.unique(),
					);
					if (!item?.workId) continue;
					await f.t.action(internal.files_nodes_content.copy_transfer_file, {
						itemId: item._id,
						attempt: item.attempt,
					});
					expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", item._id))).toMatchObject({
						state: "completed",
						outputTarget: { kind: "saved", id: destinationId },
					});
					await f.t.mutation(internal.files_transfer.handle_copy_complete, {
						workId: item.workId,
						context: { itemId: item._id, attempt: item.attempt },
						result: { kind: "success", returnValue: null },
					});
					return;
				}
				throw new Error("Expected a completed replacement");
			};
			const stopAndRelease = async (runId: Id<"files_transfer_runs">) => {
				expect(await f.asUser.mutation(api.files_transfer.stop, { membershipId: f.db.membershipId, runId })).toEqual({
					_yay: null,
				});
				const items = await f.t.run((ctx) =>
					ctx.db
						.query("files_transfer_items")
						.withIndex("by_run_order", (q) => q.eq("runId", runId))
						.collect(),
				);
				for (const item of items)
					if (item.workId)
						await f.t.mutation(internal.files_transfer.handle_copy_complete, {
							workId: item.workId,
							context: { itemId: item._id, attempt: item.attempt },
							result: { kind: "canceled" },
						});
				for (let step = 0; step < 3; step++) await f.t.mutation(internal.files_transfer.advance, { runId });
				await f.t.mutation(internal.files_pending_holds.release_producer, {
					producer: { kind: "files_transfer_run", id: runId },
				});
			};
			const getProposal = async () => {
				const proposal = await f.t.run((ctx) =>
					ctx.db
						.query("files_pending_updates")
						.withIndex("by_organization_workspace_user_target", (q) =>
							q
								.eq("organizationId", f.db.organizationId)
								.eq("workspaceId", f.db.workspaceId)
								.eq("userId", f.db.userId)
								.eq("target.kind", "saved")
								.eq("target.id", destinationId),
						)
						.unique(),
				);
				if (!proposal?.pendingReplacement) throw new Error("Expected the saved replacement proposal");
				return proposal;
			};
			const originalRunId = await startCopy(sourceIds);
			await copyFirst(originalRunId);
			const original = await getProposal();
			const output = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", originalRunId).eq("order", 0))
					.unique(),
			);
			expect(output?.outputProposal).toEqual({
				pendingUpdateId: original._id,
				privateGeneration: null,
				replacementAssetId: original.pendingReplacement!.assetId,
			});
			await stopAndRelease(originalRunId);
			if (change === "same_proposal_renamed") {
				expect(
					(
						await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
							...f.scope,
							target: original.target,
							destParent: { kind: "root" },
							destName: "renamed.txt",
							threadId: thread._yay.threadId,
						})
					)._nay,
				).toBeUndefined();
			}
			const retained = change === "unchanged" || change === "same_proposal_renamed";
			if (!retained) {
				if (change === "new_proposal")
					expect(
						await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
							membershipId: f.db.membershipId,
							target: original.target,
							pendingUpdateId: original._id,
							reviewedRevision: original.revision,
						}),
					).toEqual({ _yay: null });
				const replacementRunId = await startCopy([sourceIds[0]!]);
				await copyFirst(replacementRunId);
				await stopAndRelease(replacementRunId);
				// Normal history cleanup removes the newer manifest, not its ready proposal.
				for (let page = 0; page < 10; page++) {
					await f.t.mutation(internal.files_transfer.delete_run_batch, { runId: replacementRunId });
					if (!(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", replacementRunId)))) break;
				}
				expect(await f.t.run((ctx) => ctx.db.get("files_transfer_runs", replacementRunId))).toBeNull();
			}
			const proposal = await getProposal();
			if (change === "new_proposal") expect(proposal._id).not.toBe(original._id);
			else expect(proposal._id).toBe(original._id);
			if (change === "same_proposal_renamed") expect(proposal.revision).toBeGreaterThan(original.revision);
			if (!retained) expect(proposal.pendingReplacement!.assetId).not.toBe(original.pendingReplacement!.assetId);
			const cleanup = await task(f, proposal);
			vi.setSystemTime(cleanup.expiresAt - 1);
			const retry = await f.asUser.mutation(api.files_transfer.retry_remaining, {
				membershipId: f.db.membershipId,
				runId: originalRunId,
				requestId: "replacement-retry",
			});
			if (retry._nay) throw new Error(retry._nay.message);
			if (advanceFirst) await f.t.mutation(internal.files_transfer.advance, { runId: retry._yay.runId });
			vi.setSystemTime(cleanup.expiresAt + 1);
			await expire(f, cleanup);
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id))).toEqual(
				retained ? proposal : null,
			);
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", destinationId))).toEqual(destinationBefore);
			if (retained) {
				if (!advanceFirst) await f.t.mutation(internal.files_transfer.advance, { runId: retry._yay.runId });
				const copied = await f.t.run((ctx) =>
					ctx.db
						.query("files_transfer_items")
						.withIndex("by_run_order", (q) => q.eq("runId", retry._yay.runId))
						.collect(),
				);
				expect(copied[0]?.outputProposal).toEqual(output?.outputProposal);
				expect(copied[1]).toMatchObject({ state: "pending", outputTarget: null });
				expect(copied[1]?.outputProposal).toBeUndefined();
				expect(
					await f.t.run((ctx) =>
						ctx.db
							.query("files_pending_holds")
							.withIndex("by_producer_pendingUpdate_role", (q) =>
								q
									.eq("producer.kind", "files_transfer_run")
									.eq("producer.id", retry._yay.runId)
									.eq("pendingUpdateId", proposal._id)
									.eq("role", "output"),
							)
							.unique(),
					),
				).not.toBeNull();
			}
		},
	);
});
