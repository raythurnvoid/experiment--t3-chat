import { makeFunctionReference, type FunctionArgs } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { accept_input, append_input } from "./files_transfer.ts";
import { create_folder_fixture } from "./files_transfer.setup.test.ts";
import { test_finish_transfer_run, test_spy_handler } from "./setup.test.ts";
import { files_metadata_stringify_entries_yaml } from "../shared/files-metadata.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("saved Move input acceptance", () => {
	test.each([undefined, 1])("activates complete first input with expected count %s", async (expectedSourceCount) => {
		const { t, db, asUser, folders } = await create_folder_fixture(["/source"]);
		const sourceId = folders.get("/source")!;
		const args = {
			membershipId: db.membershipId,
			requestId: "complete-first-input",
			kind: "move" as const,
			...(expectedSourceCount === undefined ? {} : { expectedSourceCount }),
			sourceIds: [sourceId],
			targetParentId: folders.get("/target")!,
		};
		const guardReads = { repair: 0, lifetime: 0 };
		test_spy_handler(accept_input, async (handler, ctx, args) => {
			const trackedDb = new Proxy(ctx.db, {
				get(target, key) {
					const member: unknown = Reflect.get(target, key);
					if (typeof member !== "function") return member;
					if (key === "query")
						return (...queryArgs: unknown[]) => {
							if (queryArgs[0] === "files_subtree_ops") guardReads.repair++;
							if (queryArgs[0] === "organizations_membership_lifetimes") guardReads.lifetime++;
							return Reflect.apply(member, target, queryArgs);
						};
					return member.bind(target);
				},
			});
			return await handler({ ...ctx, db: trackedDb }, args);
		});
		const accepted = await asUser.mutation(api.files_transfer.accept_input, args);
		if (accepted._nay) throw new Error(accepted._nay.message);
		// Select, Normalize, Plan and Commit join this one transaction. Seal and these units share one
		// access check and one repair wait. Start and the cohort read the other lifetimes.
		expect(guardReads, "Move acceptance runs each transfer guard once").toEqual({ repair: 4, lifetime: 6 });
		const { runId, activityId } = accepted._yay;
		const run = (await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))!;
		expect(run.step, "complete saved input activates in its acceptance mutation").not.toBe("uploading");
		const cohort = await t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
				.unique(),
		);
		expect(cohort, "acceptance begins the real parent work before its reply").toMatchObject({
			phase: "published",
			workPhase: "finish_content",
			publishedAt: expect.any(Number),
		});
		if (!cohort?.runJob) throw new Error("Expected the owned cohort continuation");
		expect(await t.run((ctx) => ctx.db.system.get(cohort.runJob!.id))).toMatchObject({
			name: "files_move_run:run",
			args: [{ cohortId: cohort._id, step: cohort.step, runGeneration: cohort.runJob.generation, mode: "chain" }],
			state: { kind: "pending" },
		});
		const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(
			scheduled.some((job) => job.name === "files_transfer:advance"),
			"inline work adds no initial parent job",
		).toBe(false);
		expect(await asUser.mutation(api.files_transfer.accept_input, args)).toEqual(accepted);
		expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduled);
		expect((await t.run((ctx) => ctx.db.get("files_move_cohorts", cohort._id)))?.runJob).toEqual(cohort.runJob);
		await test_finish_transfer_run(asUser, runId);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject({
			_id: sourceId,
			parentId: args.targetParentId,
			path: "/target/source",
		});
		expect((await t.run((ctx) => ctx.db.get("files_nodes", sourceId)))?.moveCohortId).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			status: "succeeded",
			progress: { completed: 1, failed: 0, canceled: 0 },
		});
	});

	test("reuses equal scope facts while accepting another source page", async () => {
		const paths = ["/one", "/two", "/three"];
		const { t, db, asUser, folders } = await create_folder_fixture(paths);
		const sourceIds = paths.map((path) => folders.get(path)!);
		const targetId = folders.get("/target")!;
		const accepted = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "equal-scope-reads",
			kind: "move",
			expectedSourceCount: 3,
			sourceIds: [sourceIds[0]!],
			targetParentId: targetId,
		});
		if (accepted._nay) throw new Error(accepted._nay.message);
		const scopeReads = { workspace: 0, membership: 0, lifetime: 0 };
		test_spy_handler(append_input, async (handler, ctx, args) => {
			const trackedDb = new Proxy(ctx.db, {
				get(target, key) {
					const member: unknown = Reflect.get(target, key);
					if (typeof member !== "function") return member;
					if (key === "query")
						return (...queryArgs: unknown[]) => {
							if (queryArgs[0] === "organizations_membership_lifetimes") scopeReads.lifetime++;
							return Reflect.apply(member, target, queryArgs);
						};
					if (key === "get")
						return (...getArgs: unknown[]) => {
							if (getArgs[0] === "organizations_workspaces" && getArgs[1] === db.workspaceId) scopeReads.workspace++;
							if (getArgs[0] === "organizations_workspaces_users" && getArgs[1] === db.membershipId)
								scopeReads.membership++;
							return Reflect.apply(member, target, getArgs);
						};
					return member.bind(target);
				},
			});
			return await handler({ ...ctx, db: trackedDb }, args);
		});
		expect(
			await asUser.mutation(api.files_transfer.append_input, {
				membershipId: db.membershipId,
				runId: accepted._yay.runId,
				offset: 1,
				sourceIds: [sourceIds[1]!],
			}),
		).toEqual({ _yay: null });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", accepted._yay.runId))).toMatchObject({
			step: "uploading",
			selection: { count: 2, expectedCount: 3 },
		});
		const selection = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_selection_items")
				.withIndex("by_run_order", (q) => q.eq("runId", accepted._yay.runId))
				.collect(),
		);
		expect(selection.map((item) => item.source)).toEqual(sourceIds.slice(0, 2).map((id) => ({ kind: "saved", id })));
		// The public ownership check reads the membership once too.
		expect(scopeReads, "equal Move scopes read authority docs once per guard").toEqual({
			workspace: 1,
			membership: 2,
			lifetime: 1,
		});
		expect(
			await asUser.mutation(api.files_transfer.append_input, {
				membershipId: db.membershipId,
				runId: accepted._yay.runId,
				offset: 2,
				sourceIds: [sourceIds[2]!],
			}),
		).toEqual({ _yay: null });
		await test_finish_transfer_run(asUser, accepted._yay.runId);
		for (const [index, id] of sourceIds.entries())
			expect(await t.run((ctx) => ctx.db.get("files_nodes", id))).toMatchObject({
				_id: id,
				parentId: targetId,
				path: `/target${paths[index]}`,
			});
		expect(await t.run((ctx) => ctx.db.get("activities", accepted._yay.activityId))).toMatchObject({
			status: "succeeded",
			progress: { total: 3, completed: 3, failed: 0 },
		});
	});

	test.each(["accept_input", "append_input"] as const)("replays a committed lost %s reply", async (door) => {
		const { t, db, asUser, folders } = await create_folder_fixture(["/source"]);
		const sourceId = folders.get("/source")!;
		const count = door === "accept_input" ? 1 : 101;
		const args = {
			membershipId: db.membershipId,
			requestId: `lost-${door}`,
			kind: "move" as const,
			expectedSourceCount: count,
			sourceIds: Array.from({ length: Math.min(count, 100) }, () => sourceId),
			targetParentId: folders.get("/target")!,
		};
		let firstRunId: Id<"files_transfer_runs"> | undefined;
		if (door === "append_input") {
			const first = await asUser.mutation(api.files_transfer.accept_input, args);
			if (first._nay) throw new Error(first._nay.message);
			firstRunId = first._yay.runId;
			expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", firstRunId!)))?.step).toBe("uploading");
		}
		const loseReply = async () => {
			const accepted =
				door === "accept_input"
					? await asUser.mutation(api.files_transfer.accept_input, args)
					: await asUser.mutation(api.files_transfer.append_input, {
							membershipId: db.membershipId,
							runId: firstRunId!,
							offset: 100,
							sourceIds: [sourceId],
						});
			if (accepted._nay) throw new Error(accepted._nay.message);
			// The real mutation committed. Only delivery to the caller fails.
			throw new Error("reply lost after commit");
		};
		await expect(loseReply()).rejects.toThrow("reply lost after commit");
		const found = await asUser.query(api.files_transfer_queries.get_move_acceptance, {
			membershipId: db.membershipId,
			requestId: args.requestId,
		});
		if (!found) throw new Error("Expected the exact accepted request");
		expect(found.step, "the committed complete manifest already activated").not.toBe("uploading");
		const positions = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_selection_items")
				.withIndex("by_run_order", (q) => q.eq("runId", found.runId))
				.collect(),
		);
		expect(positions.map((item) => ({ order: item.order, source: item.source }))).toEqual(
			Array.from({ length: count }, (_, order) => ({ order, source: { kind: "saved", id: sourceId } })),
		);
		const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		const replayed = await asUser.mutation(api.files_transfer.accept_input, args);
		if (replayed._nay) throw new Error(replayed._nay.message);
		expect(replayed._yay.runId).toBe(found.runId);
		if (door === "append_input")
			expect(
				await asUser.mutation(api.files_transfer.append_input, {
					membershipId: db.membershipId,
					runId: found.runId,
					offset: 100,
					sourceIds: [sourceId],
				}),
			).toEqual({ _yay: null });
		expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduled);
		await test_finish_transfer_run(asUser, found.runId);
		expect(await asUser.mutation(api.files_transfer.accept_input, args)).toEqual(replayed);
		expect(await t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject({
			_id: sourceId,
			parentId: args.targetParentId,
			path: "/target/source",
		});
		expect((await t.run((ctx) => ctx.db.get("files_nodes", sourceId)))?.moveCohortId).toBeUndefined();
		expect(
			(await asUser.query(api.files_transfer_queries.get, { membershipId: db.membershipId, runId: found.runId }))?.activity,
		).toMatchObject({
			status: "succeeded",
			progress: { completed: 1, failed: 0, canceled: 0 },
		});
	});

	test("Stop before final input keeps accepted positions and exact replays never restart it", async () => {
		const { t, db, asUser, folders } = await create_folder_fixture(["/source"]);
		const sourceId = folders.get("/source")!;
		const args = {
			membershipId: db.membershipId,
			requestId: "stop-input",
			kind: "move" as const,
			expectedSourceCount: 2,
			sourceIds: [sourceId],
			targetParentId: folders.get("/target")!,
		};
		const accepted = await asUser.mutation(api.files_transfer.accept_input, args);
		if (accepted._nay) throw new Error(accepted._nay.message);
		const { runId, activityId } = accepted._yay;
		expect(await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		expect(
			await asUser.mutation(api.files_transfer.append_input, {
				membershipId: db.membershipId,
				runId,
				offset: 1,
				sourceIds: [sourceId],
			}),
		).toHaveProperty("_nay");
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.selection).toMatchObject({
			expectedCount: 2,
			count: 1,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers, 5_000);
		const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
		expect(await asUser.mutation(api.files_transfer.accept_input, args)).toEqual(accepted);
		expect(
			await asUser.mutation(api.files_transfer.append_input, {
				membershipId: db.membershipId,
				runId,
				offset: 0,
				sourceIds: [sourceId],
			}),
		).toEqual({ _yay: null });
		expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(scheduled);
		expect(await t.run((ctx) => ctx.db.get("activities", activityId))).toMatchObject({
			status: "canceled",
			progress: { completed: 0 },
		});
		expect(await t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject({
			parentId: "root",
			path: "/source",
		});
	});

	test("removed public input doors reject before accepting or disclosing a request", async () => {
		const { t, db, asUser, folders } = await create_folder_fixture(["/source"]);
		const args = {
			membershipId: db.membershipId,
			requestId: "old-door",
			kind: "move" as const,
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		};
		await expect(
			asUser.mutation(
				makeFunctionReference<"mutation", FunctionArgs<typeof api.files_transfer.accept_input>>("files_transfer:start"),
				args,
			),
			"old Start rejects before accepting input",
		).rejects.toThrow("as `start`, but there is no such export");
		expect(await t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toEqual([]);
		const accepted = await asUser.mutation(api.files_transfer.accept_input, { ...args, expectedSourceCount: 2 });
		if (accepted._nay) throw new Error(accepted._nay.message);
		await expect(
			asUser.mutation(
				makeFunctionReference<"mutation", FunctionArgs<typeof api.files_transfer.append_input>>(
					"files_transfer:append_sources",
				),
				{ membershipId: db.membershipId, runId: accepted._yay.runId, offset: 1, sourceIds: args.sourceIds },
			),
			"old append rejects before completing input",
		).rejects.toThrow("as `append_sources`, but there is no such export");
		await expect(
			asUser.query(
				makeFunctionReference<"query", FunctionArgs<typeof api.files_transfer_queries.get_move_acceptance>>(
					"files_transfer:get_move_intake",
				),
				{ membershipId: db.membershipId, requestId: args.requestId },
			),
			"old recovery rejects before local retirement",
		).rejects.toThrow("as `get_move_intake`, but there is no such export");
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", accepted._yay.runId)))!.selection!.count).toBe(1);
	});

	test("complete Copy input still waits for explicit Seal", async () => {
		const { t, db, asUser, folders } = await create_folder_fixture(["/source"]);
		const accepted = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "copy-input",
			kind: "copy",
			expectedSourceCount: 2,
			sourceIds: [folders.get("/source")!],
			targetParentId: folders.get("/target")!,
		});
		if (accepted._nay) throw new Error(accepted._nay.message);
		const { runId } = accepted._yay;
		expect(
			await asUser.mutation(api.files_transfer.append_input, {
				membershipId: db.membershipId,
				runId,
				offset: 1,
				sourceIds: [folders.get("/source")!],
			}),
		).toEqual({ _yay: null });
		expect(
			await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)),
			"Copy keeps explicit readiness after complete input",
		).toMatchObject({
			step: "uploading",
			selection: { count: 2, expectedCount: 2 },
		});
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", runId))
					.collect(),
			),
		).toEqual([]);
		expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
			_yay: null,
		});
		expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.step).toBe("select");
	});
});

