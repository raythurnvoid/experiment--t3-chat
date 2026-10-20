import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import * as move_pages from "./files_move_pages.ts";
import { accept_input, advance as advance_transfer } from "./files_transfer.ts";
import { create_folder_fixture } from "./files_transfer.setup.test.ts";
import { test_convex, test_finish_transfer_run, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";
import { budget_recorder, transaction_cost } from "./files_pending_overlay_limits.setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function track_pages<T extends object>(query: T, pages: { count: number }): T {
	return new Proxy(query, {
		get(target, key) {
			const member: unknown = Reflect.get(target, key);
			if (typeof member !== "function") return member;
			return (...args: unknown[]) => {
				if (key === "paginate") pages.count++;
				const result: unknown = Reflect.apply(member, target, args);
				return ["withIndex", "order", "filter", "fullTableScan"].includes(String(key)) &&
					result &&
					typeof result === "object"
					? track_pages(result, pages)
					: result;
			};
		},
	});
}

function observe_move_phases() {
	const phases = new Map<string, Pick<Doc<"files_move_cohorts">, "_id" | "origin" | "step" | "workPhase">>();
	// Inline acceptance and Transfer admission can run before the scheduled cohort handler.
	for (const registered of [accept_input, advance_transfer, advance_cohort])
		test_spy_handler(registered, async (handler, ctx, args) => {
			const trackedDb = new Proxy(ctx.db, {
				get(target, key) {
					const member: unknown = Reflect.get(target, key);
					if (typeof member !== "function") return member;
					if (key !== "get") return member.bind(target);
					return async (...getArgs: unknown[]) => {
						const result: unknown = await Reflect.apply(member, target, getArgs);
						if (getArgs[0] !== "files_move_cohorts") return result;
						const cohort = result as Doc<"files_move_cohorts"> | null;
						if (cohort?.origin.kind === "transfer") {
							const { _id, origin, step, workPhase } = cohort;
							phases.set(`${_id}:${step}:${workPhase}`, { _id, origin, step, workPhase });
						}
						return result;
					};
				},
			});
			return await handler({ ...ctx, db: trackedDb }, args);
		});
	return phases;
}

function expect_move_phases(phases: ReturnType<typeof observe_move_phases>, runId: Id<"files_transfer_runs">) {
	const records = [...phases.values()].filter((cohort) => cohort.origin.kind === "transfer" && cohort.origin.runId === runId);
	expect(new Set(records.map((cohort) => cohort._id)).size, "phase reads belong to one exact Move cohort").toBe(1);
	const observed = records.map((cohort) => cohort.workPhase);
	expect(observed, "the real Move reaches closure, sides and publication").toEqual(
		expect.arrayContaining(["owners_closure", "sides", "publish"]),
	);
	expect(
		observed.filter((phase) => phase === "content" || phase === "media"),
		"A saved Move stages its item without entering content or media.",
	).toEqual([]);
}

