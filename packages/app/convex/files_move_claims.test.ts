import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { test_convex, test_mocks_fill_db_with, test_move_nodes, test_spy_handler } from "./setup.test.ts";
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

test("saved Moves refresh more than 32 native private name claims in bounded steps", async () => {
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

	const hides = async () =>
		await t.run((ctx) =>
			ctx.db
				.query("files_pending_hides")
				.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", nodeId))
				.collect(),
		);
	// Each Move step is one wrapped transaction. Keep the largest cost of the current Move.
	let peak: ReturnType<typeof transaction_cost> | null = null;
	test_spy_handler(advance_cohort, async (handler, ctx, args) => {
		const before = await ctx.meta.getTransactionMetrics();
		const result = await handler(ctx, args);
		const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
		if (peak)
			for (const key of Object.keys(cost) as Array<keyof typeof cost>) peak[key] = Math.max(peak[key], cost[key]);
		else peak = cost;
		return result;
	});

	// A new workspace member's agent makes a private folder that claims the saved folder's name there.
	let ownerCount = 0;
	const claim = async (path: string) => {
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
			clientGeneratedId: `claim-${ownerCount++}`,
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
			await fs.mkdir(path);
		});
	};
	const move = async (targetParentId: Id<"files_nodes">) => {
		peak = null;
		expect(
			await test_move_nodes(t, asOwner, { membershipId: db.membershipId, itemIds: [nodeId], targetParentId }),
		).toEqual({ _yay: null });
		if (!peak) throw new Error("Expected Move steps");
		return peak as ReturnType<typeof transaction_cost>;
	};

	// 9 claims fill more than one owner page of 8. 33 claims pass the 32 copies one draft write may update.
	for (let index = 0; index < 9; index++) await claim("/dest/shared");
	expect(await hides(), "the saved destination name is absent before it is claimed").toHaveLength(0);
	const small = await move(destinationId);
	const destinationHides = await hides();
	expect(destinationHides, "the Move adds a hide for every private name owner").toHaveLength(9);
	expect(destinationHides.every((hide) => hide.parentId === destinationId && hide.treePath === "/dest/shared/")).toBe(
		true,
	);

	for (let index = 0; index < 33; index++) await claim("/other/shared");
	const large = await move(otherId);
	const otherHides = await hides();
	expect(otherHides, "the claims at the old name end and every new owner gets a hide").toHaveLength(33);
	expect(new Set(otherHides.map((hide) => hide.userId)).size).toBe(33);
	expect(otherHides.every((hide) => hide.parentId === otherId && hide.treePath === "/other/shared/")).toBe(true);

	// Steps page owners, so the heaviest step does not grow with the owner count. The second Move starts
	// from another place, so allow a few reads, but less than one for each of the 33 added owners.
	expect(large.documentsRead, "the heaviest Move step does not read each owner").toBeLessThan(small.documentsRead + 33);
	expect(large.databaseQueries, "the heaviest Move step does not query each owner").toBeLessThan(
		small.databaseQueries + 33,
	);
	console.info("crowded saved Move step peaks", JSON.stringify({ small, large }));
}, 120_000);
