import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
	files_private_storage_db_release,
	files_private_storage_db_release_deleted_resource,
	files_private_storage_db_reserve,
} from "./files_private_storage.ts";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { r2_confirmed_object_delete, r2_create_asset_key, r2_enqueue_object_deletion_job } from "./r2_client.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_agent_write_file_text } from "../server/bash-utils.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(r2_confirmed_object_delete, "delete_object").mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function create_asset(
	ctx: MutationCtx,
	db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
) {
	const id = await ctx.db.insert("files_r2_assets", {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		createdBy: db.userId,
		kind: "content",
		r2Bucket: "test",
		size: 0,
		updatedAt: Date.now(),
	});
	return { kind: "asset", id, r2Key: r2_create_asset_key({ ...db, assetId: id }) } as const;
}

async function create_publication(
	ctx: MutationCtx,
	db: { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces">; userId: Id<"users"> },
	name: string,
) {
	const created = await files_pending_nodes_db_create(ctx, { ...db, parent: { kind: "root" }, name, kind: "file" });
	if (created._nay) throw new Error(created._nay.message);
	const resource = await create_asset(ctx, db);
	const publicationBatchId = await ctx.db.insert("files_pending_update_operation_batches", {
		organizationId: db.organizationId,
		workspaceId: db.workspaceId,
		userId: db.userId,
		target: { kind: "private", id: created._yay.privateNodeId },
		expectedPendingUpdateId: created._yay.pendingUpdateId,
		expectedRevision: 1,
		expectedPrivateVersion: { creationGeneration: 1, structuralRevision: 1 },
		publication: { kind: "assets", contentAssetId: resource.id },
		expiresAt: Date.now() + 60_000,
		updatedAt: Date.now(),
		lastActivityAt: Date.now(),
	});
	return { ...created._yay, resource, publicationBatchId };
}

describe("files_private_storage_db_reserve", () => {
	test.each(["files_private_user_bytes", "files_private_workspace_bytes"] as const)(
		"refuses admission above %s without consuming either counter",
		async (quotaName) => {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			await t.run(async (ctx) => {
				const quotaId = await quotas_db_ensure(ctx, { ...db, quotaName, now: Date.now() });
				await ctx.db.patch("quotas", quotaId, { maxCount: 10 });
			});
			const resource = await t.run(async (ctx) => create_asset(ctx, db));
			const held = await t.run(async (ctx) =>
				files_private_storage_db_reserve(ctx, { ...db, resource, byteCount: 10 }),
			);
			expect(held._yay).toBeTruthy();
			const before = await t.run(async (ctx) => ctx.db.query("quotas").collect());
			const refused = await t.run(async (ctx) =>
				files_private_storage_db_reserve(ctx, { ...db, resource, byteCount: 11 }),
			);
			expect(refused._nay?.name).toBe("storage_full");
			expect(await t.run(async (ctx) => ctx.db.query("quotas").collect())).toEqual(before);
			expect(await t.run(async (ctx) => ctx.db.query("files_private_storage_reservations").collect())).toMatchObject([
				{ byteCount: 10, settlement: { kind: "held" } },
			]);
		},
	);

	test("counts one resource once, including a repeated reservation while over cap", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const resource = await t.run(async (ctx) => create_asset(ctx, db));
		const first = await t.run(async (ctx) => files_private_storage_db_reserve(ctx, { ...db, resource, byteCount: 8 }));
		if (first._nay) throw new Error(first._nay.message);
		await t.run(async (ctx) => {
			const hold = await ctx.db.get("files_private_storage_reservations", first._yay);
			if (!hold) throw new Error("Expected a storage hold");
			await ctx.db.patch("quotas", hold.userQuotaId, { maxCount: 4 });
		});
		const repeated = await t.run(async (ctx) =>
			files_private_storage_db_reserve(ctx, { ...db, resource, byteCount: 8 }),
		);
		expect(repeated).toEqual(first);
		const holds = await t.run(async (ctx) => ctx.db.query("files_private_storage_reservations").collect());
		expect(holds).toHaveLength(1);
		expect(await t.run(async (ctx) => ctx.db.get("quotas", holds[0]!.userQuotaId))).toMatchObject({ usedCount: 8 });
	});

	test("counts reviewed Save outputs above cap while ordinary growth stays blocked", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const publication = await t.run(async (ctx) => create_publication(ctx, db, "saved.txt"));
		await t.run(async (ctx) => {
			for (const quotaName of ["files_private_user_bytes", "files_private_workspace_bytes"] as const) {
				const quotaId = await quotas_db_ensure(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					...(quotaName === "files_private_user_bytes" ? { quotaName, userId: db.userId } : { quotaName }),
					now: Date.now(),
				});
				await ctx.db.patch("quotas", quotaId, { maxCount: 0 });
			}
		});
		const held = await t.run(async (ctx) =>
			files_private_storage_db_reserve(ctx, {
				...db,
				resource: publication.resource,
				publicationBatchId: publication.publicationBatchId,
				byteCount: 12,
			}),
		);
		if (held._nay) throw new Error(held._nay.message);
		await t.run(async (ctx) => {
			const hold = await ctx.db.get("files_private_storage_reservations", held._yay);
			if (!hold?.workspaceQuotaId) throw new Error("Expected byte quotas");
			expect(hold).toMatchObject({ byteCount: 12, publicationBatchId: publication.publicationBatchId });
			expect(await ctx.db.get("quotas", hold.userQuotaId)).toMatchObject({ usedCount: 12, maxCount: 0 });
			expect(await ctx.db.get("quotas", hold.workspaceQuotaId)).toMatchObject({ usedCount: 12, maxCount: 0 });
			const ordinary = await create_asset(ctx, db);
			expect(
				(await files_private_storage_db_reserve(ctx, { ...db, resource: ordinary, byteCount: 1 }))._nay?.name,
			).toBe("storage_full");
		});
	});

	test.each(["proposal", "generation", "expiry"] as const)(
		"refuses stale %s before reserving Save bytes",
		async (changed) => {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const publication = await t.run(async (ctx) => create_publication(ctx, db, "changed.txt"));
			await t.run(async (ctx) => {
				if (changed === "proposal")
					await ctx.db.patch("files_pending_updates", publication.pendingUpdateId, { revision: 2 });
				if (changed === "generation")
					await ctx.db.patch("files_pending_nodes", publication.privateNodeId, { creationGeneration: 2 });
				if (changed === "expiry")
					await ctx.db.patch("files_pending_update_operation_batches", publication.publicationBatchId, {
						expiresAt: Date.now(),
					});
			});
			const before = await t.run(async (ctx) => ctx.db.query("quotas").collect());
			expect(
				(
					await t.run(async (ctx) =>
						files_private_storage_db_reserve(ctx, {
							...db,
							resource: publication.resource,
							publicationBatchId: publication.publicationBatchId,
							byteCount: 12,
						}),
					)
				)._nay?.name,
			).toBe("target_changed");
			expect(await t.run(async (ctx) => ctx.db.query("quotas").collect())).toEqual(before);
			expect(
				await t.run(async (ctx) =>
					ctx.db
						.query("files_private_storage_reservations")
						.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", publication.resource.id))
						.first(),
				),
			).toBeNull();
		},
	);

	test("keeps failed Save outputs within one workspace allowance until deletion", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const reservations: (Awaited<ReturnType<typeof create_publication>> & {
			reservationId: Id<"files_private_storage_reservations">;
		})[] = [];
		for (let i = 0; i < 5; i++) {
			const publication = await t.run(async (ctx) => create_publication(ctx, db, `${i}.txt`));
			const held = await t.run(async (ctx) =>
				files_private_storage_db_reserve(ctx, {
					...db,
					resource: publication.resource,
					publicationBatchId: publication.publicationBatchId,
					byteCount: 4 * 1024 * 1024,
				}),
			);
			if (held._nay) throw new Error(held._nay.message);
			reservations.push({ ...publication, reservationId: held._yay });
		}
		const publication = await t.run(async (ctx) => create_publication(ctx, db, "retry.txt"));
		await t.run(async (ctx) => {
			const hold = await ctx.db.get("files_private_storage_reservations", reservations[0]!.reservationId);
			if (!hold?.workspaceQuotaId) throw new Error("Expected workspace quota");
			await ctx.db.patch("quotas", hold.workspaceQuotaId, { maxCount: 0 });
		});
		expect(
			(
				await t.run(async (ctx) =>
					files_private_storage_db_reserve(ctx, {
						...db,
						resource: publication.resource,
						publicationBatchId: publication.publicationBatchId,
						byteCount: 1,
					}),
				)
			)._nay?.name,
		).toBe("storage_full");
		await t.run(async (ctx) => {
			const first = reservations[0]!;
			await ctx.db.delete("files_r2_assets", first.resource.id);
			await r2_enqueue_object_deletion_job(ctx, { ...db, r2Key: first.resource.r2Key, reason: "failed_create" });
		});
		const job = await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").unique());
		if (!job) throw new Error("Expected deletion job");
		await t.mutation(internal.r2_client.settle_object_deletion_job, {
			jobId: job._id,
			generation: job.generation,
			deletedAt: Date.now(),
		});
		expect(
			(
				await t.run(async (ctx) =>
					files_private_storage_db_reserve(ctx, {
						...db,
						resource: publication.resource,
						publicationBatchId: publication.publicationBatchId,
						byteCount: 1,
					}),
				)
			)._yay,
		).toBeTruthy();
	});

	test("replaces shorter staged input while above cap and releases only its remaining bytes once", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const input = await t.run(async (ctx) => {
			const created = await files_pending_nodes_db_create(ctx, {
				...db,
				parent: { kind: "root" },
				name: "draft.txt",
				kind: "file",
			});
			if (created._nay) throw new Error(created._nay.message);
			const target = { kind: "private" as const, id: created._yay.privateNodeId };
			const operationBatchId = await ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				target,
				expectedPendingUpdateId: created._yay.pendingUpdateId,
				expectedRevision: 1,
				expectedPrivateVersion: { creationGeneration: 1, structuralRevision: 1 },
				expiresAt: Date.now() + 60_000,
				updatedAt: Date.now(),
				lastActivityAt: Date.now(),
			});
			const id = await ctx.db.insert("files_pending_update_text_inputs", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				target,
				operationBatchId,
				role: "unstaged",
				text: "12345678",
				expiresAt: Date.now() + 60_000,
			});
			const resource = { kind: "text_input" as const, id };
			const held = await files_private_storage_db_reserve(ctx, { ...db, resource, byteCount: 8 });
			if (held._nay) throw new Error(held._nay.message);
			const hold = await ctx.db.get("files_private_storage_reservations", held._yay);
			if (!hold?.workspaceQuotaId) throw new Error("Expected both byte quotas");
			await ctx.db.patch("quotas", hold.userQuotaId, { maxCount: 1 });
			await ctx.db.patch("quotas", hold.workspaceQuotaId, { maxCount: 1 });
			return { resource, hold };
		});
		await t.run(async (ctx) => {
			expect(await files_private_storage_db_reserve(ctx, { ...db, resource: input.resource, byteCount: 2 })).toEqual({
				_yay: input.hold._id,
			});
			await ctx.db.patch("files_pending_update_text_inputs", input.resource.id, { text: "12" });
		});
		await t.run(async (ctx) => {
			expect(await ctx.db.get("quotas", input.hold.userQuotaId)).toMatchObject({ usedCount: 2 });
			expect(await ctx.db.get("quotas", input.hold.workspaceQuotaId!)).toMatchObject({ usedCount: 2 });
			expect(await ctx.db.get("files_private_storage_reservations", input.hold._id)).toMatchObject({
				byteCount: 2,
				settlement: { kind: "held" },
			});
			await ctx.db.delete("files_pending_update_text_inputs", input.resource.id);
			await files_private_storage_db_release_deleted_resource(ctx, input.resource);
			await files_private_storage_db_release_deleted_resource(ctx, input.resource);
			expect(await ctx.db.get("quotas", input.hold.userQuotaId)).toMatchObject({ usedCount: 0 });
			expect(await ctx.db.get("quotas", input.hold.workspaceQuotaId!)).toMatchObject({ usedCount: 0 });
			expect(await ctx.db.get("files_private_storage_reservations", input.hold._id)).toMatchObject({
				settlement: { kind: "deleted", proof: { kind: "database" } },
			});
		});
	});

	test("counts private node slots separately from payload bytes", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const resource = await t.run(async (ctx) => ({
			kind: "node" as const,
			id: await ctx.db.insert("files_pending_nodes", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				kind: "folder",
				name: "draft",
				parent: { kind: "root" },
				structuralRevision: 1,
				creationGeneration: 1,
				state: "active",
				closedAt: null,
			}),
		}));
		const held = await t.run(async (ctx) => files_private_storage_db_reserve(ctx, { ...db, resource, byteCount: 0 }));
		if (held._nay) throw new Error(held._nay.message);
		expect(await t.run(async (ctx) => ctx.db.get("files_private_storage_reservations", held._yay))).toMatchObject({
			byteCount: 0,
			workspaceQuotaId: null,
		});
		const privateQuotas = await t.run(async (ctx) =>
			(await ctx.db.query("quotas").collect()).filter((quota) => quota.quotaName.startsWith("files_private_")),
		);
		expect(privateQuotas).toMatchObject([{ quotaName: "files_private_nodes", usedCount: 1 }]);
		await t.run(async (ctx) => {
			await ctx.db.delete("files_pending_nodes", resource.id);
			await files_private_storage_db_release(ctx, {
				reservationId: held._yay,
				settlement: { kind: "deleted", settledAt: Date.now(), proof: { kind: "database" } },
			});
		});
		expect(await t.run(async (ctx) => ctx.db.get("quotas", privateQuotas[0]!._id))).toMatchObject({ usedCount: 0 });
	});
});

