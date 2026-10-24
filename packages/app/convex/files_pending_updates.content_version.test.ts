import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_convex } from "./setup.test.ts";
import {
	mock_pending_updates_storage,
	seed_non_collaborative_file,
	seed_signed_in_file_with_markdown,
	upsert_file_pending_update_internal_for_test,
} from "./files_pending_updates.setup.test.ts";

beforeEach(mock_pending_updates_storage);

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("pending content versions", () => {
	test("refuses late admission from an older read even when no proposal exists", async () => {
		const t = test_convex();
		const file = await t.run((ctx) => seed_non_collaborative_file({ ctx, path: "/late-admission.txt", text: "base" }));
		const admission = {
			organizationId: file.organizationId,
			workspaceId: file.workspaceId,
			userId: file.userId,
			target: { kind: "saved" as const, id: file.nodeId },
			expectedPendingContentVersion: 1,
		};
		await t.run((ctx) => ctx.db.patch("files_nodes", file.nodeId, { pendingContentVersion: 2 }));

		const old = await t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			admission,
		);
		expect(old._nay?.name).toBe("target_changed");
		expect(await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect())).toEqual([]);

		const current = await t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{
				...admission,
				expectedPendingContentVersion: 2,
			},
		);
		expect(current._nay).toBeUndefined();
		const batch = await t.run((ctx) =>
			ctx.db.get("files_pending_update_operation_batches", current._yay!.operationBatchId),
		);
		expect(batch?.expectedPendingContentVersion).toBe(2);
	});

	test("refuses an admitted batch after the saved version changes", async () => {
		const t = test_convex();
		const file = await t.run((ctx) => seed_non_collaborative_file({ ctx, path: "/admitted.txt", text: "base" }));
		const admitted = await t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{
				organizationId: file.organizationId,
				workspaceId: file.workspaceId,
				userId: file.userId,
				target: { kind: "saved", id: file.nodeId },
				expectedPendingContentVersion: 1,
			},
		);
		if (admitted._nay) throw new Error(admitted._nay.message);
		await t.run((ctx) => ctx.db.patch("files_nodes", file.nodeId, { pendingContentVersion: 2 }));
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_state_page_internal, {
			organizationId: file.organizationId,
			workspaceId: file.workspaceId,
			userId: file.userId,
			operationBatchId: admitted._yay.operationBatchId,
			phase: "output",
			role: "base",
			pageIndex: 0,
			bytes: new Uint8Array([1]).buffer,
		});
		expect(staged._nay?.message).toBe("This file changed. Read it again.");
		expect(await t.run((ctx) => ctx.db.query("files_pending_update_yjs_states").collect())).toEqual([]);
	});

	test("hides an old saved marker and keeps its stored doc", async () => {
		const t = test_convex();
		const file = await t.run((ctx) => seed_non_collaborative_file({ ctx, path: "/saved-marker.txt", text: "base" }));
		const markerId = await t.run((ctx) =>
			ctx.db.insert("files_pending_updates_last_sequence_saved", {
				organizationId: file.organizationId,
				workspaceId: file.workspaceId,
				userId: file.userId,
				fileNodeId: file.nodeId,
				lastSequenceSaved: 4,
				pendingContentVersion: 1,
				updatedAt: Date.now(),
			}),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: file.userId, name: "Test User" });
		const args = { membershipId: file.membershipId, nodeId: file.nodeId };
		expect((await asUser.query(api.files_pending_updates.get_file_pending_update_last_sequence_saved, args))?._id).toBe(
			markerId,
		);
		await t.run((ctx) => ctx.db.patch("files_nodes", file.nodeId, { pendingContentVersion: 2 }));
		expect(await asUser.query(api.files_pending_updates.get_file_pending_update_last_sequence_saved, args)).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates_last_sequence_saved", markerId))).not.toBeNull();
		await t.run((ctx) =>
			ctx.db.patch("files_pending_updates_last_sequence_saved", markerId, { pendingContentVersion: 2 }),
		);
		expect((await asUser.query(api.files_pending_updates.get_file_pending_update_last_sequence_saved, args))?._id).toBe(
			markerId,
		);
	});

	test.each([false, true])(
		"refuses a no-batch prepared Save after a reset, collaborative=%s",
		async (collaborative) => {
			const t = test_convex();
			const file = await t.run(async (ctx) =>
				collaborative
					? await seed_signed_in_file_with_markdown({
							ctx,
							path: "/prepared.md",
							name: "prepared.md",
							markdown: "base\n",
						})
					: await seed_non_collaborative_file({ ctx, path: "/prepared.txt", text: "base\n" }),
			);
			const proposed = await upsert_file_pending_update_internal_for_test({
				t,
				...file,
				unstagedMarkdown: "proposed\n",
			});
			expect(proposed._nay).toBeUndefined();
			const source = await t.run(async (ctx) => ({
				node: (await ctx.db.get("files_nodes", file.nodeId))!,
				proposal: (await ctx.db
					.query("files_pending_updates")
					.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", file.nodeId))
					.unique())!,
			}));
			const common = {
				membershipId: file.membershipId,
				nodeId: file.nodeId,
				pendingUpdateId: source.proposal._id,
				reviewedRevision: source.proposal.revision,
				billedUserId: file.userId,
				operationBatchIds: [],
				expectedPendingContentVersion: source.node.pendingContentVersion,
			};
			const prepared = collaborative
				? {
						...common,
						kind: "saved_yjs" as const,
						baseYjsSequence: 0,
						baseLineageGeneration: 0,
						expectedYjsLastSequenceId: source.node.yjsLastSequenceId!,
					}
				: { ...common, kind: "saved_asset" as const, publish: null };
			await t.run((ctx) => ctx.db.patch("files_nodes", file.nodeId, { pendingContentVersion: 2 }));

			const result = await t.mutation(internal.files_pending_updates.commit_prepared_content, {
				userId: file.userId,
				prepared,
			});
			expect(result._nay).toBeDefined();
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", source.proposal._id))).toEqual(source.proposal);
			const current = await t.run((ctx) => ctx.db.get("files_nodes", file.nodeId));
			expect(current?.yjsLastSequenceId).toBe(source.node.yjsLastSequenceId);
			expect(current?.assetId).toBe(source.node.assetId);
		},
	);
});