describe("initial Move publication", () => {
	test.each([
		{ sourcePath: "/one/source", targetPath: "/target" },
		{ sourcePath: "/one/two/source", targetPath: "/target/deep" },
	])("publishes an empty folder at $sourcePath before acceptance returns", async ({ sourcePath, targetPath }) => {
		const { t, db, asUser, folders } = await create_folder_fixture([sourcePath, targetPath]);
		const sourceId = folders.get(sourcePath)!;
		const targetId = folders.get(targetPath)!;
		const physicalBefore = (await t.run((ctx) => ctx.db.get("files_nodes", sourceId)))!;
		const pages = { count: 0 };
		let actorReads = 0;
		let readerMembershipReads = 0;
		const costs: Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>[] = [];
		let cohortCalls = 0;
		let parentCalls = 0;
		// Count the real child page calls as well as the parent's native pages.
		for (const registered of Object.values(move_pages)) {
			if (typeof registered !== "function") continue;
			test_spy_handler(registered, async (handler, ctx, args) => {
				const result = await handler(ctx, args);
				pages.count++;
				return result;
			});
		}
		test_spy_handler(advance_cohort, async (handler, ctx, args) => {
			cohortCalls++;
			return await handler(ctx, args);
		});
		test_spy_handler(advance_transfer, async (handler, ctx, args) => {
			parentCalls++;
			return await handler(ctx, args);
		});
		test_spy_handler(accept_input, async (handler, ctx, args) => {
			const trackedDb = new Proxy(ctx.db, {
				get(target, key) {
					const member: unknown = Reflect.get(target, key);
					if (typeof member !== "function") return member;
					if (key === "query")
						return (...queryArgs: unknown[]) => {
							if (queryArgs[0] === "organizations_workspaces_users") readerMembershipReads++;
							return track_pages(Reflect.apply(member, target, queryArgs), pages);
						};
					if (key === "get")
						return (...getArgs: unknown[]) => {
							if (getArgs[0] === "users" && getArgs[1] === db.userId) actorReads++;
							return Reflect.apply(member, target, getArgs);
						};
					return member.bind(target);
				},
			});
			const result = await handler({ ...ctx, db: trackedDb }, args);
			// The registered wrapper has finished its final overlay flush.
			costs.push(await ctx.meta.getTransactionMetrics());
			return result;
		});
		const args = {
			membershipId: db.membershipId,
			requestId: "inline-empty-folder",
			kind: "move" as const,
			expectedSourceCount: 1,
			sourceIds: [sourceId],
			targetParentId: targetId,
		};
		const accepted = await asUser.mutation(api.files_transfer.accept_input, args);
		if (accepted._nay) throw new Error(accepted._nay.message);
		const { runId, activityId } = accepted._yay;
		const cohort = await t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
				.unique(),
		);
		console.info(
			"inline empty Move acceptance",
			JSON.stringify({ sourcePath, step: cohort?.step, phase: cohort?.workPhase, actorReads, readerMembershipReads, costs }),
		);
		expect(cohort, "an empty folder is published before acceptance returns").toMatchObject({
			phase: "published",
			visibleView: "after",
			workPhase: "finish_content",
			publishedAt: expect.any(Number),
		});
		if (!cohort?.runJob) throw new Error("Expected the current repair owner");
		expect(cohort.step).toBeGreaterThan(0);
		expect(cohort.runJob).toMatchObject({ step: cohort.step, generation: 1 });
		expect(await t.run((ctx) => ctx.db.system.get(cohort.runJob!.id))).toMatchObject({
			name: "files_move_run:run",
			args: [{ cohortId: cohort._id, step: cohort.step, runGeneration: 1, mode: "chain" }],
			state: { kind: "pending" },
		});
		expect(
			{ parentCalls, cohortCalls, nativePages: pages.count },
			"publication uses only the acceptance transaction",
		).toEqual({
			parentCalls: 0,
			cohortCalls: 0,
			nativePages: 0,
		});
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			progress: { total: 1, completed: 1, failed: 0, canceled: 0 },
		});
		const view = await asUser.query(api.files_tree.get_workspace_move_view, { membershipId: db.membershipId });
		expect(view).toMatchObject({ cohortId: cohort._id, view: "after", generation: cohort.slotGeneration });
		const selected = await asUser.query(api.files_tree.list_tree_children, {
			membershipId: db.membershipId,
			parentId: targetId,
			kind: "folder",
			archived: false,
			restricted: false,
			stream: "cohort",
			paginationOpts: { cursor: null, numItems: 100 },
		});
		expect(selected.page).toEqual([
			expect.objectContaining({ _id: sourceId, parentId: targetId, name: "source", path: `${targetPath}/source` }),
		]);
		expect(
			await t.run((ctx) => ctx.db.get("files_nodes", sourceId)),
			"repair has not run before the acceptance assertions",
		).toMatchObject({
			_id: sourceId,
			parentId: physicalBefore.parentId,
			path: sourcePath,
			name: "source",
			moveCohortId: cohort._id,
		});
		expect(costs).toHaveLength(1);
		expect(readerMembershipReads, "saved Move name checks reuse transaction membership reads").toBe(6);
		expect(actorReads, "joined Move removes repeated actor fact reads").toBeLessThan(40);
		expect(Object.keys(costs[0]!)).toHaveLength(7);
		for (const [key, metric] of Object.entries(costs[0]!))
			expect(metric.used, `${sourcePath}: ${key} includes publication and final flush; leaves 25% free`).toBeLessThan(
				(metric.used + metric.remaining) * 0.75,
			);
		const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(scheduled.filter((job) => job.name === "files_move_run:run")).toHaveLength(1);
		expect(scheduled.some((job) => job.name === "files_transfer:advance")).toBe(false);
		expect(await asUser.mutation(api.files_transfer.accept_input, args)).toEqual(accepted);
		expect(
			await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
			"replay adds no repair owner",
		).toEqual(scheduled);
		expect((await t.run((ctx) => ctx.db.get("files_move_cohorts", cohort._id)))?.runJob).toEqual(cohort.runJob);
		await test_finish_transfer_run(asUser, runId);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject({
			_id: sourceId,
			parentId: targetId,
			path: `${targetPath}/source`,
			name: "source",
		});
		expect((await t.run((ctx) => ctx.db.get("files_nodes", sourceId)))?.moveCohortId).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			status: "succeeded",
			progress: { completed: 1, failed: 0, canceled: 0 },
		});
	});

	test("stages an Empty Move to Root and back without content preparation", async () => {
		const { t, db, asUser, folders } = await create_folder_fixture(["/target/new-folder"]);
		const sourceId = folders.get("/target/new-folder")!;
		const aId = folders.get("/target")!;
		const phases = observe_move_phases();
		const costs: Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>[] = [];
		test_spy_handler(accept_input, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			// The real wrapper has finished its final flush.
			costs.push(await ctx.meta.getTransactionMetrics());
			return result;
		});
		// Old final-flush counts use this same fixture and both directions.
		const targets = [
			{ direction: "to-root", parentId: "root" as const, path: "/new-folder", queries: 417, writes: 102 },
			{ direction: "to-a", parentId: aId, path: "/target/new-folder", queries: 537, writes: 121 },
		];
		const runs: Id<"files_transfer_runs">[] = [];
		for (const target of targets) {
			const before = (await t.run((ctx) => ctx.db.get("files_nodes", sourceId)))!;
			const accepted = await asUser.mutation(api.files_transfer.accept_input, {
				membershipId: db.membershipId,
				requestId: "local-db-attribution-" + target.direction,
				kind: "move",
				expectedSourceCount: 1,
				sourceIds: [sourceId],
				targetParentId: target.parentId,
			});
			if (accepted._nay) throw new Error(accepted._nay.message);
			const { runId, activityId } = accepted._yay;
			runs.push(runId);
			const cost = costs.at(-1)!;
			console.info("unchanged-content Empty Move acceptance", JSON.stringify({ direction: target.direction, cost }));
			const cohort = await t.run((ctx) => ctx.db.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId)).unique());
			expect(cohort, "the public acceptance publishes before repair").toMatchObject({
				phase: "published", visibleView: "after", workPhase: "finish_content", publishedAt: expect.any(Number),
			});
			if (!cohort?.runJob) throw new Error("Expected the current repair owner");
			expect(await t.run((ctx) => ctx.db.get("files_nodes", sourceId)), "physical repair has not run").toMatchObject({
				parentId: before.parentId, path: before.path, moveCohortId: cohort._id,
			});
			const selected = await asUser.query(api.files_tree.list_tree_children, {
				membershipId: db.membershipId,
				parentId: target.parentId,
				kind: "folder",
				archived: false,
				restricted: false,
				stream: "cohort",
				paginationOpts: { cursor: null, numItems: 100 },
			});
			expect(selected.page.filter((node) => node._id === sourceId)).toEqual([
				expect.objectContaining({ _id: sourceId, parentId: target.parentId, name: "new-folder", path: target.path }),
			]);
			expect(new Set(selected.page.map((node) => node._id)).size).toBe(selected.page.length);
			expect(Object.keys(cost)).toHaveLength(7);
			for (const [key, metric] of Object.entries(cost))
				expect(metric.used, `${target.direction}: ${key}; leaves 25% free`)
					.toBeLessThan((metric.used + metric.remaining) * 0.75);
			await test_finish_transfer_run(asUser, runId);
			expect(await t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject({
				_id: sourceId, parentId: target.parentId, path: target.path, name: "new-folder",
			});
			expect((await t.run((ctx) => ctx.db.get("files_nodes", sourceId)))?.moveCohortId).toBeUndefined();
			expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
				status: "succeeded", progress: { completed: 1, failed: 0, canceled: 0 },
			});
		}
		expect(costs).toHaveLength(2);
		// Keep both direction metrics before the named workload assertion.
		for (const runId of runs) expect_move_phases(phases, runId);
		for (const [index, target] of targets.entries()) {
			expect(costs[index]!.databaseQueries.used, `${target.direction}: fewer acceptance queries`).toBeLessThan(target.queries);
			expect(costs[index]!.documentsWritten.used, `${target.direction}: no extra acceptance writes`).toBeLessThanOrEqual(target.writes);
		}
	});

	test("joins native child pages within the initial Move transaction", async () => {
		const paths = ["/source", "/source/one", "/source/one/leaf"];
		const { t, db, asUser, folders } = await create_folder_fixture(paths);
		let accepting = false;
		let pages = 0;
		test_spy_handler(move_pages.descendants, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			if (accepting) pages++;
			return result;
		});
		test_spy_handler(accept_input, async (handler, ctx, args) => {
			accepting = true;
			try {
				return await handler(ctx, args);
			} finally {
				accepting = false;
			}
		});
		const accepted = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "joined-native-pages",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		});
		if (accepted._nay) throw new Error(accepted._nay.message);
		expect(pages, "Two native page units share one Move transaction").toBeGreaterThanOrEqual(2);
		await test_finish_transfer_run(asUser, accepted._yay.runId);
		for (const path of paths) {
			const node = await t.run((ctx) => ctx.db.get("files_nodes", folders.get(path)!));
			expect(node).toMatchObject({ _id: folders.get(path), path: `/target${path}` });
			expect(node?.moveCohortId).toBeUndefined();
		}
	});

	test("keeps joined public folder work below every reserved transaction limit", async () => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const source = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path: "/source",
		});
		if (source._nay) throw new Error(source._nay.message);
		const sourceId = source._yay.nodeId;
		const target = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: "root",
			path: "/target",
		});
		if (target._nay) throw new Error(target._nay.message);
		const targetId = target._yay.nodeId;
		const childCount = 16;
		const children: { id: typeof sourceId; name: string }[] = [];
		for (let index = 0; index < childCount; index++) {
			if (index % 10 === 0) vi.setSystemTime(Date.now() + 60_000);
			const name = `child-${index.toString().padStart(2, "0")}`;
			const child = await asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: sourceId,
				path: name,
			});
			if (child._nay) throw new Error(child._nay.message);
			children.push({ id: child._yay.nodeId, name });
		}
		const costs: ReturnType<typeof transaction_cost>[] = [];
		test_spy_handler(accept_input, async (handler, ctx, args) => {
			const before = await ctx.meta.getTransactionMetrics();
			const result = await handler(ctx, args);
			// The registered handler has finished its final overlay flush.
			costs.push(transaction_cost(before, await ctx.meta.getTransactionMetrics()));
			return result;
		});
		const accepted = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "public-folder-reserve",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [sourceId],
			targetParentId: targetId,
		});
		if (accepted._nay) throw new Error(accepted._nay.message);
		expect(costs).toHaveLength(1);
		console.info("public folder Move reserve", JSON.stringify({ childCount, cost: costs[0] }));
		// The reserve-off proof must fail "public folder Move reserve: databaseQueries".
		const { record } = budget_recorder();
		record("public folder Move reserve", costs[0]!);
		await test_finish_transfer_run(asUser, accepted._yay.runId);
		expect(await t.run((ctx) => ctx.db.get("activities", accepted._yay.activityId))).toMatchObject({
			status: "succeeded",
			progress: { completed: 1, failed: 0, canceled: 0 },
		});
		const moved = await t.run((ctx) => ctx.db.get("files_nodes", sourceId));
		expect(moved).toMatchObject({ _id: sourceId, parentId: targetId, path: "/target/source" });
		expect(moved?.moveCohortId).toBeUndefined();
		for (const child of children) {
			const movedChild = await t.run((ctx) => ctx.db.get("files_nodes", child.id));
			expect(movedChild).toMatchObject({
				_id: child.id,
				parentId: sourceId,
				path: `/target/source/${child.name}`,
			});
			expect(movedChild?.moveCohortId).toBeUndefined();
		}
	});

	test("hands unfinished child pages to the current scheduled owner at its budget", async () => {
		const paths = Array.from({ length: 65 }, (_, index) => `/source/child-${index.toString().padStart(2, "0")}`);
		const { t, db, asUser, folders } = await create_folder_fixture(["/source", ...paths]);
		const sourceId = folders.get("/source")!;
		const targetId = folders.get("/target")!;
		const phases = observe_move_phases();
		const pages = { count: 0 };
		let cohortCalls = 0;
		test_spy_handler(move_pages.descendants, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			pages.count++;
			return result;
		});
		test_spy_handler(advance_cohort, async (handler, ctx, args) => {
			cohortCalls++;
			return await handler(ctx, args);
		});
		test_spy_handler(accept_input, async (handler, ctx, args) => {
			const trackedDb = new Proxy(ctx.db, {
				get(target, key) {
					const member: unknown = Reflect.get(target, key);
					if (typeof member !== "function") return member;
					if (key === "query")
						return (...queryArgs: unknown[]) => track_pages(Reflect.apply(member, target, queryArgs), pages);
					return member.bind(target);
				},
			});
			return await handler({ ...ctx, db: trackedDb }, args);
		});
		const accepted = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "inline-child-page",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [sourceId],
			targetParentId: targetId,
		});
		if (accepted._nay) throw new Error(accepted._nay.message);
		const { runId, activityId } = accepted._yay;
		const cohort = await t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
				.unique(),
		);
		expect(
			{ nativePages: pages.count, cohortCalls },
			"the initial budget leaves the next native page to its scheduled owner",
		).toEqual({
			nativePages: 2,
			cohortCalls: 0,
		});
		expect(cohort).toMatchObject({ publishedAt: null, visibleView: "before", workPhase: "descendants" });
		if (!cohort?.runJob) throw new Error("Expected the current page continuation owner");
		expect(cohort.runJob).toMatchObject({ step: cohort.step, generation: 1 });
		expect(await t.run((ctx) => ctx.db.system.get(cohort.runJob!.id))).toMatchObject({
			name: "files_move_run:run",
			args: [{ cohortId: cohort._id, step: cohort.step, runGeneration: 1, mode: "chain" }],
			state: { kind: "pending" },
		});
		const children = await t.run((ctx) =>
			Promise.all(paths.map((path) => ctx.db.get("files_nodes", folders.get(path)!))),
		);
		expect(
			children.slice(0, 64).map((child) => child?.moveCohortId),
			"every child returned by both native pages is held",
		).toEqual(Array.from({ length: 64 }, () => cohort._id));
		expect(children[64]?.moveCohortId, "the cursor leaves the exact tail for its owner").toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({ progress: { completed: 0 } });
		await test_finish_transfer_run(asUser, runId);
		for (const path of ["/source", ...paths]) {
			const node = await t.run((ctx) => ctx.db.get("files_nodes", folders.get(path)!));
			expect(node).toMatchObject({ _id: folders.get(path), path: `/target${path}` });
			expect(node?.moveCohortId).toBeUndefined();
		}
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			status: "succeeded",
			progress: { total: 1, completed: 1, failed: 0, canceled: 0 },
		});
		expect_move_phases(phases, runId);
	});

	test("a public role change after the initial budget handoff prevents publication", async () => {
		const paths = Array.from({ length: 33 }, (_, index) => `/source/child-${index.toString().padStart(2, "0")}`);
		const { t, db, asUser, folders } = await create_folder_fixture(["/source", ...paths]);
		const userId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "initial-move-member" }));
		expect(
			await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userIdToAdd: userId,
			}),
		).toEqual({ _yay: null });
		const membership = await t.run((ctx) =>
			ctx.db
				.query("organizations_workspaces_users")
				.withIndex("by_workspace_user_active", (q) =>
					q.eq("workspaceId", db.workspaceId).eq("userId", userId).eq("active", true),
				)
				.unique(),
		);
		if (!membership) throw new Error("Expected the invited member");
		const asMember = t.withIdentity({ issuer: "https://clerk.test", external_id: userId });
		const organization = await t.run((ctx) => ctx.db.get("organizations", db.organizationId));
		if (!organization?.defaultWorkspaceId) throw new Error("Expected the default workspace");
		expect(
			await asMember.query(api.access_control.get_current_user_workspace_permission, {
				membershipId: membership._id,
				permission: "content.write",
			}),
		).toBe(true);
		const sourceId = folders.get("/source")!;
		const childId = folders.get(paths[0]!)!;
		const accepted = await asMember.mutation(api.files_transfer.accept_input, {
			membershipId: membership._id,
			requestId: "initial-page-role-change",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [sourceId],
			targetParentId: folders.get("/target")!,
		});
		if (accepted._nay) throw new Error(accepted._nay.message);
		const { runId, activityId } = accepted._yay;
		const cohort = await t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
				.unique(),
		);
		expect(cohort, "the initial budget yields before publication").toMatchObject({
			publishedAt: null,
			workPhase: "descendants",
			visibleView: "before",
		});
		if (!cohort) throw new Error("Expected the staged cohort");
		expect((await t.run((ctx) => ctx.db.get("files_nodes", childId)))?.moveCohortId).toBe(cohort._id);
		// Invites give the organization role. Lower it in the default workspace.
		expect(
			await asUser.mutation(api.access_control.set_user_role, {
				organizationId: db.organizationId,
				workspaceId: organization.defaultWorkspaceId,
				userId,
				role: "viewer",
			}),
		).toEqual({ _yay: null });
		expect(
			await asMember.query(api.access_control.get_current_user_workspace_permission, {
				membershipId: membership._id,
				permission: "content.write",
			}),
			"the public role change takes away current write access",
		).toBe(false);
		await test_finish_transfer_run(asMember, runId);
		expect(
			await t.run((ctx) => ctx.db.get("files_move_cohorts", cohort._id)),
			"current access is checked after the page handoff",
		).toMatchObject({
			phase: "complete",
			publishedAt: null,
			visibleView: "before",
		});
		for (const path of ["/source", ...paths]) {
			const node = await t.run((ctx) => ctx.db.get("files_nodes", folders.get(path)!));
			expect(node).toMatchObject({ _id: folders.get(path), path });
			expect(node?.moveCohortId).toBeUndefined();
		}
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({ progress: { completed: 0 } });
	});

	test("recovers the exact published request after its acceptance reply is lost", async () => {
		const { t, db, asUser, folders } = await create_folder_fixture(["/source"]);
		const sourceId = folders.get("/source")!;
		const args = {
			membershipId: db.membershipId,
			requestId: "lost-inline-publication",
			kind: "move" as const,
			expectedSourceCount: 1,
			sourceIds: [sourceId],
			targetParentId: folders.get("/target")!,
		};
		const loseReply = async () => {
			const accepted = await asUser.mutation(api.files_transfer.accept_input, args);
			if (accepted._nay) throw new Error(accepted._nay.message);
			// Acceptance committed. Only its reply is lost.
			throw new Error("reply lost after commit");
		};
		await expect(loseReply()).rejects.toThrow("reply lost after commit");
		const found = await asUser.query(api.files_transfer_queries.get_move_acceptance, {
			membershipId: db.membershipId,
			requestId: args.requestId,
		});
		if (!found) throw new Error("Expected the exact accepted request");
		const cohort = await t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", found.runId))
				.unique(),
		);
		expect(cohort, "the lost receipt belongs to an already published Move").toMatchObject({
			phase: "published",
			publishedAt: expect.any(Number),
		});
		const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		const replayed = await asUser.mutation(api.files_transfer.accept_input, args);
		if (replayed._nay) throw new Error(replayed._nay.message);
		expect(replayed._yay.runId).toBe(found.runId);
		expect(
			await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
			"lost-reply replay keeps the exact owner",
		).toEqual(scheduled);
		expect(await t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toHaveLength(1);
		await test_finish_transfer_run(asUser, found.runId);
		expect(await asUser.mutation(api.files_transfer.accept_input, args)).toEqual(replayed);
		expect(
			await asUser.query(api.files_transfer_queries.get_move_acceptance, {
				membershipId: db.membershipId,
				requestId: args.requestId,
			}),
		).toMatchObject({ runId: found.runId, isFinished: true });
		expect(await t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject({
			_id: sourceId,
			parentId: args.targetParentId,
			path: "/target/source",
			name: "source",
		});
		expect(
			(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId: found.runId }))?.activity,
		).toMatchObject({
			status: "succeeded",
			progress: { completed: 1, failed: 0, canceled: 0 },
		});
	});

	test("Stop after inline publication keeps the completed group and finishes repair", async () => {
		const { t, db, asUser, folders } = await create_folder_fixture(["/source"]);
		const sourceId = folders.get("/source")!;
		const args = {
			membershipId: db.membershipId,
			requestId: "stop-inline-publication",
			kind: "move" as const,
			expectedSourceCount: 1,
			sourceIds: [sourceId],
			targetParentId: folders.get("/target")!,
		};
		const accepted = await asUser.mutation(api.files_transfer.accept_input, args);
		if (accepted._nay) throw new Error(accepted._nay.message);
		const { runId, activityId } = accepted._yay;
		const cohort = await t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
				.unique(),
		);
		expect(cohort, "Stop starts after the acceptance transaction published").toMatchObject({
			phase: "published",
			visibleView: "after",
			workPhase: "finish_content",
			publishedAt: expect.any(Number),
		});
		if (!cohort) throw new Error("Expected the published cohort");
		expect(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		expect(
			await t.run((ctx) => ctx.db.get("files_move_cohorts", cohort._id)),
			"Stop cannot abort a published group",
		).toMatchObject({
			phase: "published",
			visibleView: "after",
			publishedAt: cohort.publishedAt,
		});
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			status: "stopping",
			progress: { completed: 1, canceled: 0, failed: 0 },
		});
		expect(await asUser.mutation(api.files_transfer.accept_input, args)).toEqual(accepted);
		await test_finish_transfer_run(asUser, runId);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject({
			_id: sourceId,
			parentId: args.targetParentId,
			path: "/target/source",
			name: "source",
		});
		expect((await t.run((ctx) => ctx.db.get("files_nodes", sourceId)))?.moveCohortId).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_move_cohorts", cohort._id))).toMatchObject({
			phase: "complete",
			visibleView: "after",
			publishedAt: cohort.publishedAt,
		});
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			status: "canceled",
			progress: { completed: 1, canceled: 0, failed: 0 },
		});
	});
});
