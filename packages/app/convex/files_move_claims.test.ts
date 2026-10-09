import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { advance as advance_transfer } from "./files_transfer.ts";
import { run_job as run_overlay_job } from "./files_pending_overlay.ts";
import { test_convex, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";
import { bash_DbFilesFs } from "../server/bash-utils.ts";
import { files_ROOT_ID } from "../shared/files.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type Metrics = Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>;

function transaction_cost(before: Metrics, after: Metrics) {
	return {
		databaseQueries: after.databaseQueries.used - before.databaseQueries.used,
		documentsRead: after.documentsRead.used - before.documentsRead.used,
		bytesRead: after.bytesRead.used - before.bytesRead.used,
		documentsWritten: after.documentsWritten.used - before.documentsWritten.used,
		bytesWritten: after.bytesWritten.used - before.bytesWritten.used,
		functionsScheduled: after.functionsScheduled.used - before.functionsScheduled.used,
	};
}

test("saved Moves refresh more than 32 native private name claims in one flush", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const folder = async (parentId: Id<"files_nodes"> | typeof files_ROOT_ID, name: string) => {
		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId,
			path: name,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};
	const sourceId = await folder(files_ROOT_ID, "src");
	const destinationId = await folder(files_ROOT_ID, "dest");
	const otherId = await folder(files_ROOT_ID, "other");
	const nodeId = await folder(sourceId, "shared");

	// Drain due work only. Jumping to expiry would discard the drafts under test.
	const settle = async () => {
		for (let step = 0; step < 10_000; step++) {
			await t.finishInProgressScheduledFunctions();
			const now = Date.now();
			const due = await t.run(async (ctx) =>
				(await ctx.db.system.query("_scheduled_functions").collect()).some(
					(job) => job.state.kind === "pending" && job.scheduledTime <= now,
				),
			);
			if (!due) return;
			vi.advanceTimersToNextTimer();
		}
		throw new Error("Scheduled functions did not settle");
	};
	await settle();

	const hides = async () =>
		await t.run((ctx) =>
			ctx.db
				.query("files_pending_hides")
				.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", nodeId))
				.collect(),
		);
	const costs: Array<{ owners: number; cost: ReturnType<typeof transaction_cost> }> = [];
	const overlayCosts: Array<ReturnType<typeof transaction_cost>> = [];
	let ownerCount = 0;
	let measuring = false;
	test_spy_handler(advance_transfer, async (handler, ctx, args) => {
		const oldNode = (await ctx.db.get("files_nodes", nodeId))!;
		const before = await ctx.meta.getTransactionMetrics();
		// The registered handler includes the mutation wrapper's full overlay flush.
		const result = await handler(ctx, args);
		const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
		const node = (await ctx.db.get("files_nodes", nodeId))!;
		if (measuring && oldNode.parentId !== node.parentId) {
			const refreshed = await ctx.db
				.query("files_pending_hides")
				.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", nodeId))
				.collect();
			expect(refreshed, "the writing transaction still holds every owner's claim hide").toHaveLength(ownerCount);
			expect(
				refreshed.every((hide) => hide.parentId === otherId && hide.treePath === "/other/shared/"),
				"the full Move flush updates every hide before its background claim cleanup",
			).toBe(true);
			costs.push({ owners: ownerCount, cost });
		}
		return result;
	});
	test_spy_handler(run_overlay_job, async (handler, ctx, args) => {
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		overlayCosts.push(transaction_cost(before, await ctx.meta.getTransactionMetrics()));
		return result;
	});

	const move = async (targetParentId: Id<"files_nodes">) => {
		vi.setSystemTime(Date.now() + 3_000);
		const started = await asOwner.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [nodeId],
			targetParentId,
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId } = started._yay;
		expect(await asOwner.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		for (let step = 0; step < 50; step++) {
			await settle();
			const receipt = await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId });
			if (receipt?.activity.status === "succeeded") return;
			expect(receipt?.activity.status).not.toBe("failed");
			expect(receipt?.activity.status).not.toBe("awaiting_input");
			vi.setSystemTime(Date.now() + 1_000);
			vi.advanceTimersByTime(1_000);
		}
		throw new Error("Move did not finish");
	};

	for (const total of [40, 80]) {
		for (; ownerCount < total; ownerCount++) {
			const home = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
			);
			vi.setSystemTime(Date.now() + 10_000);
			expect(
				await asOwner.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userIdToAdd: home.userId,
				}),
			).toEqual({ _yay: null });
			const membership = await t.run((ctx) =>
				ctx.db
					.query("organizations_workspaces_users")
					.withIndex("by_workspace_user_active", (q) =>
						q.eq("workspaceId", db.workspaceId).eq("userId", home.userId).eq("active", true),
					)
					.first(),
			);
			if (!membership) throw new Error("Expected invited member");
			const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: home.userId });
			const thread = await asMember.mutation(api.ai_chat.thread_create, {
				membershipId: membership._id,
				clientGeneratedId: `claim-${ownerCount}`,
				lastMessageAt: Date.now(),
			});
			if (thread._nay) throw new Error(thread._nay.message);
			const captured = await t.mutation(internal.ai_chat_workspaces.capture, {
				membershipId: membership._id,
				userId: home.userId,
			});
			if (captured._nay) throw new Error(captured._nay.message);
			await t.action(async (ctx) => {
				const agentSource = {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: home.userId,
					threadId: thread._yay.threadId,
					membershipId: membership._id,
					membershipLifetime: captured._yay.membershipLifetime,
				};
				const fs = new bash_DbFilesFs({
					ctx,
					currentWorkspacePath: "/home/cloud-usr/w/test-organization/test-workspace",
					allowDbFilesMkdir: true,
					ctxData: {
						...agentSource,
						organizationName: "test-organization",
						workspaceName: "test-workspace",
						agentSource,
					},
				});
				await fs.mkdir("/dest/shared");
			});
		}
		await settle();
		expect(await hides(), "the saved destination name is absent before it is claimed").toHaveLength(0);
		await move(destinationId);
		const claimed = await hides();
		expect(claimed, "real overlay jobs create a hide for every private name owner").toHaveLength(total);
		expect(new Set(claimed.map((hide) => hide.userId)).size).toBe(total);
		expect(claimed.every((hide) => hide.parentId === destinationId)).toBe(true);
		measuring = true;
		await move(otherId);
		measuring = false;
		expect(await hides(), "the claim ends after the saved node moves away").toHaveLength(0);
	}

	expect(costs.map((entry) => entry.owners)).toEqual([40, 80]);
	const small = costs[0]!.cost;
	const large = costs[1]!.cost;
	expect(large.documentsRead - small.documentsRead, "one-root reads grow with owner hide copies").toBeGreaterThanOrEqual(40);
	expect(large.documentsWritten - small.documentsWritten, "one-root writes grow with owner hide copies").toBeGreaterThanOrEqual(40);
	expect(overlayCosts.length, "the real saved-node overlay jobs ran").toBeGreaterThan(0);
	const overlayPeak = { ...overlayCosts[0]! };
	for (const cost of overlayCosts)
		for (const key of Object.keys(cost) as Array<keyof typeof cost>) overlayPeak[key] = Math.max(overlayPeak[key], cost[key]);
	console.info("crowded saved Move costs", JSON.stringify({ moves: costs, overlayCalls: overlayCosts.length, overlayPeak }));
}, 120_000);
