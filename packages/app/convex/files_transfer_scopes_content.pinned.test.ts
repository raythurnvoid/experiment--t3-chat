// The later copy_transfer_file scopes tests, from the pinned media checks on, split from
// files_transfer_scopes_content.test.ts so the two files can run at the same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { files_metadata_maps_db_read } from "../server/files-metadata-maps.ts";
import { files_metadata_stringify_entries_yaml } from "../shared/files-metadata.ts";
import {
	test_save_file_pending_update,
	test_create_saved_text_file,
	test_finish_pending_update_run,
	test_finish_transfer_run,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import { r2_create_asset_key } from "./r2_client.ts";
import { files_media_build_file_src, files_media_build_private_src } from "../shared/files-media.ts";
import { files_ROOT_ID, type files_PendingTarget } from "../shared/files.ts";
import {
	objects,
	mock_scope_copy_storage,
	fixture,
	start_copy,
	append_saved_text,
	media_proposal,
	get_proposal,
	save_proposal,
	copy_files,
	media_copy_source,
} from "./files_transfer_scopes_content.setup.test.ts";

beforeEach(mock_scope_copy_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("copy_transfer_file scopes", () => {
	test.each([
		["private", "save"],
		["private", "replace"],
		["private", "save_replacement"],
		["saved", "save"],
		["saved", "replace"],
		["saved", "save_replacement"],
	] as const)(
		"checks the pinned %s media after %s while the document PUT is paused",
		async (destinationKind, change) => {
			const f = await fixture();
			const sources = await media_copy_source(f);
			if (destinationKind === "saved") {
				const existing = await media_proposal({ f, workspace: "personal" });
				expect(await save_proposal({ f, workspace: "personal", target: existing })).toHaveProperty("_yay");
			}
			const otherMedia =
				change === "save" ? null : await media_proposal({ f, workspace: "personal", path: "/different.png" });
			const personalThread = await f.asUser.mutation(api.ai_chat.thread_create, {
				membershipId: f.personal.membershipId,
				clientGeneratedId: "personal-media-edit",
				lastMessageAt: Date.now(),
			});
			if (personalThread._nay) throw new Error(personalThread._nay.message);
			const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
			let savedTarget: files_PendingTarget | null = null;
			let pinnedAssetId: Id<"files_r2_assets"> | null = null;
			let mediaRef: string | null = null;
			vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
				if (!savedTarget && init?.method === "PUT" && typeof init.body === "string" && init.body.includes("![Photo]")) {
					const media = await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
						membershipId: f.personal.membershipId,
						path: "/photo.png",
					});
					if (!media) throw new Error("Expected copied media");
					const target = media.target;
					expect(target.kind).toBe(destinationKind);
					const pending = await get_proposal({ f, workspace: "personal", target });
					const stored =
						pending.pendingReplacement ?? (pending.createIntent?.kind === "stored" ? pending.createIntent : null);
					if (!stored) throw new Error("Expected stored media");
					pinnedAssetId = stored.assetId;
					mediaRef =
						target.kind === "private"
							? files_media_build_private_src(target.id)
							: files_media_build_file_src(target.id);
					expect(init.body).toContain(mediaRef);
					const saved = await save_proposal({ f, workspace: "personal", target });
					if (saved._nay) throw new Error(saved._nay.message);
					savedTarget = saved._yay.target;
					if (otherMedia) {
						// A second chat workspace has its own transfer lane while this PUT is paused.
						const replaced = await copy_files(
							{ ...f, current: f.personal, threadId: personalThread._yay.threadId },
							{
								sources: [otherMedia],
								sourceWorkspace: "current",
								destinationWorkspace: "current",
								targetName: "photo.png",
							},
						);
						expect(replaced[0]).toMatchObject({ state: "completed", outputTarget: savedTarget });
						const replacement = await get_proposal({ f, workspace: "personal", target: savedTarget });
						expect(replacement.pendingReplacement!.assetId).not.toBe(pinnedAssetId);
						if (change === "save_replacement")
							expect(await save_proposal({ f, workspace: "personal", target: savedTarget })).toHaveProperty("_yay");
					}
				}
				return await fetch(input, init);
			});
			const copied = await copy_files(f, { sources, sourceWorkspace: "current", destinationWorkspace: "personal" });
			expect(savedTarget).not.toBeNull();
			if (change !== "save") {
				expect(copied[0]).toMatchObject({
					state: "failed",
					outputTarget: null,
					errorMessage: "The copied media changed while this document was being copied. Try again.",
				});
				return;
			}
			expect(copied[0]).toMatchObject({ state: "completed" });
			expect(await save_proposal({ f, workspace: "personal", target: copied[0]!.outputTarget! })).toHaveProperty(
				"_yay",
			);
		},
	);

	test.each(["current", "personal"] as const)(
		"copies saved %s content into destination-owned proposal states",
		async (sourceWorkspace) => {
			const f = await fixture();
			const destinationWorkspace = sourceWorkspace === "current" ? "personal" : "current";
			const sourceScope = f[sourceWorkspace];
			const destinationScope = f[destinationWorkspace];
			const entries = Array.from({ length: 4 }, (_, i) => ({ key: `key${i}`, value: "x".repeat(32 * 1024 - 16) }));
			const sourceId = await test_create_saved_text_file(f.t, {
				membershipId: sourceScope.membershipId,
				path: "/source.txt",
				textContent: "Saved\n",
			});
			await append_saved_text({
				f,
				membershipId: sourceScope.membershipId,
				nodeId: sourceId,
				text: "Unmaterialized\n",
			});
			expect(
				await f.asUser.mutation(api.files_metadata.set_entries, {
					membershipId: sourceScope.membershipId,
					fileNodeId: sourceId,
					metadataYaml: files_metadata_stringify_entries_yaml(entries),
				}),
			).toEqual({ _yay: null });
			expect(
				await (sourceWorkspace === "current" ? f.asOwner : f.asUser).mutation(api.files_nodes.set_node_write_policy, {
					membershipId: sourceWorkspace === "current" ? f.owner.membershipId : f.personal.membershipId,
					nodeId: sourceId,
					writePolicy: { mode: "read_only" },
				}),
			).toEqual({ _yay: null });
			const copy = await start_copy({
				f,
				source: { kind: "saved", id: sourceId },
				sourceWorkspace,
				destinationWorkspace,
			});
			const data = await f.t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
				itemId: copy.item._id,
				attempt: copy.item.attempt,
			});
			expect(data._yay).toMatchObject({
				sourceScope: { organizationId: sourceScope.organizationId, workspaceId: sourceScope.workspaceId },
				destinationScope: {
					organizationId: destinationScope.organizationId,
					workspaceId: destinationScope.workspaceId,
				},
			});
			expect(data._yay).not.toHaveProperty("organizationId");
			expect(data._yay).not.toHaveProperty("workspaceId");
			const captureMap = await f.t.run((ctx) => files_metadata_maps_db_read(ctx.db, { kind: "capture", id: copy.item._id }));
			expect(captureMap, "The Copy capture owns the full map in the activity scope").toMatchObject({
				organizationId: copy.item.organizationId, workspaceId: copy.item.workspaceId, entries,
			});
			await f.t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: copy.item._id,
				attempt: copy.item.attempt,
			});
			const proposal = await f.t.run(async (ctx) => {
				expect(await ctx.db.get("files_transfer_items", copy.item._id)).toMatchObject({
					state: "completed",
					billedUserId: destinationWorkspace === "current" ? f.owner.userId : f.personal.userId,
				});
				return await ctx.db.get("files_pending_updates", copy.item.preparation!.pendingUpdateId);
			});
			expect(proposal).toMatchObject({
				organizationId: destinationScope.organizationId,
				workspaceId: destinationScope.workspaceId,
				copiedFrom: {
					target: { kind: "saved", id: sourceId },
					path: "/source.txt",
					sourceWritePolicy: { mode: "read_only" },
				},
				threadIds: [f.threadId],
			});
			expect(proposal!.copiedFrom).not.toHaveProperty("sourceNewChildWritePolicy");
			expect((await f.t.run((ctx) => files_metadata_maps_db_read(ctx.db, { kind: "pending", id: proposal!._id })))?.entries,
				"Copy keeps the captured full map in the destination proposal").toEqual(entries);
			expect(
				(
					await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
						organizationId: destinationScope.organizationId,
						workspaceId: destinationScope.workspaceId,
						userId: f.personal.userId,
						subject: { kind: "user", userId: f.personal.userId, plugin: null },
						path: "/copy.txt",
						overlayUserId: f.personal.userId,
					})
				)?.content,
			).toBe("Saved\nUnmaterialized\n");
			await f.t.run(async (ctx) => {
				const states = await ctx.db
					.query("files_pending_update_yjs_states")
					.withIndex("by_owner_pendingUpdate", (q) => q.eq("owner.pendingUpdateId", proposal!._id))
					.collect();
				expect(states).toHaveLength(3);
				for (const state of states) {
					expect(state).toMatchObject({
						organizationId: destinationScope.organizationId,
						workspaceId: destinationScope.workspaceId,
						target: proposal!.target,
					});
					const pages = await ctx.db
						.query("files_pending_update_yjs_state_pages")
						.withIndex("by_state_pageIndex", (q) => q.eq("stateId", state._id))
						.collect();
					for (const page of pages) expect(page.workspaceId).toBe(destinationScope.workspaceId);
					const hold = await ctx.db
						.query("files_private_storage_reservations")
						.withIndex("by_resource", (q) => q.eq("resource.kind", "state").eq("resource.id", state._id))
						.unique();
					expect(hold).toMatchObject({
						organizationId: destinationScope.organizationId,
						workspaceId: destinationScope.workspaceId,
						settlement: { kind: "held" },
					});
				}
				const retired = (await ctx.db.query("files_pending_update_yjs_states").collect()).filter(
					(state) => state.target.kind === "saved" && state.target.id === sourceId && state.owner.kind === "retired",
				);
				expect(retired).toHaveLength(1);
				for (const state of retired) {
					expect(state.workspaceId).toBe(sourceScope.workspaceId);
					if (state.owner.kind !== "retired") throw new Error("Expected retired capture");
					expect(await ctx.db.get("files_pending_update_state_cleanup_tasks", state.owner.cleanupTaskId)).toMatchObject(
						{ workspaceId: sourceScope.workspaceId },
					);
				}
				const assetHolds = (await ctx.db.query("files_private_storage_reservations").collect()).filter(
					(hold) => hold.resource.kind === "asset" && hold.settlement.kind === "held",
				);
				expect(assetHolds).toHaveLength(2);
				for (const hold of assetHolds) expect(hold.workspaceId).toBe(destinationScope.workspaceId);
			});
		},
	);

	test("rebases a personal source draft using personal saved text", async () => {
		const f = await fixture();
		const sourceId = await test_create_saved_text_file(f.t, {
			membershipId: f.personal.membershipId,
			path: "/source.txt",
			textContent: "Saved\nDraft\n",
		});
		const scope = {
			organizationId: f.personal.organizationId,
			workspaceId: f.personal.workspaceId,
			userId: f.personal.userId,
		};
		const target = { kind: "saved" as const, id: sourceId };
		const batch = await f.t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{ ...scope, target },
		);
		if (batch._nay) throw new Error(batch._nay.message);
		for (const role of ["staged", "unstaged"] as const)
			expect(
				await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
					...scope,
					operationBatchId: batch._yay.operationBatchId,
					role,
					text: "Saved\nProposed\n",
				}),
			).toEqual({ _yay: null });
		expect(
			await f.t.action(internal.files_pending_updates.upsert_file_pending_update_internal_action, {
				...scope,
				target,
				operationBatchId: batch._yay.operationBatchId,
			}),
		).toEqual({ _yay: null });
		await append_saved_text({ f, membershipId: f.personal.membershipId, nodeId: sourceId, text: "New saved line\n" });
		const copy = await start_copy({ f, source: target });
		const data = await f.t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		expect(data._nay).toMatchObject({
			name: "source_needs_rebase",
			data: { organizationId: scope.organizationId, workspaceId: scope.workspaceId, savedPath: "/source.txt" },
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id))).toMatchObject({
			state: "completed",
		});
		expect(
			(
				await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					organizationId: f.current.organizationId,
					workspaceId: f.current.workspaceId,
					userId: f.personal.userId,
					subject: { kind: "user", userId: f.personal.userId, plugin: null },
					path: "/copy.txt",
					overlayUserId: f.personal.userId,
				})
			)?.content,
		).toBe("Saved\nProposed\nNew saved line\n");
	});

	test("keeps saved destination mode and uses its own replacement asset", async () => {
		const f = await fixture();
		const sourceId = await test_create_saved_text_file(f.t, {
			membershipId: f.personal.membershipId,
			path: "/source.txt",
			textContent: "Replacement\n",
		});
		const destinationId = await test_create_saved_text_file(f.t, {
			membershipId: f.current.membershipId,
			path: "/copy.txt",
			textContent: "Destination\n",
		});
		expect(
			await f.asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.current.membershipId,
				nodeId: destinationId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toEqual({ _yay: null });
		const source = await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId));
		const destination = await f.t.run((ctx) => ctx.db.get("files_nodes", destinationId));
		const copy = await start_copy({ f, source: { kind: "saved", id: sourceId } });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		await f.t.run(async (ctx) => {
			expect(await ctx.db.get("files_transfer_items", copy.item._id)).toMatchObject({ state: "completed" });
			expect(await ctx.db.get("files_nodes", destinationId)).toEqual(destination);
			const pending = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.personal.userId).eq("target.kind", "saved").eq("target.id", destinationId),
				)
				.first();
			expect(pending).toMatchObject({
				workspaceId: f.current.workspaceId,
				pendingReplacement: { nonCollaborative: true, baseAssetId: destination!.assetId },
				copiedFrom: { target: { kind: "saved", id: sourceId } },
			});
			const asset = await ctx.db.get("files_r2_assets", pending!.pendingReplacement!.assetId);
			expect(asset!._id).not.toBe(source!.assetId);
			expect(asset).toMatchObject({ organizationId: f.current.organizationId, workspaceId: f.current.workspaceId });
			expect(asset!.r2Key).toBe(r2_create_asset_key({ ...f.current, assetId: asset!._id }));
		});
	});

	test("keeps a Copy replacement asset after Move and Save", async () => {
		const f = await fixture();
		const sourceId = await test_create_saved_text_file(f.t, {
			membershipId: f.personal.membershipId,
			path: "/source.txt",
			textContent: "Replacement\n",
		});
		const destinationId = await test_create_saved_text_file(f.t, {
			membershipId: f.current.membershipId,
			path: "/copy.txt",
			textContent: "Destination\n",
		});
		expect(
			await f.asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.current.membershipId,
				nodeId: destinationId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toEqual({ _yay: null });
		const copy = await start_copy({ f, source: { kind: "saved", id: sourceId } });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: copy.claim.workId,
			context: { itemId: copy.item._id, attempt: copy.item.attempt },
			result: { kind: "success", returnValue: null },
		});
		await test_finish_transfer_run(f.asUser, copy.runId);
		const replacement = await get_proposal({ f, workspace: "current", target: { kind: "saved", id: destinationId } });
		if (!replacement.pendingReplacement) throw new Error("Expected the Copy replacement");
		const copiedAsset = {
			assetId: replacement.pendingReplacement.assetId,
			r2Key: r2_create_asset_key({ ...f.current, assetId: replacement.pendingReplacement.assetId }),
		};
		// Move sends this replacement through the real cohort worker.
		expect(
			await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: f.current.organizationId,
				workspaceId: f.current.workspaceId,
				userId: f.current.userId,
				threadId: f.threadId,
				target: { kind: "saved", id: destinationId },
				destParent: { kind: "root" },
				destName: "saved-copy.txt",
			}),
		).toMatchObject({ _yay: { destPath: "/saved-copy.txt", appliedImmediately: false } });
		const proposal = await get_proposal({ f, workspace: "current", target: { kind: "saved", id: destinationId } });
		expect(proposal).toMatchObject({ pendingReplacement: { assetId: copiedAsset.assetId }, pendingMove: {} });
		expect(
			await test_save_file_pending_update(f.asUser, {
				membershipId: f.current.membershipId,
				target: { kind: "saved", id: destinationId },
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			}),
		).toMatchObject({ _yay: { target: { kind: "saved", id: destinationId } } });
		await f.t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", destinationId)).toMatchObject({
				path: "/saved-copy.txt",
				assetId: copiedAsset.assetId,
				collaborationEnabled: false,
			});
			expect(
				await ctx.db.get("files_r2_assets", copiedAsset.assetId),
				"Saving the Copy through Move keeps its exact replacement asset",
			).toMatchObject({ _id: copiedAsset.assetId, r2Key: copiedAsset.r2Key });
			const receipt = await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", copiedAsset.assetId))
				.unique();
			expect(receipt).toMatchObject({
				settlement: { kind: "saved", savedNodeId: destinationId },
				cohortContentId: expect.any(String),
			});
			expect(
				await ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", copiedAsset.r2Key))
					.unique(),
			).toBeNull();
			expect(await ctx.db.get("files_pending_updates", proposal._id)).toBeNull();
		});
	}, 120_000);

	test("cleans a Copy replacement asset when a selected Delete frees a Move destination", async () => {
		const f = await fixture();
		const sourceId = await test_create_saved_text_file(f.t, {
			membershipId: f.personal.membershipId,
			path: "/source.txt",
			textContent: "Replacement\n",
		});
		const destinationId = await test_create_saved_text_file(f.t, {
			membershipId: f.current.membershipId,
			path: "/copy.txt",
			textContent: "Destination\n",
		});
		const movedId = await test_create_saved_text_file(f.t, {
			membershipId: f.current.membershipId,
			path: "/moved.txt",
			textContent: "Moved\n",
		});
		expect(
			await f.asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.current.membershipId,
				nodeId: destinationId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toEqual({ _yay: null });
		const destination = await f.t.run((ctx) => ctx.db.get("files_nodes", destinationId));
		if (!destination?.assetId) throw new Error("Expected the saved destination asset");
		const copy = await start_copy({ f, source: { kind: "saved", id: sourceId } });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: copy.claim.workId,
			context: { itemId: copy.item._id, attempt: copy.item.attempt },
			result: { kind: "success", returnValue: null },
		});
		await test_finish_transfer_run(f.asUser, copy.runId);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", destinationId))).toEqual(destination);
		const replacement = await get_proposal({ f, workspace: "current", target: { kind: "saved", id: destinationId } });
		if (!replacement.pendingReplacement) throw new Error("Expected the Copy replacement");
		const assetId = replacement.pendingReplacement.assetId;
		const r2Key = r2_create_asset_key({ ...f.current, assetId });
		const asset = await f.t.run((ctx) => ctx.db.get("files_r2_assets", assetId));
		expect(asset).toMatchObject({ r2Key });
		expect(asset?.unfinalizedExpiresAt).toBeUndefined();
		const reservation = await f.t.run((ctx) =>
			ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", assetId))
				.unique(),
		);
		if (!reservation) throw new Error("Expected the replacement storage hold");
		expect(reservation.settlement).toEqual({ kind: "held" });
		const scope = {
			organizationId: f.current.organizationId,
			workspaceId: f.current.workspaceId,
			userId: f.current.userId,
			threadId: f.threadId,
		};
		expect(
			await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, {
				...scope,
				target: { kind: "saved", id: destinationId },
			}),
		).toMatchObject({ _yay: { outcome: "proposed" } });
		expect(
			await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				...scope,
				target: { kind: "saved", id: movedId },
				destParent: { kind: "root" },
				destName: "copy.txt",
			}),
		).toMatchObject({ _yay: { destPath: "/copy.txt", appliedImmediately: false } });
		const deleted = await get_proposal({ f, workspace: "current", target: { kind: "saved", id: destinationId } });
		const moved = await get_proposal({ f, workspace: "current", target: { kind: "saved", id: movedId } });
		expect(deleted).toMatchObject({ pendingArchive: { fromPath: "/copy.txt" }, pendingReplacement: { assetId } });
		const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: f.current.membershipId,
			requestId: "delete-copy-replacement",
			kind: "accept",
			expectedItemCount: 2,
			items: [moved, deleted].map((proposal) => ({
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: null,
			})),
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.asUser.mutation(api.files_pending_update_runs.seal, {
				membershipId: f.current.membershipId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		await test_finish_pending_update_run(f.asUser, started._yay.runId);
		const review = await f.asUser.query(api.files_pending_update_runs.get, {
			membershipId: f.current.membershipId,
			runId: started._yay.runId,
		});
		expect(review?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2, blocked: 0 } });
		expect(review?.run.unitCount).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", movedId))).toMatchObject({
			path: "/copy.txt",
			archiveOperationId: null,
		});
		const archived = await f.t.run((ctx) => ctx.db.get("files_nodes", destinationId));
		expect(archived).toMatchObject({ archiveOperationId: expect.any(String), assetId: destination.assetId });
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", deleted._id))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", moved._id))).toBeNull();
		const job = await f.t.run((ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", r2Key))
				.unique(),
		);
		expect(job, "Accepting the selected Delete queues its exact replacement asset for cleanup").toMatchObject({
			organizationId: f.current.organizationId,
			workspaceId: f.current.workspaceId,
			r2Key,
			reason: "discarded_replacement",
			privateStorageReservationId: reservation._id,
		});
		expect(
			await f.t.run((ctx) => ctx.db.get("files_r2_assets", assetId)),
			"The consumed replacement asset loses its database doc",
		).toBeNull();
		// Its bytes stay charged until the R2 deletion is confirmed.
		const held = await f.t.run((ctx) => ctx.db.get("files_private_storage_reservations", reservation._id));
		expect(held?.settlement).toEqual({ kind: "held" });
	}, 120_000);

	test("checks the personal destination plan before copying stored team bytes", async () => {
		const f = await fixture();
		const source = await f.asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: f.current.membershipId,
			parentId: files_ROOT_ID,
			filename: "source.bin",
			contentType: "application/octet-stream",
			size: 3,
		});
		if (source._nay) throw new Error(source._nay.message);
		const key = r2_create_asset_key({ ...f.current, assetId: source._yay.assetId });
		objects.set(key, new Uint8Array([1, 2, 3]));
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", source._yay.assetId, { r2Key: key, unfinalizedExpiresAt: undefined });
			await test_mocks_fill_db_with.plan(ctx, { userId: f.personal.userId, plan: "Free" });
		});
		const before = vi.mocked(globalThis.fetch).mock.calls.length;
		const beforeQuotas = await f.t.run((ctx) => ctx.db.query("quotas").collect());
		await expect(
			start_copy({
				f,
				source: { kind: "saved", id: source._yay.nodeId },
				sourceWorkspace: "current",
				destinationWorkspace: "personal",
			}),
		).rejects.toThrow("This workspace's plan does not include file uploads");
		expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(before);
		expect(await f.t.run((ctx) => ctx.db.query("files_transfer_items").first())).toMatchObject({
			state: "failed",
			errorMessage: "This workspace's plan does not include file uploads",
		});
		expect(await f.t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toHaveLength(1);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_nodes").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("quotas").collect())).toEqual(beforeQuotas);
	});

	test("cleans source captures and destination allocations in their own scopes after a storage refusal", async () => {
		const f = await fixture();
		const sourceId = await test_create_saved_text_file(f.t, {
			membershipId: f.current.membershipId,
			path: "/source.txt",
			textContent: "Captured text\n",
		});
		const copy = await start_copy({
			f,
			source: { kind: "saved", id: sourceId },
			sourceWorkspace: "current",
			destinationWorkspace: "personal",
		});
		const data = await f.t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		if (!data._yay?.asset || !data._yay.yjsSnapshotAsset) throw new Error("Missing source assets");
		const source = data._yay;
		const staged = await f.t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
			...copy.claim,
			contentSize: source.asset!.size,
			yjsSnapshotSize: source.yjsSnapshotAsset!.size,
		});
		if (!staged._yay) throw new Error("Missing staged assets");
		expect(
			await f.t.mutation(internal.files_nodes_content.seal_transfer_file_capture, {
				...copy.claim,
				...staged._yay,
				text: "Captured text\n",
			}),
		).toEqual({ _yay: null });

		await f.t.run(async (ctx) => {
			const hold = await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", staged._yay!.contentAssetId))
				.unique();
			const quota = await ctx.db.get("quotas", hold!.workspaceQuotaId!);
			// Allow the empty base, then refuse the copied staged state.
			await ctx.db.patch("quotas", quota!._id, { maxCount: quota!.usedCount + 2 });
		});
		const finalized = await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, {
			...copy.claim,
			...staged._yay,
			text: "Captured text\n",
		});
		expect(finalized._nay).toMatchObject({ name: "storage_full" });
		await f.t.mutation(internal.files_nodes_content.discard_transfer_file_attempt, {
			...copy.claim,
			message: finalized._nay!.message,
		});
		await f.t.run(async (ctx) => {
			const capturedStates = (await ctx.db.query("files_pending_update_yjs_states").collect()).filter(
				(state) =>
					state.owner.kind === "retired" &&
					(state.target.id === sourceId || state.target.id === copy.item.preparation!.privateNodeId),
			);
			expect(capturedStates).toHaveLength(2);
			expect(new Set(capturedStates.map((state) => state.workspaceId))).toEqual(
				new Set([f.current.workspaceId, f.personal.workspaceId]),
			);
			for (const state of capturedStates) {
				if (state.owner.kind !== "retired") throw new Error("Expected retired capture");
				expect(await ctx.db.get("files_pending_update_state_cleanup_tasks", state.owner.cleanupTaskId)).toMatchObject({
					organizationId: state.organizationId,
					workspaceId: state.workspaceId,
				});
			}
			const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
			expect(jobs).toHaveLength(2);
			for (const assetId of [staged._yay!.contentAssetId, staged._yay!.yjsSnapshotAssetId!]) {
				expect(await ctx.db.get("files_r2_assets", assetId)).toBeNull();
				expect(jobs).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							organizationId: f.personal.organizationId,
							workspaceId: f.personal.workspaceId,
							r2Key: r2_create_asset_key({ ...f.personal, assetId }),
						}),
					]),
				);
				const hold = await ctx.db
					.query("files_private_storage_reservations")
					.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", assetId))
					.unique();
				expect(hold).toMatchObject({ workspaceId: f.personal.workspaceId, settlement: { kind: "held" } });
			}
			expect(await ctx.db.get("files_r2_assets", source.asset!._id)).toEqual(source.asset);
			expect(await ctx.db.get("files_r2_assets", source.yjsSnapshotAsset!._id)).toEqual(source.yjsSnapshotAsset);
		});
	});
});