describe("private storage purge", () => {
	test.each(["user", "workspace"] as const)("bounds large text-input reads during %s purge", async (scope) => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const tenant = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		for (let index = 0; index < 17; index++) {
			const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				...tenant,
				path: `/large-${index}.txt`,
				kind: "file",
			});
			if (created._nay || !created._yay.operationBatchId) throw new Error("Expected an unfinished batch");
			expect(
				(
					await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
						...tenant,
						operationBatchId: created._yay.operationBatchId,
						role: "unstaged",
						text: "x".repeat(900_000),
					})
				)._nay,
			).toBeUndefined();
		}
		let requestId: Id<"data_deletion_requests"> | undefined;
		if (scope === "workspace") {
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			expect(
				(await asUser.mutation(api.organizations.delete_workspace, { workspaceId: db.workspaceId }))._nay,
			).toBeUndefined();
			requestId = await t.run(
				async (ctx) =>
					(await ctx.db.query("data_deletion_requests").collect()).find(
						(doc) => doc.scope === "workspace" && doc.workspaceId === db.workspaceId,
					)?._id,
			);
			if (!requestId) throw new Error("Expected a workspace deletion request");
		}
		let remaining = 17;
		for (let pass = 0; pass < 50 && remaining > 0; pass++) {
			if (scope === "user") {
				await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
					userId: db.userId,
					deleteUserRecord: true,
					_test_batchSize: 100,
					_test_disableReschedule: true,
				});
			} else {
				await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
					requestId: requestId!,
					_test_batchSize: 100,
				});
			}
			const nextRemaining = await t.run(
				async (ctx) => (await ctx.db.query("files_pending_update_text_inputs").collect()).length,
			);
			expect(remaining - nextRemaining).toBeLessThanOrEqual(8);
			remaining = nextRemaining;
		}
		expect(remaining).toBe(0);
	});

	test.each(["user", "workspace"] as const)(
		"removes private payloads during %s purge and keeps remote bytes held",
		async (scope) => {
			const t = test_convex();
			const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
			const control = await t.run((ctx) =>
				test_mocks_fill_db_with.membership(ctx, { organizationName: "private-control" }),
			);
			const tenant = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
			const parent = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				...tenant,
				path: "/private",
				kind: "folder",
			});
			if (parent._nay || !parent._yay.pendingUpdateId) throw new Error("Expected a private folder proposal");
			const child = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				...tenant,
				path: "/private/child.txt",
				kind: "file",
			});
			if (child._nay || !child._yay.operationBatchId) throw new Error("Expected a private file batch");
			const written = await t.action((ctx) =>
				files_agent_write_file_text(ctx, {
					...tenant,
					target: child._yay.target,
					operationBatchId: child._yay.operationBatchId!,
					unstagedText: "private text",
				}),
			);
			expect(written._nay).toBeUndefined();
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: db.membershipId,
				target: parent._yay.target,
				pendingUpdateId: parent._yay.pendingUpdateId,
				reviewedRevision: 1,
			});
			expect(saved._nay).toBeUndefined();
			const unfinished = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				...tenant,
				path: "/unfinished.txt",
				kind: "file",
			});
			if (unfinished._nay || !unfinished._yay.operationBatchId) throw new Error("Expected an unfinished batch");
			expect(
				(
					await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
						...tenant,
						operationBatchId: unfinished._yay.operationBatchId,
						role: "unstaged",
						text: "unsealed input",
					})
				)._nay,
			).toBeUndefined();
			const publication = await t.run((ctx) => create_publication(ctx, db, "failed-save.txt"));
			const deadline = Date.now() + 60_000;
			const assetHold = await t.run(async (ctx) => {
				await ctx.db.patch("files_r2_assets", publication.resource.id, { unfinalizedExpiresAt: deadline });
				return await files_private_storage_db_reserve(ctx, {
					...tenant,
					resource: publication.resource,
					byteCount: 13,
					publicationBatchId: publication.publicationBatchId,
				});
			});
			if (assetHold._nay) throw new Error(assetHold._nay.message);
			const controlFolder = await t.mutation(internal.files_nodes.create_private_node_by_path, {
				organizationId: control.organizationId,
				workspaceId: control.workspaceId,
				userId: control.userId,
				path: "/control",
				kind: "folder",
			});
			if (controlFolder._nay || controlFolder._yay.target.kind !== "private")
				throw new Error("Expected a private control folder");
			const controlNodeId = controlFolder._yay.target.id;
			const before = await t.run(async (ctx) => ({
				states: (await ctx.db.query("files_pending_update_yjs_states").collect()).filter(
					(doc) => doc.userId === db.userId,
				),
				inputs: (await ctx.db.query("files_pending_update_text_inputs").collect()).filter(
					(doc) => doc.userId === db.userId,
				),
				receipts: (await ctx.db.query("files_pending_node_publish_receipts").collect()).filter(
					(doc) => doc.userId === db.userId,
				),
				controlNode: await ctx.db.get("files_pending_nodes", controlNodeId),
			}));
			expect(before.states.length).toBeGreaterThan(0);
			expect(before.inputs).toHaveLength(1);
			expect(before.receipts).toHaveLength(1);
			let requestId: Id<"data_deletion_requests"> | undefined;
			if (scope === "workspace") {
				expect(
					(await asUser.mutation(api.organizations.delete_workspace, { workspaceId: db.workspaceId }))._nay,
				).toBeUndefined();
				requestId = await t.run(
					async (ctx) =>
						(await ctx.db.query("data_deletion_requests").collect()).find(
							(doc) => doc.scope === "workspace" && doc.workspaceId === db.workspaceId,
						)?._id,
				);
				if (!requestId) throw new Error("Expected a workspace deletion request");
			}
			let done = false;
			for (let pass = 0; pass < 200 && !done; pass++) {
				done =
					scope === "user"
						? await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
								userId: db.userId,
								deleteUserRecord: true,
								_test_batchSize: 1,
								_test_disableReschedule: true,
							})
						: (
								await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
									requestId: requestId!,
									_test_batchSize: 1,
								})
							).done;
			}
			expect(done).toBe(true);
			const after = await t.run(async (ctx) => ({
				nodes: (await ctx.db.query("files_pending_nodes").collect()).filter((doc) => doc.userId === db.userId),
				proposals: (await ctx.db.query("files_pending_updates").collect()).filter((doc) => doc.userId === db.userId),
				states: (await ctx.db.query("files_pending_update_yjs_states").collect()).filter(
					(doc) => doc.userId === db.userId,
				),
				inputs: (await ctx.db.query("files_pending_update_text_inputs").collect()).filter(
					(doc) => doc.userId === db.userId,
				),
				batches: (await ctx.db.query("files_pending_update_operation_batches").collect()).filter(
					(doc) => doc.userId === db.userId,
				),
				receipts: (await ctx.db.query("files_pending_node_publish_receipts").collect()).filter(
					(doc) => doc.userId === db.userId,
				),
				controlNode: await ctx.db.get("files_pending_nodes", controlNodeId),
				holds: (await ctx.db.query("files_private_storage_reservations").collect()).filter(
					(doc) => doc.userId === db.userId,
				),
				asset: await ctx.db.get("files_r2_assets", publication.resource.id),
				job: await ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", publication.resource.r2Key))
					.first(),
			}));
			for (const family of [after.nodes, after.proposals, after.states, after.inputs, after.batches, after.receipts])
				expect(family).toEqual([]);
			expect(after.controlNode).toEqual(before.controlNode);
			expect(
				after.holds.filter((hold) => hold.resource.kind !== "asset").every((hold) => hold.settlement.kind !== "held"),
			).toBe(true);
			expect(after.holds.find((hold) => hold._id === assetHold._yay)?.settlement).toEqual({ kind: "held" });
			expect(after.asset).toBeNull();
			expect(after.job?.privateStorageReservationId).toBe(assetHold._yay);
			expect(after.job?.putMayArriveUntil).toBeGreaterThan(deadline);
		},
	);
});

