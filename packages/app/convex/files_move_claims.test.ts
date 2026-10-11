import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { run_job as run_overlay_job } from "./files_pending_overlay.ts";
import { test_convex, test_finish_transfer_run, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";
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

test("saved Moves refresh more than 32 native private name claims in pages", async () => {
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
	// A one-item Move with no owner work takes about 80 steps. Stop well before a long drain: the
	// drain never yields to the event loop, so the test timeout fires only minutes after it is due.
	const settle = async () => {
		let due: string[] = [];
		for (let step = 0; step < 250; step++) {
			await t.finishInProgressScheduledFunctions();
			const now = Date.now();
			due = await t.run(async (ctx) =>
				(await ctx.db.system.query("_scheduled_functions").collect())
					.filter((job) => job.state.kind === "pending" && job.scheduledTime <= now)
					.map((job) => job.name),
			);
			if (due.length === 0) return;
			vi.advanceTimersToNextTimer();
		}
		throw new Error(`Scheduled functions did not settle in 250 steps, still due: ${due.join(", ")}`);
	};
	await settle();

	const hides = async () =>
		await t.run((ctx) =>
			ctx.db
				.query("files_pending_hides")
				.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", nodeId))
				.collect(),
		);
	const costs: Array<{
		owners: number;
		phase: string;
		ownersAdded: number;
		cost: ReturnType<typeof transaction_cost>;
	}> = [];
	const publications: number[] = [];
	const overlayCosts: Array<ReturnType<typeof transaction_cost>> = [];
	let ownerCount = 0;
	let measuring = false;
	test_spy_handler(advance_cohort, async (handler, ctx, args) => {
		const { cohortId, step } = args as { cohortId: Id<"files_move_cohorts">; step: number };
		const cohort = await ctx.db.get("files_move_cohorts", cohortId);
		const collecting = measuring && cohort?.step === step && cohort.workPhase === "owners_collect";
		// This fixture has at most two owner targets for each of its 33 users.
		const ownersBefore = collecting
			? (await ctx.db
				.query("files_move_owner_work")
				.withIndex("by_cohort_owner_target", (q) => q.eq("cohortId", cohortId))
				.collect()).length
			: 0;
		const before = await ctx.meta.getTransactionMetrics();
		// The registered handler includes the mutation wrapper's full overlay flush.
		const result = await handler(ctx, args);
		const cost = transaction_cost(before, await ctx.meta.getTransactionMetrics());
		if (measuring && cohort?.step === step) {
			const ownersAdded = collecting
				? (await ctx.db
					.query("files_move_owner_work")
					.withIndex("by_cohort_owner_target", (q) => q.eq("cohortId", cohortId))
					.collect()).length - ownersBefore
				: 0;
			costs.push({ owners: ownerCount, phase: cohort.workPhase, ownersAdded, cost });
		}
		if (measuring && cohort?.step === step && cohort.workPhase === "publish") {
			expect(
				(await ctx.db.get("files_move_cohorts", cohortId))?.publishedAt,
				"the Move publishes its owner views",
			).not.toBeNull();
			const refreshed = await ctx.db
				.query("files_pending_hides")
				.withIndex("by_savedNode_user", (q) => q.eq("savedNodeId", nodeId))
				.collect();
			expect(refreshed, "publication keeps every old owner hide until physical cleanup").toHaveLength(ownerCount);
			expect(
				refreshed.every(
					(hide) =>
						hide.parentId === destinationId &&
						hide.treePath === "/dest/shared/" &&
						hide.moveView?.cohortId === cohortId &&
						hide.moveView.view === "before",
				),
				"the after view removes every claim on the name the saved item left",
			).toBe(true);
			publications.push(ownerCount);
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
		// Check outside the worker so this assertion fails the test right away.
		await test_finish_transfer_run(asOwner, runId, async () => {
			const entry = costs.at(-1);
			if (entry?.phase === "owners_collect")
				expect(entry.ownersAdded, "A claim collection step adds at most eight owners").toBeLessThanOrEqual(8);
		});
		expect((await asOwner.query(api.files_transfer.get, { membershipId: db.membershipId, runId }))?.activity.status).toBe(
			"succeeded",
		);
	};

	// 33 owners is one past 32 and needs 5 claim pages of 8. Each owner costs real setup work.
	for (const total of [33]) {
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
		// Check this round before starting the next crowded Move.
		expect(costs.at(-1)?.owners, "the crowded Move records its owner count").toBe(total);
		expect(await hides(), "the claim ends after the saved node moves away").toHaveLength(0);
	}

	expect(publications, "the crowded Move publishes every owner view").toEqual([33]);
	const movePeaks = [];
	for (const owners of [33]) {
		const steps = costs.filter((entry) => entry.owners === owners);
		const collectionSteps = steps.filter((entry) => entry.phase === "owners_collect");
		// Hide owners are known before each slot doc adds its one new private target.
		for (const entry of collectionSteps)
			expect(entry.ownersAdded, "A claim collection step adds at most eight owners").toBeLessThanOrEqual(8);
		expect(
			collectionSteps.filter((entry) => entry.ownersAdded > 0).length,
			`${owners} claim owners need several hide pages`,
		).toBeGreaterThanOrEqual(Math.ceil(owners / 8));
		expect(collectionSteps.reduce((total, entry) => total + entry.ownersAdded, 0), "Every claim owner is collected")
			.toBeGreaterThanOrEqual(owners);
		for (const phase of ["owners_stage", "finish_owners"])
			expect(
				steps.filter((entry) => entry.phase === phase).length,
				`${owners} owners use several ${phase} steps`,
			).toBeGreaterThan(1);
		const peak = { ...steps[0]!.cost };
		for (const { cost } of steps)
			for (const key of Object.keys(cost) as Array<keyof typeof cost>) peak[key] = Math.max(peak[key], cost[key]);
		expect(peak.databaseQueries, "Move range budget").toBeLessThan(4096 * 0.75);
		expect(peak.documentsRead, "Move read budget").toBeLessThan(32_000 * 0.75);
		expect(peak.documentsWritten, "Move write budget").toBeLessThan(16_000 * 0.75);
		expect(peak.bytesRead, "Move byte read budget").toBeLessThan(16 * 1024 * 1024 * 0.75);
		expect(peak.bytesWritten, "Move byte write budget").toBeLessThan(16 * 1024 * 1024 * 0.75);
		expect(peak.functionsScheduled, "Move schedule budget").toBeLessThan(1000 * 0.75);
		movePeaks.push({ owners, steps: steps.length, peak });
	}
	expect(overlayCosts.length, "the real pending overlay jobs ran").toBeGreaterThan(0);
	const overlayPeak = { ...overlayCosts[0]! };
	for (const cost of overlayCosts)
		for (const key of Object.keys(cost) as Array<keyof typeof cost>) overlayPeak[key] = Math.max(overlayPeak[key], cost[key]);
	console.info("crowded saved Move costs", JSON.stringify({ moves: movePeaks, overlayCalls: overlayCosts.length, overlayPeak }));
}, 120_000);
