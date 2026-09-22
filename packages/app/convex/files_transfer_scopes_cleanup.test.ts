import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { r2_create_asset_key } from "./r2_client.ts";
import { test_convex, test_create_saved_text_file, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_ROOT_ID } from "../shared/files.ts";

beforeEach(() => {
	vi.useFakeTimers();
	let workCount = 0;
	vi.spyOn(Workpool.prototype, "enqueueAction").mockImplementation(async () => `scope-work-${++workCount}` as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: `https://r2.test/upload?key=${encodeURIComponent(key)}`,
	}));
	vi.spyOn(R2.prototype, "getUrl").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	const objects = new Map<string, BodyInit>();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			const key = url.searchParams.get("key");
			if (url.origin !== "https://r2.test" || !key) throw new Error("Unexpected test request");
			if (url.pathname === "/upload" && init?.method === "PUT") {
				objects.set(key, init.body ?? "");
				return new Response(null, { status: 200 });
			}
			const body = objects.get(key);
			return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
		}),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function create_transfer_fixture(args: {
	sourceWorkspace: "current" | "personal";
	destinationWorkspace: "current" | "personal";
}) {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const thread = await asUser.mutation(api.ai_chat.thread_create, {
		membershipId: db.membershipId,
		clientGeneratedId: "scope-cleanup",
		lastMessageAt: Date.now(),
	});
	if (thread._nay) throw new Error(thread._nay.message);
	const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
		userId: db.userId,
		membershipId: db.membershipId,
	});
	if (captured._nay) throw new Error(captured._nay.message);
	const source = captured._yay[args.sourceWorkspace];
	const destination = captured._yay[args.destinationWorkspace];
	const sourceIds: Id<"files_nodes">[] = [];
	for (const name of ["one", "two"]) {
		sourceIds.push(
			await test_create_saved_text_file(t, {
				membershipId: source.membershipId,
				path: `/${name}.txt`,
				textContent: name,
			}),
		);
	}
	const target = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
		organizationId: destination.organizationId,
		workspaceId: destination.workspaceId,
		userId: db.userId,
		path: "/target",
	});
	if (target._nay) throw new Error(target._nay.message);
	const started = await t.mutation(internal.files_transfer.start_for_agent, {
		membershipId: db.membershipId,
		threadId: thread._yay.threadId,
		sourceWorkspace: args.sourceWorkspace,
		destinationWorkspace: args.destinationWorkspace,
		requestId: "scope-copy",
		kind: "copy",
		expectedSourceCount: sourceIds.length,
		sources: sourceIds.map((id) => ({ kind: "saved" as const, id })),
		targetParent: { kind: "saved", id: target._yay.nodeId },
		targetPath: "/target",
		targetName: null,
		missingParentNames: [],
		conflictPolicy: { file: "error", folder: "error" },
	});
	if (started._nay) throw new Error(started._nay.message);
	expect(
		await t.mutation(internal.files_transfer.seal_for_agent, {
			membershipId: db.membershipId,
			threadId: thread._yay.threadId,
			runId: started._yay.runId,
		}),
	).toEqual({ _yay: null });
	return { t, db, asUser, source, destination, sourceIds, targetId: target._yay.nodeId, ...started._yay };
}

async function finish_workspace_purge(t: ReturnType<typeof test_convex>, requestId: Id<"data_deletion_requests">) {
	for (let step = 0; step < 300; step++) {
		const result = await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId });
		if (result.done) return;
	}
	throw new Error("Workspace purge did not finish");
}

