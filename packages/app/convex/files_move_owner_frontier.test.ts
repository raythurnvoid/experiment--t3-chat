import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { ActionCtx } from "./_generated/server.js";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { owner_saved_folders } from "./files_move_pages.ts";
import { run_to_end as finish_archive } from "./files_archive_runs.setup.test.ts";
import * as owner_work from "./files_move_owner_work.ts";
import * as overlay from "../server/files-pending-overlay.ts";
import { files_move_reservations_db_find_blocker } from "../server/files-move-reservations.ts";
import { test_convex, test_mocks_fill_db_with, test_spy_handler } from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("owner-frontier-test" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

test.each(["finish", "joined", "overlap", "stop-before", "stop-after", "archived"])(
	"saved owner folders keep accepted drafts through %s",
	async (mode) => {
		const t = test_convex({ transactionLimits: true });
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const ownerId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "frontier-owner" }));
		expect(
			await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userIdToAdd: ownerId,
			}),
		).toEqual({ _yay: null });
		async function folder(parentId: Id<"files_nodes"> | "root", path: string) {
			vi.setSystemTime(Date.now() + 10_000);
			const result = await asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId,
				path,
			});
			if (result._nay) throw new Error(result._nay.message);
			return result._yay.nodeId;
		}
		const moving = await folder("root", "/moving");
		const target = await folder("root", "/target");
		const owner = await folder(
			"root",
			mode === "archived" ? `/${"甲".repeat(255)}/${"乙".repeat(255)}/${"丙".repeat(240)}/owner` : "/owner",
		);
		const deep = await folder(owner, "deep");
		const archived: Id<"files_nodes">[] = [];
		const folderPages: { ids: Id<"files_nodes">[]; isDone: boolean }[] = [];
		const workerCosts: { ranges: number; read: number; bytes: number; written: number; writeBytes: number }[] = [];
		if (mode === "archived") {
			for (let index = 0; index < 70; index++)
				archived.push(await folder(deep, `${String(index).padStart(3, "0")}${"文".repeat(252)}`));
			const started = await asUser.mutation(api.files_nodes.archive_nodes, {
				membershipId: db.membershipId,
				nodeIds: archived,
			});
			if (started._nay || !started._yay) throw new Error("Expected the Archive job");
			expect((await finish_archive({ t, db, asOwner: asUser }, started._yay)).activity.status).toBe("succeeded");
			test_spy_handler(owner_saved_folders, async (handler, ctx, args) => {
				const result = await handler(ctx, args);
				if ((args as { parentId: Id<"files_nodes"> }).parentId === deep) {
					const page = result as unknown as {
						page: (Doc<"files_nodes"> | Doc<"files_saved_places">)[];
						isDone: boolean;
					};
					folderPages.push({
						ids: page.page.map((doc) => ("nodeId" in doc ? doc.nodeId : doc._id)),
						isDone: page.isDone,
					});
				}
				return result;
			});
			test_spy_handler(advance_cohort, async (handler, ctx, args) => {
				const result = await handler(ctx, args);
				const metrics = await ctx.meta.getTransactionMetrics();
				workerCosts.push({
					ranges: metrics.databaseQueries.used,
					read: metrics.documentsRead.used,
					bytes: metrics.bytesRead.used,
					written: metrics.documentsWritten.used,
					writeBytes: metrics.bytesWritten.used,
				});
				return result;
			});
		}
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: ownerId };
		expect(
			(
				await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					...scope,
					target: { kind: "saved", id: owner },
					destParent: { kind: "saved", id: moving },
					destName: "owner",
				})
			)._nay,
		).toBeUndefined();
		if (mode === "overlap") {
			const otherId = await t.run((ctx) => ctx.db.insert("users", { clerkUserId: "frontier-other" }));
			vi.setSystemTime(Date.now() + 10_000);
			expect(
				await asUser.mutation(api.organizations.invite_user_to_organization_workspace, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userIdToAdd: otherId,
				}),
			).toEqual({ _yay: null });
			expect(
				(
					await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
						...scope,
						userId: otherId,
						target: { kind: "saved", id: deep },
						destParent: { kind: "saved", id: moving },
						destName: "other-deep",
					})
				)._nay,
			).toBeUndefined();
		}
		// Yield at real worker boundaries so a supported create can race folder discovery.
		const canJoin = overlay.files_pending_overlay_db_can_join_step;
		const join = vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockImplementation(async (ctx, factor) => {
			const allowed = await canJoin(ctx, factor);
			const slot = await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
				.unique();
			return allowed && !slot?.cohortId;
		});
		const started = await asUser.mutation(api.files_transfer.accept_input, {
			membershipId: db.membershipId,
			requestId: "owner-frontier",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [moving],
			targetParentId: target,
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await asUser.mutation(api.files_transfer.seal, {
				membershipId: db.membershipId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		let cohortId: Id<"files_move_cohorts"> | null = null;
		for (let pass = 0; pass < 100; pass++) {
			const slot = await t.run((ctx) =>
				ctx.db
					.query("files_move_workspace_slots")
					.withIndex("by_workspace", (q) => q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId))
					.unique(),
			);
			if (slot?.cohortId) {
				cohortId = slot.cohortId;
				break;
			}
			await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
		}
		if (!cohortId) throw new Error("Move did not start");
		const id = cohortId;
		const cohort = async () => (await t.run((ctx) => ctx.db.get("files_move_cohorts", id)))!;
		const source = async (nodeId: Id<"files_nodes">) =>
			await t.run((ctx) =>
				ctx.db
					.query("files_move_source_reservations")
					.withIndex("by_source", (q) => q.eq("source.kind", "saved").eq("source.id", nodeId))
					.unique(),
			);
		async function advance() {
			const current = await cohort();
			await t.action(internal.files_move_run.run, {
				cohortId: id,
				step: current.step,
				runGeneration: current.runJob?.generation ?? null,
				mode: "step",
			});
		}
		async function until(done: () => Promise<boolean>) {
			for (let pass = 0; pass < 1000; pass++) {
				if (await done()) return;
				await advance();
			}
			throw new Error("Move did not reach the expected step");
		}
		await until(async () =>
			mode === "overlap" ? (await cohort()).workPhase === "owners_collect" : Boolean(await source(owner)),
		);
		expect(
			await t.run((ctx) =>
				ctx.db
					.query("files_move_cohort_nodes")
					.withIndex("by_cohort_node", (q) => q.eq("cohortId", id).eq("nodeId", owner))
					.unique(),
			),
			"the owner-only root is outside the physical Move",
		).toBeNull();
		expect(await source(deep), "the deeper folder has not been reached").toBeNull();
		expect(
			await t.run((ctx) =>
				files_move_reservations_db_find_blocker(ctx.db, {
					parent: { kind: "saved", id: deep },
				}),
			),
			"an unvisited saved parent stays writable",
		).toBeNull();
		const late = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope,
			path: "/moving/owner/deep/late",
			kind: "folder",
		});
		expect(late._nay, "the supported create accepts before closure").toBeUndefined();
		if (late._nay) throw new Error(late._nay.message);
		expect(late._yay.target.kind).toBe("private");
		let staged = 0;
		let prefixes = 0;
		if (mode === "joined") {
			join.mockRestore();
			const collect = owner_work.files_move_owner_work_db_collect_closure;
			vi.spyOn(owner_work, "files_move_owner_work_db_collect_closure").mockImplementation(async (ctx, args, factor) => {
				const unfinished =
					(await ctx.db
						.query("files_move_work_ranges")
						.withIndex("by_cohort_phase_status_order", (q) =>
							q.eq("cohortId", id).eq("phase", "frontier").eq("status", "running"),
						)
						.first()) ??
					(await ctx.db
						.query("files_move_work_ranges")
						.withIndex("by_cohort_phase_status_order", (q) =>
							q.eq("cohortId", id).eq("phase", "frontier").eq("status", "queued"),
						)
						.first());
				const readPrefixes = async () =>
					await Promise.all(
						["/owner/", "/moving/owner/"].map((prefix) =>
							ctx.db
								.query("files_move_work_ranges")
								.withIndex("by_cohort_key", (q) => q.eq("cohortId", id).eq("key", `owner-prefix:${ownerId}:${prefix}`))
								.unique(),
						),
					);
				const before = await readPrefixes();
				const result = await collect(ctx, args, factor);
				if (JSON.stringify(before) !== JSON.stringify(await readPrefixes())) {
					expect(unfinished, "owner prefixes wait for the saved folder frontier").toBeNull();
					prefixes++;
				}
				return result;
			});
			const stage = owner_work.files_move_owner_work_db_stage;
			vi.spyOn(owner_work, "files_move_owner_work_db_stage").mockImplementation(async (ctx, args, factor) => {
				for (const status of ["running", "queued"] as const)
					expect(
						await ctx.db
							.query("files_move_work_ranges")
							.withIndex("by_cohort_phase_status_order", (q) =>
								q.eq("cohortId", id).eq("phase", "frontier").eq("status", status),
							)
							.first(),
						"owner staging waits for the saved folder frontier",
					).toBeNull();
				staged++;
				return await stage(ctx, args, factor);
			});
		}
		if (mode === "stop-before") {
			expect(
				(
					await t.run((ctx) =>
						ctx.db
							.query("files_move_work_ranges")
							.withIndex("by_cohort_key", (q) => q.eq("cohortId", id).eq("key", `saved-folders:${owner}`))
							.unique(),
					)
				)?.status,
				"Stop reaches an unfinished frontier",
			).toBe("queued");
			expect(
				(
					await asUser.mutation(api.files_transfer.stop, {
						membershipId: db.membershipId,
						runId: started._yay.runId,
					})
				)._nay,
			).toBeUndefined();
			await until(async () => {
				expect(await source(deep), "Stop drains the frontier without taking deeper holds").toBeNull();
				return (await cohort()).phase === "complete";
			});
		} else await until(async () => (await cohort()).publishedAt !== null);
		const path = mode === "stop-before" ? "/moving" : "/target/moving";
		const visible = await t.query(internal.files_visible.internal_get_by_target, {
			...scope,
			target: late._yay.target,
		});
		expect(visible?.path).toBe(`${path}/owner/deep/late`);
		const listing = await overlay.files_pending_overlay_list(
			{ runQuery: t.query } as unknown as Pick<ActionCtx, "runQuery">,
			{
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				subject: { kind: "user", userId: ownerId, plugin: null },
				visibilityUserId: ownerId,
				overlayUserId: ownerId,
				folderPath: path,
				mode: "subtree",
				order: "asc",
				numItems: 100,
				cursor: null,
			},
		);
		expect(JSON.stringify(listing), "the accepted late draft appears in the After subtree listing").toContain(
			late._yay.target.id,
		);
		if (mode !== "stop-before") {
			expect(
				(
					await t.mutation(internal.files_nodes.create_private_node_by_path, {
						...scope,
						path: `${path}/owner/deep/after-close`,
						kind: "folder",
					})
				)._nay?.name,
				"a create after closure returns typed busy",
			).toBe("move_busy");
			expect((await source(deep))?.mode, "the saved frontier closes the deeper folder").toBe("children");
		}
		if (mode === "overlap") {
			const ranges = await t.run((ctx) =>
				ctx.db
					.query("files_move_work_ranges")
					.withIndex("by_cohort_key", (q) => q.eq("cohortId", id).eq("key", `saved-folders:${deep}`))
					.take(2),
			);
			expect(ranges, "overlapping owners share one completed folder range").toHaveLength(1);
			expect(ranges[0]?.status).toBe("complete");
		}
		if (mode === "joined") {
			expect(prefixes, "the joined worker really visits owner prefixes").toBeGreaterThan(0);
			expect(staged, "the joined worker really stages owners").toBeGreaterThan(0);
		}
		if (mode === "archived") {
			expect(folderPages.flatMap((page) => page.ids).sort(), "every archived folder is visited once").toEqual(
				[...archived].sort(),
			);
			expect(
				folderPages.some((page) => page.ids.length < 32 && !page.isDone),
				"large legal paths produce a short native page",
			).toBe(true);
			for (const nodeId of archived) expect((await source(nodeId))?.mode).toBe("children");
		}
		if (mode === "stop-after")
			expect(
				(
					await asUser.mutation(api.files_transfer.stop, {
						membershipId: db.membershipId,
						runId: started._yay.runId,
					})
				)._nay,
			).toBeUndefined();
		await until(async () => (await cohort()).phase === "complete");
		expect(await source(deep), "repair releases the exact folder hold").toBeNull();
		expect((await cohort()).pendingWorkCount, "all queued work completes once").toBe(0);
		expect(
			(
				await t.mutation(internal.files_nodes.create_private_node_by_path, {
					...scope,
					path: `${path}/owner/deep/after-release`,
					kind: "folder",
				})
			)._nay,
			"create succeeds after release",
		).toBeUndefined();
		if (mode === "archived") {
			for (const nodeId of archived) expect(await source(nodeId), "repair releases archived folder holds").toBeNull();
			console.info(
				"owner frontier worker peaks",
				Object.fromEntries(
					Object.keys(workerCosts[0]!).map((key) => [
						key,
						Math.max(...workerCosts.map((cost) => cost[key as keyof typeof cost])),
					]),
				),
			);
		}
	},
);