test.each([8, 100, 200])(
	"full final input of %s positions keeps 25% free with the largest saved source unit",
	async (count) => {
		const prefix = `/${["甲".repeat(255), "乙".repeat(255), "丙".repeat(245)].join("/")}`;
		const names = Array.from({ length: 8 }, (_, index) => `${"文".repeat(253)}-${index}`);
		const paths = [
			...names.map((name) => `${prefix}/${name}`),
			...Array.from({ length: count - 8 }, (_, index) => `/filler-${index}`),
		];
		const { t, db, asUser, folders } = await create_folder_fixture([...paths, "/drafts"]);
		const sources = paths.map((path) => folders.get(path)!);
		const before = await t.run(async (ctx) => {
			const headers = [];
			for (const sourceId of sources.slice(0, 8)) {
				const node = (await ctx.db.get("files_nodes", sourceId))!;
				headers.push({ _id: node._id, path: node.path, name: node.name, parentId: node.parentId });
			}
			return headers;
		});
		const metadata = Array.from({ length: 128 }, (_, index) => ({
			key: `field-${index.toString().padStart(3, "0")}-${"k".repeat(index === 0 ? 107 : 97)}`,
			value: index === 0 ? "v".repeat(1024) : "2026-10-13",
		}));
		const metadataYaml = files_metadata_stringify_entries_yaml(metadata);
		expect(new TextEncoder().encode(metadataYaml).length).toBe(16 * 1024);
		for (const sourceId of sources.slice(0, 8)) {
			vi.setSystemTime(Date.now() + 60_000);
			expect(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: sourceId,
					metadataYaml,
				}),
			).toEqual({ _yay: null });
		}
		const drafts: Id<"files_pending_updates">[] = [];
		for (let owner = 0; owner < 16; owner++) {
			vi.setSystemTime(Date.now() + 10_000);
			const userId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: `acceptance-owner-${owner}` }));
			expect(
				await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userIdToAdd: userId,
				}),
			).toEqual({ _yay: null });
			for (const [index, sourceId] of sources.slice(0, 8).entries()) {
				const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					target: { kind: "saved", id: sourceId },
					destParent: { kind: "saved", id: folders.get("/drafts")! },
					destName: names[index]!,
				});
				if (moved._nay) throw new Error(moved._nay.message);
				const draft = await t.run((ctx) =>
					ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", userId).eq("target.kind", "saved").eq("target.id", sourceId),
						)
						.unique(),
				);
				if (!draft) throw new Error("Expected the normal owner's pending Move");
				drafts.push(draft._id);
			}
		}
		// Drain work due now. Running future timers would expire these proposals.
		await vi.advanceTimersByTimeAsync(0);
		await t.finishInProgressScheduledFunctions();
		expect(drafts).toHaveLength(128);
		expect(
			await t.run((ctx) => Promise.all(drafts.map((id) => ctx.db.get("files_pending_updates", id)))),
			"all 128 normal pending Moves are present before measured acceptance",
		).toEqual(
			drafts.map((id, index) =>
				expect.objectContaining({
					_id: id,
					target: { kind: "saved", id: sources[index % 8]! },
					pendingMove: expect.objectContaining({ destParent: { kind: "saved", id: folders.get("/drafts")! } }),
				}),
			),
		);
		const costs: Awaited<ReturnType<MutationCtx["meta"]["getTransactionMetrics"]>>[] = [];
		for (const registered of [accept_input, append_input])
			test_spy_handler(registered, async (handler, ctx, args) => {
				const result = await handler(ctx, args);
				costs.push(await ctx.meta.getTransactionMetrics());
				return result;
			});
		const accepted = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: `full-input-${count}`,
			kind: "move",
			expectedSourceCount: count,
			sourceIds: sources.slice(0, 100),
			targetParentId: folders.get("/target")!,
		});
		if (accepted._nay) throw new Error(accepted._nay.message);
		const { runId } = accepted._yay;
		if (count === 200) {
			expect((await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))?.step).toBe("uploading");
			expect(
				await asUser.mutation(api.files_transfer.append_input, {
					membershipId: db.membershipId,
					runId,
					offset: 100,
					sourceIds: sources.slice(100),
				}),
			).toEqual({ _yay: null });
		}
		const run = (await t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))!;
		expect(run.step, "complete saved input activates in its acceptance mutation").not.toBe("uploading");
		const firstUnit = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_selection_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId).lt("order", 8))
				.take(8),
		);
		expect(
			firstUnit.map((item) => item.path),
			"full input acceptance includes its first eight saved sources",
		).toEqual(paths.slice(0, 8));
		expect(costs).toHaveLength(count > 100 ? 2 : 1);
		for (const cost of costs)
			for (const [key, metric] of Object.entries(cost))
				expect(
					metric.used,
					`${count}: ${key} includes acceptance, parent work and final flush; leaves 25% free`,
				).toBeLessThan((metric.used + metric.remaining) * 0.75);
		const cohort = await t.run((ctx) =>
			ctx.db
				.query("files_move_cohorts")
				.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
				.unique(),
		);
		if (count === 8) {
			if (cohort) {
				expect(run.step).toBe("apply");
				expect(cohort, "the permitted inline work creates the real saved Move cohort").toMatchObject({
					phase: "staging",
					publishedAt: null,
				});
			} else {
				expect(
					Object.values(costs.at(-1)!).some((metric) => metric.used * 16 >= metric.used + metric.remaining),
					"the flushed join guard yields before cohort creation",
				).toBe(true);
				expect(["select", "normalize", "plan"]).toContain(run.step);
				expect(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "files_transfer:advance", args: [{ runId }], state: { kind: "pending" } }),
					]),
				);
			}
		}
		console.info(
			"complete Move acceptance",
			JSON.stringify({ count, phase: run.step, cursor: run.selection!.cursor, cohortCreated: cohort !== null, costs }),
		);
		const positions = await t.run((ctx) =>
			ctx.db
				.query("files_transfer_selection_items")
				.withIndex("by_run_order", (q) => q.eq("runId", runId))
				.collect(),
		);
		expect(
			positions.map((item) => ({ order: item.order, source: item.source })),
			"the complete input keeps every position and source ID",
		).toEqual(sources.map((id, order) => ({ order, source: { kind: "saved", id } })));
		for (const [index, sourceId] of sources.slice(0, 8).entries()) {
			expect(await t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toMatchObject(before[index]!);
			expect(
				await asUser.query(api.files_metadata.get_entries, { membershipId: db.membershipId, fileNodeId: sourceId }),
			).toEqual(metadata);
		}
		for (const id of drafts)
			expect((await t.run((ctx) => ctx.db.get("files_pending_updates", id)))?.pendingMove?.destParent).toEqual({
				kind: "saved",
				id: folders.get("/drafts")!,
			});
	},
	120_000,
);