describe("settle_object_deletion_job", () => {
	test.each(["none", "user", "workspace"] as const)(
		"releases once after final deletion, with %s cleanup",
		async (cleanupScope) => {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const resource = await t.run(async (ctx) => create_asset(ctx, db));
			const held = await t.run(async (ctx) =>
				files_private_storage_db_reserve(ctx, { ...db, resource, byteCount: 123 }),
			);
			if (held._nay) throw new Error(held._nay.message);
			const deadline = Date.now() + 60_000;
			await t.run(async (ctx) => {
				await ctx.db.delete("files_r2_assets", resource.id);
				await r2_enqueue_object_deletion_job(ctx, {
					...db,
					r2Key: resource.r2Key,
					reason: "discarded_replacement",
					putMayArriveUntil: deadline,
				});
			});
			const job = await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").unique());
			if (!job) throw new Error("Expected a deletion job");
			expect(job.privateStorageReservationId).toBe(held._yay);
			if (cleanupScope === "user") {
				let done = false;
				for (let pass = 0; pass < 50 && !done; pass++) {
					done = await t.mutation(internal.data_deletion.finalize_user_deletion_data, {
						userId: db.userId,
						deleteUserRecord: true,
						_test_batchSize: 1,
						_test_disableReschedule: true,
					});
				}
				expect(done).toBe(true);
				expect(await t.run(async (ctx) => ctx.db.get("users", db.userId))).toBeNull();
			} else if (cleanupScope === "workspace") {
				const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
				expect(
					(await asUser.mutation(api.organizations.delete_workspace, { workspaceId: db.workspaceId }))._nay,
				).toBeUndefined();
				const request = await t.run(async (ctx) =>
					(await ctx.db.query("data_deletion_requests").collect()).find(
						(doc) => doc.scope === "workspace" && doc.workspaceId === db.workspaceId,
					),
				);
				if (!request) throw new Error("Expected a workspace deletion request");
				let done = false;
				for (let pass = 0; pass < 50 && !done; pass++) {
					done = (
						await t.mutation(internal.data_deletion.process_workspace_deletion_request, {
							requestId: request._id,
							_test_batchSize: 1,
						})
					).done;
				}
				expect(done).toBe(true);
				expect(await t.run(async (ctx) => ctx.db.get("organizations_workspaces", db.workspaceId))).toBeNull();
			}
			vi.mocked(r2_confirmed_object_delete.delete_object).mockRejectedValueOnce(new Error("Storage unavailable"));
			await t.action(internal.r2_client.process_object_deletion_job, { jobId: job._id, generation: job.generation });
			for (const attempt of [
				{ generation: job.generation - 1, deletedAt: deadline },
				{ generation: job.generation, deletedAt: deadline - 1 },
			]) {
				await t.mutation(internal.r2_client.settle_object_deletion_job, { jobId: job._id, ...attempt });
				const hold = await t.run(async (ctx) => ctx.db.get("files_private_storage_reservations", held._yay));
				expect(hold?.settlement).toEqual({ kind: "held" });
				expect(await t.run(async (ctx) => ctx.db.get("quotas", hold!.userQuotaId))).toMatchObject({ usedCount: 123 });
				expect(await t.run(async (ctx) => ctx.db.get("quotas", hold!.workspaceQuotaId!))).toMatchObject({
					usedCount: 123,
				});
			}
			const quotasBeforeRelease = await t.run(async (ctx) => {
				const hold = await ctx.db.get("files_private_storage_reservations", held._yay);
				if (!hold?.workspaceQuotaId) throw new Error("Expected byte quota IDs");
				return [await ctx.db.get("quotas", hold.userQuotaId), await ctx.db.get("quotas", hold.workspaceQuotaId)];
			});
			for (let replay = 0; replay < 2; replay++) {
				await t.mutation(internal.r2_client.settle_object_deletion_job, {
					jobId: job._id,
					generation: job.generation,
					deletedAt: deadline,
				});
			}
			const hold = await t.run(async (ctx) => ctx.db.get("files_private_storage_reservations", held._yay));
			expect(hold?.settlement).toEqual({
				kind: "deleted",
				settledAt: deadline,
				proof: { kind: "r2", jobId: job._id, generation: job.generation },
			});
			for (const quota of quotasBeforeRelease) {
				if (!quota) throw new Error("Expected retained quota");
				const after = await t.run(async (ctx) => ctx.db.get("quotas", quota._id));
				if (quota.retiredAt !== undefined) expect(after).toBeNull();
				else expect(after).toMatchObject({ usedCount: 0 });
			}
			expect(await t.run(async (ctx) => ctx.db.get("files_r2_object_deletion_jobs", job._id))).toBeNull();
			expect(
				(await t.run(async (ctx) => files_private_storage_db_reserve(ctx, { ...db, resource, byteCount: 123 })))._nay
					?.name,
			).toBe("target_changed");
		},
	);
});
