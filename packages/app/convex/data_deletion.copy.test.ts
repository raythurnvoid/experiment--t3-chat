import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Copy reference purge", () => {
	test.each(["queued", "prepare", "finalize"] as const)(
		"%s user deletion waits for a retry manifest with no fake delete count",
		async (door) => {
			const t = test_convex({ transactionLimits: true });
			const db = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "personal", workspaceName: "home" }),
			);
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const destination = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/target",
			});
			if (destination._nay) throw new Error(destination._nay.message);
			const sourceIds = [];
			for (const path of ["/first", "/second"]) {
				const created = await t.mutation(internal.files_nodes.create_folder_node_by_path, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					path,
				});
				if (created._nay) throw new Error(created._nay.message);
				sourceIds.push(created._yay.nodeId);
			}
			const started = await asUser.mutation(api.files_transfer.start, {
				membershipId: db.membershipId,
				requestId: "purge-source",
				kind: "copy",
				expectedSourceCount: 2,
				sourceIds,
				targetParentId: destination._yay.nodeId,
			});
			if (started._nay) throw new Error(started._nay.message);
			expect(
				await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId: started._yay.runId }),
			).toEqual({ _yay: null });
			for (let step = 0; step < 20; step++) {
				await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
				if ((await t.run((ctx) => ctx.db.get("activities", started._yay.activityId)))?.progress?.completed === 1) break;
			}
			const item = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId).eq("order", 0))
					.unique(),
			);
			if (item?.outputTarget?.kind !== "saved") throw new Error("Expected a saved completed output");
			const outputId = item.outputTarget.id;
			const output = await t.run((ctx) => ctx.db.get("files_nodes", outputId));
			expect(
				await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId: started._yay.runId }),
			).toEqual({ _yay: null });
			for (let step = 0; step < 3; step++)
				await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			const retried = await asUser.mutation(api.files_transfer.retry_remaining, {
				membershipId: db.membershipId,
				runId: started._yay.runId,
				requestId: "purge-retry",
			});
			if (retried._nay) throw new Error(retried._nay.message);
			const requestId =
				door === "queued" ? await t.mutation(internal.data_deletion.init_user_deletion, { userId: db.userId }) : null;
			const purge = async () => {
				if (door === "queued") {
					if (!requestId) throw new Error("Expected the user deletion request");
					return await t.mutation(internal.data_deletion.process_user_deletion_request, {
						requestId,
						_test_batchSize: 100,
					});
				}
				if (door === "prepare")
					return await t.mutation(internal.data_deletion.prepare_user_for_hard_deletion, {
						userId: db.userId,
						_test_batchSize: 100,
					});
				return await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
					userId: db.userId,
					deleteUserRecord: true,
					_test_batchSize: 100,
					_test_disableReschedule: true,
				});
			};
			// No retry advance runs between these passes: the producer is waiting, not empty.
			for (let pass = 0; pass < 2; pass++) {
				expect(await purge()).toEqual(door === "queued" ? { done: false, deletedCount: 0 } : false);
				expect(await t.run((ctx) => ctx.db.get("users", db.userId))).not.toBeNull();
				expect(await t.run((ctx) => ctx.db.get("organizations_workspaces_users", db.membershipId))).not.toBeNull();
				expect(await t.run((ctx) => ctx.db.get("files_transfer_runs", retried._yay.runId))).toMatchObject({
					step: "retry",
				});
			}
			// Stop must still finish the retry manifest before purge can drain both producers.
			for (let step = 0; step < 5; step++)
				await t.mutation(internal.files_transfer.advance, { runId: retried._yay.runId });
			let done = false;
			for (let pass = 0; pass < 100 && !done; pass++) {
				const result = await purge();
				done = typeof result === "boolean" ? result : result.done;
			}
			expect(done).toBe(true);
			expect(await t.run((ctx) => ctx.db.query("files_transfer_runs").collect())).toEqual([]);
			expect(await t.run((ctx) => ctx.db.query("files_transfer_items").collect())).toEqual([]);
			expect(await t.run((ctx) => ctx.db.query("files_transfer_selection_items").collect())).toEqual([]);
			expect(await t.run((ctx) => ctx.db.query("activities").collect())).toEqual([]);
			expect(await t.run((ctx) => ctx.db.get("files_nodes", outputId))).toEqual(output);
		},
	);

	test.each(["workspace", "user"] as const)("drains %s media rows in pages and keeps unrelated files", async (kind) => {
		const t = test_convex({ transactionLimits: true });
		const victim = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const control = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx, { organizationName: "control" }));
		const image = await t
			.withIdentity({ issuer: "https://clerk.test", external_id: control.userId })
			.mutation(api.files_nodes.create_upload_node, {
				membershipId: control.membershipId,
				parentId: "root",
				filename: "keep.png",
				contentType: "image/png",
				size: 4,
			});
		if (image._nay) throw new Error(image._nay.message);
		const saved = (await t.run((ctx) => ctx.db.get("files_nodes", image._yay.nodeId)))!;
		const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", saved.assetId!));
		const dependency: Doc<"files_media_dependencies">["dependency"] = {
			src: `bonobo-file://${saved._id}`,
			target: { kind: "saved", id: saved._id },
			assetId: saved.assetId!,
			version: {
				kind: "asset",
				assetId: saved.assetId!,
				contentType: "image/png",
				textKind: null,
				collaborationEnabled: null,
			},
		};
		// Retired sets own mapping rows only. Their former proposal may already be gone.
		const sets = await t.run(async (ctx) => {
			const ids = [];
			for (const scope of [victim, control]) {
				const setId = await ctx.db.insert("files_media_dependency_sets", {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					userId: scope.userId,
					owner: { kind: "cleanup" },
					generation: 2,
					expectedCount: 101,
					count: 101,
					sealed: true,
				});
				for (let order = 0; order < 101; order++)
					await ctx.db.insert("files_media_dependencies", { setId, order, sourceSrc: `source:${order}`, dependency });
				ids.push(setId);
			}
			return ids;
		});
		const requestId =
			kind === "workspace"
				? await t.run((ctx) =>
						data_deletion_db_request(ctx, {
							organizationId: victim.organizationId,
							workspaceId: victim.workspaceId,
							userId: victim.userId,
							scope: "workspace",
							eligibleAt: Date.now(),
						}),
					)
				: null;
		let done = false;
		let previousCount = 101;
		const removedPages: number[] = [];
		for (let pass = 0; pass < 100 && !done; pass++) {
			done = requestId
				? (
						await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
							requestId,
							_test_batchSize: 100,
						})
					).done
				: await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
						userId: victim.userId,
						_test_batchSize: 100,
						_test_disableReschedule: true,
					});
			const count = await t.run(
				async (ctx) =>
					(
						await ctx.db
							.query("files_media_dependencies")
							.withIndex("by_set_order", (q) => q.eq("setId", sets[0]!))
							.collect()
					).length,
			);
			if (count !== previousCount) removedPages.push(previousCount - count);
			previousCount = count;
		}
		expect(done).toBe(true);
		expect(removedPages).toEqual([50, 50, 1]);
		expect(await t.run((ctx) => ctx.db.get("files_media_dependency_sets", sets[0]!))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_media_dependency_sets", sets[1]!))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.query("files_media_dependencies").collect())).toHaveLength(101);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", saved._id))).toEqual(saved);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", saved.assetId!))).toEqual(asset);
		expect(await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual([]);
		if (kind === "workspace")
			expect(
				await t.run((ctx) =>
					ctx.db
						.query("files_media_validation_versions")
						.withIndex("by_organization_workspace", (q) =>
							q.eq("organizationId", victim.organizationId).eq("workspaceId", victim.workspaceId),
						)
						.unique(),
				),
			).toBeNull();
	});
});
