import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { add_member, create_folder_fixture, mock_transfer_storage } from "./files_transfer.setup.test.ts";
import { test_create_saved_text_file, test_finish_saved_scope_jobs } from "./setup.test.ts";
import { files_db_create_path_lookups, files_db_get_path_access } from "../server/files.ts";
import * as overlay from "../server/files-pending-overlay.ts";
import { archive, seed_tree } from "./files_archive_runs.setup.test.ts";

beforeEach(mock_transfer_storage);
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

test.each(["finish", "replace", "stop-before", "stop-after"] as const)(
	"saved paths keep identity and locked replies through Move and partial repair (%s)",
	async (ending) => {
		const f = await create_folder_fixture(["/moving", "/moving/open", "/moving/locked", "/outside"]);
		const replaced =
			ending === "replace"
				? await f.asUser.mutation(api.files_nodes.create_folder_node, {
						membershipId: f.db.membershipId,
						parentId: f.folders.get("/target")!,
						path: "moving",
					})
				: null;
		if (replaced?._nay) throw new Error(replaced._nay.message);
		const member = await add_member(f);
		const openId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/moving/open/a.md",
		});
		const lockedId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/moving/locked/a.md",
		});
		expect(
			await f.asUser.mutation(api.files_sharing.restrict_node, {
				membershipId: f.db.membershipId,
				nodeId: f.folders.get("/moving/locked")!,
			}),
		).toEqual({ _yay: null });
		await test_finish_saved_scope_jobs(f.t);
		const canJoin = overlay.files_pending_overlay_db_can_join_step;
		vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockImplementation(async (ctx, factor) => {
			const allowed = await canJoin(ctx, factor);
			const slot = await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
				)
				.unique();
			return allowed && !slot?.cohortId;
		});
		const started = await f.asUser.mutation(api.files_transfer.accept_input, {
			membershipId: f.db.membershipId,
			requestId: "path-matrix",
			kind: "move",
			expectedSourceCount: 1,
			sourceIds: [f.folders.get("/moving")!],
			targetParentId: f.folders.get("/target")!,
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId, activityId } = started._yay;
		const read = () =>
			f.t.run((ctx) =>
				ctx.db
					.query("files_move_cohorts")
					.withIndex("by_origin_run", (q) => q.eq("origin.kind", "transfer").eq("origin.runId", runId))
					.first(),
			);
		async function step() {
			const cohort = await read();
			if (cohort)
				await f.t.action(internal.files_move_run.run, {
					cohortId: cohort._id,
					step: cohort.step,
					runGeneration: cohort.runJob?.generation ?? null,
					mode: "step",
				});
			else {
				const activity = await f.t.run((ctx) => ctx.db.get("activities", activityId));
				if (ending === "replace" && activity?.status === "awaiting_input") {
					const run = (await f.t.run((ctx) => ctx.db.get("files_transfer_runs", runId)))!;
					const conflicts = await f.asUser.query(api.files_transfer_queries.list_items, {
						membershipId: f.db.membershipId,
						runId: run._id,
						state: "conflict",
						paginationOpts: { cursor: null, numItems: 16 },
					});
					const item = conflicts!.page[0]!;
					expect(
						await f.asUser.mutation(api.files_transfer.resolve_conflicts, {
							membershipId: f.db.membershipId,
							runId: run._id,
							revision: run.revision,
							choices: [
								{
									itemId: item.itemId,
									choice: "replace",
									reviewedTarget: item.conflict!.target!,
									reviewedVersion: item.conflict!.version,
								},
							],
							applyToRemaining: { file: null, folder: null },
						}),
					).toEqual({ _yay: null });
				}
				await f.t.mutation(internal.files_transfer.advance, { runId });
			}
		}
		async function until(predicate: (cohort: Doc<"files_move_cohorts">) => boolean) {
			for (let pass = 0; pass < 1000; pass++) {
				const cohort = await read();
				if (cohort && predicate(cohort)) return cohort;
				await step();
			}
			throw new Error("Move did not reach the path test step");
		}
		async function check_paths(prefix: string, duringMove = true) {
			await f.t.run(async (ctx) => {
				const scope = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId };
				const lookups = await files_db_create_path_lookups(ctx, scope);
				if (replaced?._yay)
					expect(
						(await lookups.get("/target/moving"))?._id,
						"the selected view decides which identity owns a reused name",
					).toBe(prefix === "/moving" ? replaced._yay.nodeId : f.folders.get("/moving"));
				expect((await lookups.get(`${prefix}/open/a.md`))?._id).toBe(openId);
				expect((await lookups.get(`${prefix}/locked/a.md`))?._id).toBe(lockedId);
				expect((await lookups.get("/outside"))?._id).toBe(f.folders.get("/outside"));
				expect(await lookups.get(`${prefix}/open/a.md/child`)).toBeNull();
				expect(await lookups.find_existing_parent(`${prefix}/open/a.md/missing/child`)).toMatchObject({
					node: { _id: openId },
				});
				expect(await lookups.find_existing_parent(`${prefix}/open/missing/deeper/child`)).toMatchObject({
					node: { _id: f.folders.get("/moving/open") },
				});
				if (duringMove) {
					const before = await ctx.meta.getTransactionMetrics();
					expect(await lookups.find_existing_parent(`${prefix}/open/${"missing/".repeat(100)}file`)).toMatchObject({
						node: { _id: f.folders.get("/moving/open") },
					});
					const after = await ctx.meta.getTransactionMetrics();
					expect(
						after.databaseQueries.used - before.databaseQueries.used,
						"missing-prefix lookup uses binary path probes",
					).toBeLessThan(25);
				}
				const subject = { kind: "user", userId: member.userId, plugin: null } as const;
				for (const suffix of [
					"/locked/a.md",
					"/locked/missing",
					"/locked/a.md/child",
					"/locked/missing/deeper/child",
				]) {
					const access = await files_db_get_path_access(ctx, { ...scope, subject, path: `${prefix}${suffix}` });
					expect(access, suffix).toEqual({ status: "locked", node: null });
				}
				expect(
					await files_db_get_path_access(ctx, { ...scope, subject, path: `${prefix}/open/missing/deeper/child` }),
				).toEqual({ status: "missing" });
				expect(await files_db_get_path_access(ctx, { ...scope, subject, path: `${prefix}/open/a.md/child` })).toEqual({
					status: "missing",
				});
				const locked = await files_db_get_path_access(ctx, { ...scope, subject, path: `${prefix}/locked` });
				expect(locked.status).toBe("locked");
				if (locked.status !== "locked") throw new Error("Expected the visible locked folder");
				expect(locked.node?._id).toBe(f.folders.get("/moving/locked"));
				const hiddenPrefix = prefix === "/moving" ? "/target/moving" : "/moving";
				expect(await lookups.get(`${hiddenPrefix}/open/a.md`), "the other view's path stays empty").toBeNull();
			});
		}
		const ready = await until((cohort) => cohort.workPhase === "publish");
		await check_paths("/moving");
		if (ending === "stop-before") {
			expect(
				await f.asUser.mutation(api.files_transfer.stop, {
					membershipId: f.db.membershipId,
					runId,
				}),
			).toEqual({ _yay: null });
		} else {
			await until((cohort) => cohort.publishedAt !== null);
			// The real Move still has its old physical path, but its selected claim is empty there.
			expect((await f.t.run((ctx) => ctx.db.get("files_nodes", openId)))?.path).toBe("/moving/open/a.md");
			await check_paths("/target/moving");
			if (ending === "stop-after")
				expect(
					await f.asUser.mutation(api.files_transfer.stop, {
						membershipId: f.db.membershipId,
						runId,
					}),
				).toEqual({ _yay: null });
		}
		const prefix = ending === "stop-before" ? "/moving" : "/target/moving";
		await until((cohort) => cohort.workPhase === "finish_nodes" || cohort.workPhase === "abort_nodes");
		await step();
		const headers = await f.t.run((ctx) => ctx.db.query("files_nodes").collect());
		expect(
			headers.some((node) => node._id === f.folders.get("/moving") && node.moveCohortId === undefined),
			"the selected root is already repaired",
		).toBe(true);
		expect(
			headers.some((node) => node.moveCohortId === ready._id),
			"another header still uses the selected view",
		).toBe(true);
		await check_paths(prefix);
		await until((cohort) => cohort.phase === "complete");
		await check_paths(prefix, false);
	},
);

test("path lookup keeps active descendants during partial Archive repair", async () => {
	const f = await create_folder_fixture([]);
	const archiveFixture = { ...f, asOwner: f.asUser };
	const tree = await seed_tree(archiveFixture, { name: "archive", folderCount: 2, filesPerFolder: 80 });
	const result = await archive(archiveFixture, [tree.topId]);
	if (result._nay || !result._yay) throw new Error("Expected partial Archive repair");
	const leaf = await f.t.run((ctx) => ctx.db.get("files_nodes", tree.fileIds.at(-1)!));
	expect(leaf?.archiveOperationId).toBeNull();
	await f.t.run(async (ctx) => {
		const lookups = await files_db_create_path_lookups(ctx, f.db);
		expect(await lookups.find_existing_parent(`${leaf!.path}/new/child`)).toMatchObject({ node: { _id: leaf!._id } });
	});
});