describe("process_workspace_deletion_request transfer scopes", () => {
	test.each([
		{ scope: "source", sourceWorkspace: "personal", destinationWorkspace: "current" },
		{ scope: "destination", sourceWorkspace: "current", destinationWorkspace: "personal" },
		{ scope: "chat", sourceWorkspace: "personal", destinationWorkspace: "personal" },
	] as const)("drains $scope runs before files, refuses late workers, and keeps sibling runs", async (scopes) => {
		const cancelWork = vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined);
		const fixture = await create_transfer_fixture(scopes);
		const { t, db, asUser, source, destination, runId, activityId, sourceIds, targetId } = fixture;
		const purgeScope = scopes.scope === "chat" ? db : scopes.scope === "source" ? source : destination;

		// The current organization's home workspace is outside all three run scopes.
		const sibling = await t.run(async (ctx) => {
			const organization = await ctx.db.get("organizations", db.organizationId);
			const membership = await ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", organization!.defaultWorkspaceId!).eq("userId", db.userId).eq("active", true),
				)
				.first();
			if (!membership) throw new Error("Missing sibling membership");
			return membership;
		});
		const siblingFolder = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
			organizationId: sibling.organizationId,
			workspaceId: sibling.workspaceId,
			userId: db.userId,
			path: "/untouched",
		});
		if (siblingFolder._nay) throw new Error(siblingFolder._nay.message);
		const control = await asUser.mutation(api.files_transfer.start, {
			membershipId: sibling._id,
			requestId: "untouched",
			kind: "copy",
			expectedSourceCount: 1,
			sourceIds: [siblingFolder._yay.nodeId],
			targetParentId: files_ROOT_ID,
		});
		if (control._nay) throw new Error(control._nay.message);
		expect(
			await asUser.mutation(api.files_transfer.seal, {
				membershipId: sibling._id,
				runId: control._yay.runId,
			}),
		).toEqual({ _yay: null });
		const beforeControl = await t.run(async (ctx) => ({
			run: await ctx.db.get("files_transfer_runs", control._yay.runId),
			activity: await ctx.db.get("activities", control._yay.activityId),
			items: await ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", control._yay.runId))
				.take(10),
			file: await ctx.db.get("files_nodes", siblingFolder._yay.nodeId),
		}));

		let items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.take(10),
		);
		for (
			let step = 0;
			step < 30 && (items.length < sourceIds.length || !items.every((item) => item.workId !== null));
			step++
		) {
			await t.mutation(internal.files_transfer.advance, { runId });
			items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.take(10),
			);
		}
		expect(items).toHaveLength(2);
		const staged = [];
		for (const item of items) {
			if (!item.workId) throw new Error("Expected a live copy worker");
			const captured = await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
				itemId: item._id,
				attempt: item.attempt,
			});
			if (captured._nay) throw new Error(captured._nay.message);
			expect(captured._yay).not.toBeNull();
			const assets = await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
				itemId: item._id,
				attempt: item.attempt,
				workId: item.workId,
				contentSize: 3,
			});
			if (assets._nay) throw new Error(assets._nay.message);
			if (!assets._yay) throw new Error("Expected staged copy assets");
			const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", assets._yay!.contentAssetId));
			staged.push({
				itemId: item._id,
				attempt: item.attempt,
				workId: item.workId,
				...assets._yay,
				putMayArriveUntil: asset!.putMayArriveUntil,
			});
		}
		// Leave one upload staged and seal the other, ready for a late commit.
		const ready = staged[1]!;
		expect(
			await t.mutation(internal.files_nodes_content.seal_transfer_file_capture, {
				itemId: ready.itemId,
				attempt: ready.attempt,
				workId: ready.workId,
				contentAssetId: ready.contentAssetId,
				text: "two",
			}),
		).toEqual({ _yay: null });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", ready.itemId))).toMatchObject({
			capture: { artifact: { contentAssetId: ready.contentAssetId } },
		});
		const requestId = await t.run(async (ctx) => {
			// More than one Activity cleanup batch must keep the Activity and run together.
			for (let index = 0; index < 51; index++) {
				const userId = await ctx.db.insert("users", { clerkUserId: null });
				await ctx.db.insert("activities_user_states", { userId, activityId, dismissedAt: Date.now() });
			}
			return await data_deletion_db_request(ctx, {
				userId: db.userId,
				organizationId: purgeScope.organizationId,
				workspaceId: purgeScope.workspaceId,
				scope: "workspace",
				eligibleAt: 0,
			});
		});

		expect(
			await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId, _test_batchSize: 1 }),
		).toEqual({ done: false, deletedCount: 1 });
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({ status: "stopping" });
		// Selection docs drain first. Stop when one work item remains for the late-worker checks.
		for (let pass = 0; pass < sourceIds.length + 1; pass++) {
			const remaining = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.take(10),
			);
			if (remaining.length === 1) break;
			expect(remaining).toHaveLength(sourceIds.length);
			expect(
				await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId, _test_batchSize: 1 }),
			).toEqual({ done: false, deletedCount: 1 });
		}
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_transfer_selection_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			),
		).toEqual([]);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.take(10),
			),
		).toHaveLength(1);
		for (const attempt of staged) {
			expect(cancelWork).toHaveBeenCalledWith(expect.anything(), attempt.workId);
			expect(await t.run((ctx) => ctx.db.get("files_r2_assets", attempt.contentAssetId))).toBeNull();
			const key = r2_create_asset_key({
				organizationId: destination.organizationId,
				workspaceId: destination.workspaceId,
				assetId: attempt.contentAssetId,
			});
			expect(
				await t.run((ctx) =>
					ctx.db
						.query("files_r2_object_deletion_jobs")
						.withIndex("by_r2_key", (q) => q.eq("r2Key", key))
						.first(),
				),
			).toMatchObject({ r2Key: key, putMayArriveUntil: attempt.putMayArriveUntil });
			// One item is gone; the other still exists under the run's Stop fence.
			expect(
				await t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, {
					itemId: attempt.itemId,
					attempt: attempt.attempt,
					workId: attempt.workId,
					contentAssetId: attempt.contentAssetId,
					text: "late",
				}),
			).toEqual({ _yay: null });
		}
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_pending_nodes")
					.withIndex("by_organization_workspace_user_state", (q) =>
						q
							.eq("organizationId", destination.organizationId)
							.eq("workspaceId", destination.workspaceId)
							.eq("userId", db.userId)
							.eq("state", "active"),
					)
					.take(10),
			),
		).toEqual([]);

		await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId, _test_batchSize: 1 });
		// Retire preparation holds before draining Activity viewers.
		expect(
			await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId, _test_batchSize: 1 }),
		).toEqual({ done: false, deletedCount: 2 });
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_pending_holds")
					.withIndex("by_producer_pendingUpdate_role", (q) =>
						q.eq("producer.kind", "files_transfer_run").eq("producer.id", runId),
					)
					.first(),
			),
		).toBeNull();
		expect(
			await t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId, _test_batchSize: 1 }),
		).toEqual({ done: false, deletedCount: 50 });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).not.toBeNull();
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("activities_user_states")
					.withIndex("by_activity", (q) => q.eq("activityId", activityId))
					.take(100),
			),
		).toHaveLength(1);
		for (const nodeId of [...sourceIds, targetId])
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).not.toBeNull();

		await finish_workspace_purge(t, requestId);
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toBeNull();
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("activities_user_states")
					.withIndex("by_activity", (q) => q.eq("activityId", activityId))
					.take(100),
			),
		).toEqual([]);
		for (const attempt of staged) {
			expect(
				await t.mutation(internal.files_transfer.handle_copy_complete, {
					workId: attempt.workId,
					context: { itemId: attempt.itemId, attempt: attempt.attempt },
					result: { kind: "success", returnValue: null },
				}),
			).toBeNull();
		}
		await t.mutation(internal.files_transfer.advance, { runId });
		expect(
			await t.run(async (ctx) => ({
				run: await ctx.db.get("files_transfer_runs", control._yay.runId),
				activity: await ctx.db.get("activities", control._yay.activityId),
				items: await ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", control._yay.runId))
					.take(10),
				file: await ctx.db.get("files_nodes", siblingFolder._yay.nodeId),
			})),
		).toEqual(beforeControl);
	});

	test.each([
		{ scope: "source", save: false },
		{ scope: "source", save: true },
		{ scope: "chat", save: false },
		{ scope: "chat", save: true },
	] as const)("keeps completed output on $scope purge (saved: $save)", async ({ scope, save }) => {
		const { t, db, asUser, source, destination, runId, activityId } = await create_transfer_fixture({
			sourceWorkspace: "personal",
			destinationWorkspace: scope === "source" ? "current" : "personal",
		});
		for (let step = 0; step < 30; step++) {
			await t.mutation(internal.files_transfer.advance, { runId });
			const working = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_work", (q) => q.eq("runId", runId).gt("workId", null))
					.take(4),
			);
			for (const item of working) {
				await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
				await t.mutation(internal.files_transfer.handle_copy_complete, {
					workId: item.workId!,
					context: { itemId: item._id, attempt: item.attempt },
					result: { kind: "success", returnValue: null },
				});
			}
			const activity = await t.run((ctx) => ctx.db.get("activities", activityId));
			if (activity?.status === "succeeded") break;
		}
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({ status: "succeeded" });
		const items = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.take(10),
		);
		expect(items).toHaveLength(2);
		const outputs = [];
		for (const item of items) {
			expect(item.state).toBe("completed");
			if (item.outputTarget?.kind !== "private") throw new Error("Expected a private copy");
			const target = item.outputTarget;
			const node = await t.run((ctx) => ctx.db.get("files_pending_nodes", target.id));
			if (!node) throw new Error("Missing private copy");
			const proposal = await t.run((ctx) =>
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_user_target", (q) =>
						q.eq("userId", db.userId).eq("target.kind", "private").eq("target.id", node._id),
					)
					.first(),
			);
			if (!proposal) throw new Error("Missing copy proposal");
			if (save) {
				const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
					membershipId: destination.membershipId,
					target: item.outputTarget,
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
				});
				if (saved._nay) throw new Error(saved._nay.message);
				if (saved._yay.target.kind !== "saved") throw new Error("Expected a saved copy");
				const savedTarget = saved._yay.target;
				const savedNode = await t.run((ctx) => ctx.db.get("files_nodes", savedTarget.id));
				if (!savedNode) throw new Error("Missing saved copy");
				outputs.push({ kind: "saved" as const, node: savedNode });
			} else {
				if (!proposal.content) throw new Error("Missing copied text");
				const { baseStateId, stagedStateId, unstagedStateId } = proposal.content;
				const states = await t.run((ctx) =>
					Promise.all(
						[baseStateId, stagedStateId, unstagedStateId].map((id) =>
							ctx.db.get("files_pending_update_yjs_states", id),
						),
					),
				);
				expect(states.every(Boolean)).toBe(true);
				outputs.push({ kind: "private" as const, node, proposal, states });
			}
		}
		const outputAssets = await t.run((ctx) =>
			ctx.db
				.query("files_r2_assets")
				.withIndex("by_organization_workspace", (q) =>
					q.eq("organizationId", destination.organizationId).eq("workspaceId", destination.workspaceId),
				)
				.take(20),
		);
		if (save) expect(outputAssets.length).toBeGreaterThan(0);
		const purgeScope = scope === "source" ? source : db;
		const requestId = await t.run((ctx) =>
			data_deletion_db_request(ctx, {
				userId: db.userId,
				organizationId: purgeScope.organizationId,
				workspaceId: purgeScope.workspaceId,
				scope: "workspace",
				eligibleAt: 0,
			}),
		);
		await finish_workspace_purge(t, requestId);
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", runId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toBeNull();
		for (const asset of outputAssets)
			expect(await t.run((ctx) => ctx.db.get("files_r2_assets", asset._id))).toEqual(asset);
		for (const output of outputs) {
			if (output.kind === "saved") {
				expect(await t.run((ctx) => ctx.db.get("files_nodes", output.node._id))).toEqual(output.node);
			} else {
				expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", output.node._id))).toEqual(output.node);
				expect(await t.run((ctx) => ctx.db.get("files_pending_updates", output.proposal._id))).toEqual(output.proposal);
				for (const state of output.states)
					expect(await t.run((ctx) => ctx.db.get("files_pending_update_yjs_states", state!._id))).toEqual(state);
			}
		}
	});
});
