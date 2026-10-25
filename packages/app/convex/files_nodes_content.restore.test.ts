// The cleanup, materialize, restore and replacement tests, split from files_nodes_content.test.ts so the two
// files can run at the same time.
import { R2 } from "@convex-dev/r2";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyUpdate, Doc as YjsDoc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { api, components, internal } from "./_generated/api.js";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_pending_update_run,
	test_get_file_yjs_pointers,
	test_mocks_fill_db_with,
	test_run_with_flush,
	test_spy_move_ranges,
} from "./setup.test.ts";
import { r2_confirmed_object_delete, r2_server_side_copy } from "./r2_client.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_ROOT_ID,
	files_u8_to_array_buffer,
	files_YJS_DOC_KEYS,
} from "../shared/files.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { quotas_db_ensure } from "./quotas.ts";
import { files_media_validation_db_capture_versions } from "./files_media_validation.ts";
import { files_updated_by_db_delete_for_node } from "./files_updated_by.ts";
import type { Id } from "./_generated/dataModel.js";
import {
	objects,
	mock_nodes_content_storage,
	create_file_fixture,
	prepare_agent_replacement,
	accept_through_review_run,
	create_pending_proposal,
	expect_retired_uploads,
} from "./files_nodes_content.setup.test.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

beforeEach(mock_nodes_content_storage);

describe("cleanup_file_yjs_task", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	test("bounded cleanup retires before new history and a late task cannot delete the next OFF history", async () => {
		const { t, db, asUser, nodeId, pointers } = await create_file_fixture();
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.patch("files_yjs_snapshots", pointers.yjsSnapshotId, { sequence: 64 });
			await ctx.db.patch("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId, { lastSequence: 64 });
			await Promise.all(
				Array.from({ length: 64 }, (_, index) =>
					ctx.db.insert("files_yjs_updates", {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						fileNodeId: nodeId,
						sequence: index + 1,
						update: new Uint8Array([0, 0]).buffer,
						origin: { type: "USER_EDIT", sessionId: "old-history" },
						createdBy: db.userId,
						createdAt: Date.now(),
					}),
				),
			);
		});
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const task = await t.run(async (ctx) => ctx.db.query("files_yjs_cleanup_tasks").first());
		if (!task) throw new Error("Missing cleanup task");
		expect(
			await asUser.query(api.files_nodes_content.get_file_collaboration_cleanup_state, {
				membershipId: db.membershipId,
				nodeId,
			}),
		).toBe(true);

		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		expect(await t.run(async (ctx) => ctx.db.query("files_yjs_updates").collect())).toHaveLength(32);
		expect(
			(
				await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: db.membershipId,
					nodeId,
				})
			)._nay?.message,
		).toContain("old collaboration history");
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		expect(await t.run(async (ctx) => ctx.db.query("files_yjs_updates").collect())).toHaveLength(0);
		expect(
			await asUser.query(api.files_nodes_content.get_file_collaboration_cleanup_state, {
				membershipId: db.membershipId,
				nodeId,
			}),
		).toBe(false);

		// The final full batch leaves the task pending. ON retires it without waiting for R2.
		expect((await t.run((ctx) => ctx.db.get("files_yjs_cleanup_tasks", task._id)))?.historyPending).toBe(true);
		expect(
			(
				await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: db.membershipId,
					nodeId,
				})
			)._nay,
		).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get("files_yjs_cleanup_tasks", task._id)))?.historyPending).toBe(false);
		const fresh = await test_get_file_yjs_pointers(t, nodeId);
		const editor = new YjsDoc();
		editor.getText(files_YJS_DOC_KEYS.plainText).insert(0, "New edit\n");
		expect(
			(
				await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: fresh.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor)),
					sessionId: "new-history",
				})
			)._nay,
		).toBeUndefined();
		editor.destroy();
		await t.mutation(internal.files_nodes_content.mark_file_content_too_large, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			nodeId,
			userId: db.userId,
			expectedYjsLastSequenceId: fresh.yjsLastSequenceId,
			sequence: 1,
			targetSequence: 1,
			byteSize: files_MAX_TEXT_CONTENT_BYTES + 1,
		});
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();

		// Both documents are now off. Only the retired task flag protects the newer update.
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		await t.run(async (ctx) => {
			expect((await ctx.db.query("files_yjs_updates").collect()).map((update) => update.sequence)).toEqual([1]);
			expect(await ctx.db.get("files_yjs_cleanup_tasks", task._id)).toBeNull();
			const deletion = await ctx.db.query("files_r2_object_deletion_jobs").first();
			expect(deletion?.putMayArriveUntil).toBe(task.putMayArriveUntil);
		});
	});

	test("the final ON mutation refuses remaining old history", async () => {
		const { t, db, asUser, nodeId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const before = await t.run(async (ctx) => {
			await ctx.db.insert("files_yjs_updates", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				sequence: 0,
				update: new Uint8Array([0, 0]).buffer,
				origin: { type: "USER_EDIT", sessionId: "old-history" },
				createdBy: db.userId,
				createdAt: Date.now(),
			});
			const node = await ctx.db.get("files_nodes", nodeId);
			if (!node?.assetId) throw new Error("Missing content asset");
			return { ...node, assetId: node.assetId };
		});
		const [yjsSnapshotAssetId, contentSnapshotAssetId] = await Promise.all(
			(["yjs_snapshot", "content_snapshot"] as const).map((kind) =>
				t.mutation(internal.r2_assets.insert_asset, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					createdBy: db.userId,
					kind,
					size: 14,
				}),
			),
		);
		const finalized = await asUser.mutation(internal.files_nodes_content.finalize_file_collaboration_enable, {
			membershipId: db.membershipId,
			nodeId,
			text: "Original text\n",
			textSize: 14,
			baseAssetId: before.assetId,
			yjsSnapshotAssetId,
			yjsSnapshotSize: 14,
			contentSnapshotAssetId,
		});
		expect(finalized._nay?.message).toContain("old collaboration history");
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(before);
	});

	test("restore checks old history before creating a fresh text document", async () => {
		const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const storedVersionId = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_snapshots", snapshotId);
			if (!snapshot) throw new Error("Missing snapshot");
			return await ctx.db.insert("files_snapshots", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				assetId: snapshot.assetId,
				createdBy: db.userId,
				archivedAt: 0,
				contentType: "application/octet-stream",
				yjsRootKind: null,
				collaborationEnabled: false,
			});
		});
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
			const body = objects.get(args.sourceKey);
			if (body === undefined) throw new Error("Missing source object");
			objects.set(args.destinationKey, body);
			return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "copied" };
		});
		expect(
			(
				await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId: storedVersionId,
					sessionId: "restore-stored",
				})
			)._nay,
		).toBeUndefined();
		const before = await t.run(async (ctx) => {
			await ctx.db.insert("files_yjs_updates", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				sequence: 0,
				update: new Uint8Array([0, 0]).buffer,
				origin: { type: "USER_EDIT", sessionId: "old-history" },
				createdBy: db.userId,
				createdAt: Date.now(),
			});
			return await ctx.db.get("files_nodes", nodeId);
		});
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
			sessionId: "restore-text",
		});
		expect(restored._nay?.message).toContain("old collaboration history");
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(before);
	});

	test("two ON finalizations publish only one document", async () => {
		const { t, db, asUser, nodeId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const results = await Promise.all(
			[0, 1].map(() =>
				asUser.action(api.files_nodes_content.set_file_collaborative, { membershipId: db.membershipId, nodeId }),
			),
		);
		expect(results.filter((result) => result._nay === undefined)).toHaveLength(1);
		expect(results.find((result) => result._nay)?._nay?.message).toContain("already collaborative");
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_yjs_snapshots").collect()).toHaveLength(1);
			expect(await ctx.db.query("files_yjs_docs_last_sequences").collect()).toHaveLength(1);
		});
	});

	test("set_file_non_collaborative syncs the updater sort doc", async () => {
		const { t, db, asUser, nodeId } = await create_file_fixture();
		await t.run(async (ctx) => {
			await files_updated_by_db_delete_for_node(ctx, { nodeId });
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc).toBeNull();
		});

		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc, "set_file_non_collaborative syncs the updater doc").toMatchObject({
				userId: node?.updatedBy,
				name: node?.name,
				parentId: node?.parentId,
				nodeKind: node?.kind,
			});
			expect(doc?.archiveOperationId).toBeUndefined();
		});
	});

	test("finalize_file_collaboration_enable syncs the updater sort doc", async () => {
		const { t, db, asUser, nodeId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		// Delete after the OFF step, so only the ON step can bring the doc back.
		await t.run(async (ctx) => {
			await files_updated_by_db_delete_for_node(ctx, { nodeId });
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc).toBeNull();
		});

		// `set_file_collaborative` reaches the writer through `finalize_file_collaboration_enable`.
		expect(
			(await asUser.action(api.files_nodes_content.set_file_collaborative, { membershipId: db.membershipId, nodeId }))
				._nay,
		).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc, "finalize_file_collaboration_enable syncs the updater doc").toMatchObject({
				userId: node?.updatedBy,
				name: node?.name,
				parentId: node?.parentId,
				nodeKind: node?.kind,
			});
			expect(doc?.archiveOperationId).toBeUndefined();
		});
	});

	test("asset-only cleanup preserves an asset referenced by a live snapshot", async () => {
		const { t, db, nodeId, pointers } = await create_file_fixture();
		const task = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			if (!snapshot) throw new Error("Missing snapshot");
			const taskId = await ctx.db.insert("files_yjs_cleanup_tasks", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				fileNodeId: nodeId,
				throughSequence: 0,
				supersededYjsAssetId: snapshot.assetId,
				putMayArriveUntil: null,
				historyPending: false,
			});
			return { taskId, assetId: snapshot.assetId };
		});
		await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task.taskId });
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_yjs_cleanup_tasks", task.taskId)).toBeNull();
			expect(await ctx.db.get("files_r2_assets", task.assetId)).not.toBeNull();
			expect(await ctx.db.query("files_r2_object_deletion_jobs").collect()).toHaveLength(0);
		});
	});
});

describe("materialize_file_content and restore_snapshot_r2", () => {
	test.each([false, true])(
		"overlapping downloads and restore keep the latest edit (restore changes text: %s)",
		async (changesText) => {
			const t = test_convex();
			const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
			const originalText = "Original text\n";
			const editedText = "Original text\nEdit during restore\nSecond edit\n";
			const nodeId = await test_create_saved_text_file(t, {
				membershipId: db.membershipId,
				path: "/review-restore.txt",
				textContent: originalText,
			});
			const pointers = await test_get_file_yjs_pointers(t, nodeId);
			const before = await t.run(async (ctx) => {
				const snapshot = await ctx.db
					.query("files_snapshots")
					.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
					)
					.first();
				const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
				if (!snapshot || !yjsSnapshot) throw new Error("Missing created snapshots");
				const asset = await ctx.db.get("files_r2_assets", yjsSnapshot.assetId);
				if (!asset?.r2Key) throw new Error("Missing created Yjs object");
				return { snapshotId: snapshot._id, yjsKey: asset.r2Key };
			});

			// Use the live document's structs, as an open editor does.
			const editor = new YjsDoc();
			const originalYjs = objects.get(before.yjsKey);
			if (!originalYjs) throw new Error("Missing Yjs bytes");
			applyUpdate(editor, new Uint8Array(await new Response(originalYjs).arrayBuffer()));
			if (changesText) {
				const beforeEdit = encodeStateVector(editor);
				editor.getText(files_YJS_DOC_KEYS.plainText).insert(0, "Remove this line\n");
				const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
					sessionId: "before-restore",
				});
				if (pushed._nay) throw new Error(pushed._nay.message);
				const materialized = await asUser.action(api.r2.create_signed_download_url, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
				});
				if (materialized._nay) throw new Error(materialized._nay.message);
				await t.mutation(components.rate_limiter.lib.resetRateLimit, { name: "files_yjs_push_update", key: db.userId });
			}
			const expectedText = (changesText ? "Remove this line\n" : "") + editedText;
			const stateVector = encodeStateVector(editor);
			const text = editor.getText(files_YJS_DOC_KEYS.plainText);
			text.insert(text.length, "Edit during restore\n");
			const edit = files_u8_to_array_buffer(encodeStateAsUpdate(editor, stateVector));

			// Pause the restore's two PUTs after its read and diff are finished.
			const uploadsStarted = Promise.withResolvers<void>();
			const releaseUploads = Promise.withResolvers<void>();
			const oldYjsPutStarted = Promise.withResolvers<void>();
			const releaseOldYjsPut = Promise.withResolvers<void>();
			const fetchMock = vi.mocked(globalThis.fetch);
			const baseFetch = fetchMock.getMockImplementation();
			if (!baseFetch) throw new Error("Missing R2 stub");
			let pausedUploads = 0;
			let pausedYjsPut = false;
			fetchMock.mockImplementation(async (input, init) => {
				if (init?.method === "PUT" && typeof init.body === "string" && pausedUploads < 2) {
					pausedUploads += 1;
					if (pausedUploads === 2) uploadsStarted.resolve();
					await releaseUploads.promise;
				}
				if (init?.method === "PUT" && init.body instanceof ArrayBuffer && !pausedYjsPut) {
					pausedYjsPut = true;
					oldYjsPutStarted.resolve();
					await releaseOldYjsPut.promise;
				}
				return await baseFetch(input, init);
			});

			const restoring = asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: before.snapshotId,
				sessionId: "review-restore",
			});
			await uploadsStarted.promise;
			try {
				const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: edit,
					sessionId: "review-other-editor",
				});
				if (pushed._nay) throw new Error(pushed._nay.message);
				// Downloads call the materializer outside its single-worker pool.
				const firstDownload = asUser.action(api.r2.create_signed_download_url, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
				});
				await oldYjsPutStarted.promise;
				try {
					const nextVector = encodeStateVector(editor);
					text.insert(text.length, "Second edit\n");
					const secondPush = await asUser.mutation(api.files_nodes.yjs_push_update, {
						membershipId: db.membershipId,
						nodeId,
						expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
						update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, nextVector)),
						sessionId: "review-other-editor",
					});
					if (secondPush._nay) throw new Error(secondPush._nay.message);
					const secondDownload = await asUser.action(api.r2.create_signed_download_url, {
						membershipId: db.membershipId,
						fileNodeId: nodeId,
					});
					if (secondDownload._nay) throw new Error(secondDownload._nay.message);
					const savedKey = await t.run(async (ctx) => {
						const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
						return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
					});
					const savedYjs = objects.get(savedKey);
					if (!savedYjs) throw new Error("Missing saved Yjs bytes");
					const savedDoc = new YjsDoc();
					applyUpdate(savedDoc, new Uint8Array(await new Response(savedYjs).arrayBuffer()));
					expect(savedDoc.getText(files_YJS_DOC_KEYS.plainText).toString()).toBe(expectedText);
					savedDoc.destroy();
				} finally {
					releaseOldYjsPut.resolve();
				}
				const firstDownloadResult = await firstDownload;
				if (firstDownloadResult._nay) throw new Error(firstDownloadResult._nay.message);
				const liveKey = await t.run(async (ctx) => {
					const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
					return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
				});
				const liveBytes = objects.get(liveKey);
				if (!liveBytes) throw new Error("Missing live Yjs bytes");
				const liveDoc = new YjsDoc();
				applyUpdate(liveDoc, new Uint8Array(await new Response(liveBytes).arrayBuffer()));
				// The older worker must not replace the newer worker's saved object.
				expect.soft(liveDoc.getText(files_YJS_DOC_KEYS.plainText).toString()).toBe(expectedText);
				liveDoc.destroy();
			} finally {
				editor.destroy();
				releaseOldYjsPut.resolve();
				releaseUploads.resolve();
			}

			const result = await restoring;
			fetchMock.mockImplementation(baseFetch);
			expect(pausedUploads).toBe(2);
			const after = await t.run(async (ctx) => {
				const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
				const sequence = await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId);
				const stages = await ctx.db.query("files_yjs_trusted_update_stages").collect();
				return { snapshotSequence: snapshot?.sequence, lastSequence: sequence?.lastSequence, stages };
			});
			const lastSequence = changesText ? 3 : 2;
			expect(after).toMatchObject({ snapshotSequence: lastSequence, lastSequence });
			expect(after.stages).toHaveLength(changesText ? 1 : 0);
			// A refused, unconsumed restore update is removed by the trusted-stage expiry job.
			for (const stage of after.stages) expect(stage.expiresAt).toBeGreaterThan(Date.now());
			await expect_retired_uploads(t, 4);
			const read = await asUser.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				subject: { kind: "user", userId: db.userId, plugin: null },
				path: "/review-restore.txt",
			});
			expect.soft(result._nay?.message).toBe("This file changed while the snapshot was being restored. Try again.");
			expect.soft(read?.content).toBe(expectedText);
		},
	);
});

describe("materialize_file_content", () => {
	test("two workers for the same counter publish once and retire the unused uploads", async () => {
		const { t, scope, nodeId, pointers } = await create_file_fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fetchMock = vi.mocked(globalThis.fetch);
		const baseFetch = fetchMock.getMockImplementation()!;
		let paused = false;
		fetchMock.mockImplementation(async (input, init) => {
			if (init?.method === "PUT" && init.body instanceof ArrayBuffer && !paused) {
				paused = true;
				started.resolve();
				await release.promise;
			}
			return baseFetch(input, init);
		});
		const first = t.action(internal.files_nodes_content.materialize_file_content, {
			...scope,
			nodeId,
			targetSequence: 0,
		});
		await started.promise;
		try {
			const second = await t.action(internal.files_nodes_content.materialize_file_content, {
				...scope,
				nodeId,
				targetSequence: 0,
			});
			expect(second._nay).toBeUndefined();
		} finally {
			release.resolve();
		}
		expect((await first)._nay).toBeUndefined();
		expect(await test_get_file_yjs_pointers(t, nodeId)).toEqual(pointers);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_snapshots").collect()).toHaveLength(2);
		});
		await expect_retired_uploads(t, 2);
	});

	test("a worker paused before OFF and ON cannot publish into the new document", async () => {
		const { t, db, asUser, scope, nodeId, pointers } = await create_file_fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fetchMock = vi.mocked(globalThis.fetch);
		const baseFetch = fetchMock.getMockImplementation()!;
		let paused = false;
		fetchMock.mockImplementation(async (input, init) => {
			if (init?.method === "PUT" && init.body instanceof ArrayBuffer && !paused) {
				paused = true;
				started.resolve();
				await release.promise;
			}
			return baseFetch(input, init);
		});
		const materializing = t.action(internal.files_nodes_content.materialize_file_content, {
			...scope,
			nodeId,
			targetSequence: 0,
		});
		await started.promise;
		try {
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
				membershipId: db.membershipId,
				nodeId,
			});
			expect(on._nay).toBeUndefined();
			const newPointers = await test_get_file_yjs_pointers(t, nodeId);
			expect(newPointers.yjsLastSequenceId).not.toBe(pointers.yjsLastSequenceId);
			const before = await t.run(async (ctx) => ({
				node: await ctx.db.get("files_nodes", nodeId),
				snapshot: await ctx.db.get("files_yjs_snapshots", newPointers.yjsSnapshotId),
			}));
			release.resolve();
			expect((await materializing)._nay).toBeUndefined();
			await t.run(async (ctx) => {
				expect(await ctx.db.get("files_nodes", nodeId)).toEqual(before.node);
				expect(await ctx.db.get("files_yjs_snapshots", newPointers.yjsSnapshotId)).toEqual(before.snapshot);
			});
			await expect_retired_uploads(t, 2);
		} finally {
			release.resolve();
		}
	});
});

describe("restore_snapshot_r2", () => {
	test.each(["Free", "full"] as const)("refuses stored restore on %s before allocating assets", async (state) => {
		vi.useFakeTimers();
		const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
		await t.run(async (ctx) => {
			await ctx.db.patch("files_snapshots", snapshotId, { yjsRootKind: null, collaborationEnabled: false });
			if (state === "Free") await test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" });
			else {
				const quotaId = await quotas_db_ensure(ctx, { ...db, quotaName: "stored_file_bytes", now: Date.now() });
				await ctx.db.patch("quotas", quotaId, { usedCount: 10, maxCount: 10 });
			}
		});
		const before = await t.run(async (ctx) => ({
			assets: await ctx.db.query("files_r2_assets").collect(),
			quotas: await ctx.db.query("quotas").collect(),
			node: await ctx.db.get("files_nodes", nodeId),
		}));
		const result = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
			sessionId: "stored-refusal",
		});
		expect(result._nay?.name).toBe(state === "Free" ? "plan_required" : "storage_full");
		expect(
			await t.run(async (ctx) => ({
				assets: await ctx.db.query("files_r2_assets").collect(),
				quotas: await ctx.db.query("quotas").collect(),
				node: await ctx.db.get("files_nodes", nodeId),
			})),
		).toEqual(before);
	});

	test("stored restore bills two cents for 20 MiB plus one byte and counts it once", async () => {
		vi.useFakeTimers();
		const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const size = 20 * 1024 * 1024 + 1;
		await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_snapshots", snapshotId);
			await ctx.db.patch("files_snapshots", snapshotId, { yjsRootKind: null, collaborationEnabled: false });
			await ctx.db.patch("files_r2_assets", snapshot!.assetId, { size });
		});
		vi.spyOn(r2_server_side_copy, "copy_object").mockResolvedValue({ outcome: "copied", size, etag: "stored-version" });
		const before = await t.run((ctx) => ctx.db.query("billing_usage_snapshots").first());
		const result = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
			sessionId: "stored-charge",
		});
		expect(result._nay).toBeUndefined();
		const after = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", nodeId),
			quota: await ctx.db
				.query("quotas")
				.withIndex("by_workspace_quotaName", (q) =>
					q.eq("workspaceId", db.workspaceId).eq("quotaName", "stored_file_bytes"),
				)
				.first(),
			usage: await ctx.db.query("billing_usage_snapshots").first(),
		}));
		expect(after.quota?.usedCount).toBe(size);
		expect(after.usage?.meter?.balance).toBe(before!.meter!.balance - 2);
		await asUser.mutation(internal.files_nodes_content.finalize_snapshot_restore_replacement, {
			membershipId: db.membershipId,
			billedUserId: db.userId,
			nodeId,
			snapshotId,
			expectedAssetId: after.node!.assetId!,
			contentAssetId: after.node!.assetId!,
			contentSize: size,
			contentType: "application/octet-stream",
		});
		expect(await t.run((ctx) => ctx.db.get("quotas", after.quota!._id))).toEqual(after.quota);
		expect(await t.run((ctx) => ctx.db.query("billing_usage_snapshots").first())).toEqual(after.usage);
	});

	test("a full stored-file cap still allows a text snapshot restore", async () => {
		vi.useFakeTimers();
		const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
		await t.run(async (ctx) => {
			const quotaId = await quotas_db_ensure(ctx, { ...db, quotaName: "stored_file_bytes", now: Date.now() });
			await ctx.db.patch("quotas", quotaId, { maxCount: 0 });
		});
		expect(
			(
				await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId,
					sessionId: "text-full-cap",
				})
			)._nay,
		).toBeUndefined();
	});

	test("restore_snapshot syncs the updater sort doc", async () => {
		vi.useFakeTimers();
		const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
		await t.run(async (ctx) => {
			await files_updated_by_db_delete_for_node(ctx, { nodeId });
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc).toBeNull();
		});

		// A same-shape text version on a collaborative file goes through `restore_snapshot`.
		expect(
			(
				await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId,
					sessionId: "restore-sync",
				})
			)._nay,
		).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc, "restore_snapshot syncs the updater doc").toMatchObject({
				userId: node?.updatedBy,
				name: node?.name,
				parentId: node?.parentId,
				nodeKind: node?.kind,
			});
			expect(doc?.archiveOperationId).toBeUndefined();
		});
	});

	test("db_install_file_content_replacement syncs the updater sort doc", async () => {
		vi.useFakeTimers();
		const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		const size = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_snapshots", snapshotId);
			await ctx.db.patch("files_snapshots", snapshotId, { yjsRootKind: null, collaborationEnabled: false });
			return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.size;
		});
		vi.spyOn(r2_server_side_copy, "copy_object").mockResolvedValue({ outcome: "copied", size, etag: "stored-sync" });
		// Delete after the OFF step, so only the restore can bring the doc back.
		await t.run(async (ctx) => {
			await files_updated_by_db_delete_for_node(ctx, { nodeId });
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc).toBeNull();
		});

		// A stored version goes through `finalize_snapshot_restore_replacement`, which installs it.
		expect(
			(
				await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId,
					sessionId: "stored-sync",
				})
			)._nay,
		).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			// Only the install path turns the file into stored bytes.
			expect(node?.textKind).toBeNull();
			const doc = await ctx.db
				.query("files_updated_by_docs")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.first();
			expect(doc, "db_install_file_content_replacement syncs the updater doc").toMatchObject({
				userId: node?.updatedBy,
				name: node?.name,
				parentId: node?.parentId,
				nodeKind: node?.kind,
			});
			expect(doc?.archiveOperationId).toBeUndefined();
		});
	});

	test("uses the saved type for download and same-shape restore after the current type changes", async () => {
		vi.useFakeTimers();
		const { t, db, asUser, nodeId, snapshotId, pointers } = await create_file_fixture();
		const originalSnapshot = await t.run((ctx) => ctx.db.get("files_snapshots", snapshotId));
		await test_run_with_flush(t, (ctx) => ctx.db.patch("files_nodes", nodeId, { contentType: "application/json" }));

		const getUrl = vi.spyOn(R2.prototype, "getUrl");
		getUrl.mockClear();
		const fetchObject = vi.mocked(fetch);
		fetchObject.mockClear();
		const download = await asUser.action(api.files_nodes.create_file_snapshot_content_url, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
		});
		expect(download?.snapshotId).toBe(snapshotId);
		expect(getUrl).toHaveBeenCalledWith(expect.any(String), {
			expiresIn: 15 * 60,
			responseContentType: "text/plain;charset=utf-8",
			responseContentDisposition: "attachment; filename*=UTF-8''restore.txt",
		});
		expect(fetchObject).not.toHaveBeenCalled();

		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
			sessionId: "restore-saved-type",
		});
		expect(restored._nay).toBeUndefined();
		const result = await t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", nodeId),
			snapshots: await ctx.db.query("files_snapshots").collect(),
			originalSnapshot: await ctx.db.get("files_snapshots", snapshotId),
		}));
		expect(result.node).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			textKind: "plain_text",
			collaborationEnabled: true,
			yjsSnapshotId: pointers.yjsSnapshotId,
			yjsLastSequenceId: pointers.yjsLastSequenceId,
		});
		expect(result.snapshots.slice(-2).map((snapshot) => snapshot.contentType)).toEqual([
			"application/json",
			"text/plain;charset=utf-8",
		]);
		expect(result.originalSnapshot).toEqual(originalSnapshot);
	});

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((rootKind) =>
			[true, false].map((collaborationEnabled) => ({ rootKind, collaborationEnabled })),
		),
	)(
		"restores a stored destination to $rootKind with saved collaboration $collaborationEnabled",
		async ({ rootKind, collaborationEnabled }) => {
			vi.useFakeTimers();
			const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture(rootKind);
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			let textSnapshotId = snapshotId;
			if (!collaborationEnabled) {
				const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: db.membershipId,
					nodeId,
					text: "Saved with collaboration off\n",
				});
				expect(saved._nay).toBeUndefined();
				textSnapshotId = await t.run(async (ctx) => (await ctx.db.query("files_snapshots").order("desc").first())!._id);
			}

			const storedSnapshotId = await t.run(async (ctx) => {
				const snapshot = await ctx.db.get("files_snapshots", snapshotId);
				if (!snapshot) throw new Error("Missing original snapshot");
				return await ctx.db.insert("files_snapshots", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: nodeId,
					assetId: snapshot.assetId,
					createdBy: db.userId,
					archivedAt: 0,
					contentType: "application/octet-stream",
					yjsRootKind: null,
					collaborationEnabled: false,
				});
			});
			vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				const body = objects.get(args.sourceKey)!;
				objects.set(args.destinationKey, body);
				return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "stored" };
			});
			const stored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: storedSnapshotId,
				sessionId: "restore-stored-first",
			});
			expect(stored._nay).toBeUndefined();
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
				textKind: null,
				collaborationEnabled: null,
			});

			const restoreData = await t.query(internal.files_nodes_content.get_data_for_restore_snapshot, {
				userId: db.userId,
				membershipId: db.membershipId,
				nodeId,
				snapshotId: textSnapshotId,
			});
			expect(restoreData?.snapshotContent).toMatchObject({
				yjsRootKind: rootKind,
				collaborationEnabled,
			});
			expect(restoreData?.snapshotContent).not.toHaveProperty("nonCollaborative");
			const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: textSnapshotId,
				sessionId: "restore-saved-mode",
			});
			expect(restored._nay).toBeUndefined();
			const result = await t.run(async (ctx) => ({
				node: await ctx.db.get("files_nodes", nodeId),
				snapshot: await ctx.db.query("files_snapshots").order("desc").first(),
			}));
			expect(result.node?.collaborationEnabled).toBe(collaborationEnabled);
			expect(result.node?.textKind).toBe(rootKind);
			expect(result.node?.yjsSnapshotId !== null).toBe(collaborationEnabled);
			expect(result.snapshot).toMatchObject({
				contentType: rootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
				yjsRootKind: rootKind,
				collaborationEnabled,
			});
		},
	);

	test.each(["text/plain;charset=utf-8", "text/html"])(
		"copies null-shaped %s bytes without parsing",
		async (contentType) => {
			vi.useFakeTimers();
			const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
			await t.run((ctx) =>
				ctx.db.patch("files_snapshots", snapshotId, {
					contentType,
					yjsRootKind: null,
					collaborationEnabled: false,
				}),
			);
			const scope = { userId: db.userId, membershipId: db.membershipId, nodeId, snapshotId };
			const restoreData = await t.query(internal.files_nodes_content.get_data_for_restore_snapshot, scope);
			const downloadData = await t.query(internal.files_nodes.get_data_for_create_file_snapshot_content_url, scope);
			expect(restoreData?.snapshotContent?.yjsRootKind).toBeNull();
			expect(restoreData?.snapshotContent).not.toHaveProperty("nonCollaborative");
			expect(restoreData?.snapshotContent?.collaborationEnabled).toBe(false);
			expect(downloadData?.yjsRootKind).toBeNull();
			expect(downloadData).not.toHaveProperty("nonCollaborative");
			expect(downloadData?.contentType).toBe(contentType);
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();

			const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a, 0x00, 0xff]);
			if (!restoreData?.snapshotContent?.asset.r2Key) throw new Error("Missing snapshot key");
			objects.set(restoreData.snapshotContent.asset.r2Key, bytes);
			const copy = vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				objects.set(args.destinationKey, objects.get(args.sourceKey)!);
				return { outcome: "copied", size: bytes.byteLength, etag: "stored-text" };
			});
			const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId,
				sessionId: "null-stored-shape",
			});
			expect(restored._nay).toBeUndefined();
			const result = await t.run(async (ctx) => {
				const node = await ctx.db.get("files_nodes", nodeId);
				const assetId = node?.assetId;
				if (!assetId) throw new Error("Missing restored asset");
				return {
					node,
					asset: await ctx.db.get("files_r2_assets", assetId),
					snapshot: await ctx.db
						.query("files_snapshots")
						.withIndex("by_asset", (q) => q.eq("assetId", assetId))
						.first(),
				};
			});
			expect(new Uint8Array(await new Response(objects.get(result.asset!.r2Key!)).arrayBuffer())).toEqual(bytes);
			expect(copy).toHaveBeenCalledOnce();
			expect(result.node).toMatchObject({ textKind: null, collaborationEnabled: null, yjsSnapshotId: null });
			expect(result.snapshot).toMatchObject({
				contentType,
				yjsRootKind: null,
				collaborationEnabled: false,
			});
			expect(result.snapshot).not.toHaveProperty("nonCollaborative");
		},
	);

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((sourceRootKind) =>
			(["plain_text", "rich_text"] as const).flatMap((targetRootKind) =>
				[false, true].map((off) => ({ sourceRootKind, targetRootKind, off })),
			),
		),
	)(
		"preserves every owner's proposal and expiry across repeated restores: %j",
		async ({ sourceRootKind, targetRootKind, off }) => {
			const fixture = await create_file_fixture(sourceRootKind);
			const { t, db, asUser, nodeId, snapshotId } = fixture;
			await create_pending_proposal({ fixture });
			const otherUserId = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "restore_other_owner" });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
				return userId;
			});
			await create_pending_proposal({ fixture, userId: otherUserId });
			if (off) {
				const toggled = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				});
				expect(toggled._nay).toBeUndefined();
			}

			const readProposals = () =>
				t.run(async (ctx) => {
					const [pending, states, pages, expiryChecks, chunks, searchChunks, metadata] = await Promise.all([
						ctx.db.query("files_pending_updates").collect(),
						ctx.db.query("files_pending_update_yjs_states").collect(),
						ctx.db.query("files_pending_update_yjs_state_pages").collect(),
						ctx.db.query("files_pending_update_expiry_checks").collect(),
						ctx.db
							.query("files_text_chunks")
							.filter((q) => q.neq(q.field("pendingUpdateId"), undefined))
							.collect(),
						ctx.db
							.query("files_plain_text_chunks")
							.filter((q) => q.neq(q.field("pendingUpdateId"), undefined))
							.collect(),
						ctx.db
							.query("files_metadata_docs")
							.filter((q) => q.eq(q.field("sourceKind"), "pending"))
							.collect(),
					]);
					return { pending, states, pages, expiryChecks, chunks, searchChunks, metadata };
				});
			const before = await readProposals();
			expect(before.pending).toHaveLength(2);
			expect(before.pending.every((pending) => pending.content?.rootKind === sourceRootKind)).toBe(true);
			let pendingContentVersion = (await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!.pendingContentVersion;
			const restoredText = "Restored text\n";

			const versionId = await t.run(async (ctx) => {
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-bucket",
					size: new TextEncoder().encode(restoredText).byteLength,
					createdBy: db.userId,
					updatedAt: Date.now(),
				});
				const r2Key = `test/restore-version-${assetId}`;
				objects.set(r2Key, restoredText);
				await ctx.db.patch("files_r2_assets", assetId, { r2Key });
				return await ctx.db.insert("files_snapshots", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					fileNodeId: nodeId,
					assetId,
					createdBy: db.userId,
					archivedAt: 0,
					contentType: targetRootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
					yjsRootKind: targetRootKind,
					collaborationEnabled: true,
				});
			});

			for (const [restoreId, rootKind, text] of [
				[versionId, targetRootKind, restoredText],
				[snapshotId, sourceRootKind, "Original text\n"],
			] as const) {
				const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId: restoreId,
					sessionId: "restore-preserved-proposals",
				});
				expect(restored._nay).toBeUndefined();
				expect(await readProposals()).toEqual(before);
				const node = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
				expect(node?.pendingContentVersion).toBe(++pendingContentVersion);
				expect(node?.textKind).toBe(rootKind);
				expect(node?.collaborationEnabled === false).toBe(off);
				const content = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					subject: { kind: "user" as const, userId: fixture.scope.userId, plugin: null },
					...fixture.scope,
					path: sourceRootKind === "rich_text" ? "/restore.md" : "/restore.txt",
				});
				expect(content?.content).toBe(text);
			}
		},
	);

	test("a no-op Restore keeps live history and refuses an earlier draft input", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser, nodeId, snapshotId, pointers } = fixture;
		const pending = await create_pending_proposal({ fixture });
		const before = await t.run(async (ctx) => ({
			node: (await ctx.db.get("files_nodes", nodeId))!,
			sequence: (await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId))!,
			updates: await ctx.db.query("files_yjs_updates").collect(),
		}));
		const target = { kind: "saved", id: nodeId } as const;
		const input = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: db.membershipId,
			target,
			expectedPendingContentVersion: before.node.pendingContentVersion,
		});
		if (input._nay) throw new Error(input._nay.message);

		expect(
			(
				await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId,
					sessionId: "no-op-restore",
				})
			)._nay,
		).toBeUndefined();
		const after = await t.run(async (ctx) => ({
			node: (await ctx.db.get("files_nodes", nodeId))!,
			sequence: await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId),
			updates: await ctx.db.query("files_yjs_updates").collect(),
			pending: await ctx.db.get("files_pending_updates", pending._id),
		}));
		expect(after.node.pendingContentVersion).toBe(before.node.pendingContentVersion + 1);
		expect(after.node.yjsLastSequenceId).toBe(before.node.yjsLastSequenceId);
		expect(after.node.yjsSnapshotId).toBe(before.node.yjsSnapshotId);
		expect(after.sequence).toEqual(before.sequence);
		expect(after.updates).toEqual(before.updates);
		expect(after.pending).toEqual(pending);
		expect(
			(
				await asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
					membershipId: db.membershipId,
					operationBatchId: input._yay.operationBatchId,
					role: "unstaged",
					text: "Earlier editor text\n",
				})
			)._nay,
		).toBeDefined();
		expect(
			(
				await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
					membershipId: db.membershipId,
					target,
					expectedPendingContentVersion: before.node.pendingContentVersion,
				})
			)._nay,
		).toBeDefined();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
	});

	test("a no-op Restore cannot commit across another no-op Restore", async () => {
		vi.useFakeTimers();
		const { t, db, asUser, nodeId, snapshotId, pointers } = await create_file_fixture();
		const before = (await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
		const fetchObject = vi.mocked(fetch);
		const originalFetch = fetchObject.getMockImplementation()!;
		let restoredDuringRead = false;
		fetchObject.mockImplementation(async (input, init) => {
			if (!restoredDuringRead && init?.method !== "PUT") {
				restoredDuringRead = true;
				const inner = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId,
					sessionId: "inner-no-op-restore",
				});
				expect(inner._nay).toBeUndefined();
			}
			return await originalFetch(input, init);
		});
		const outer = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId,
			sessionId: "outer-no-op-restore",
		});
		expect(restoredDuringRead).toBe(true);
		expect(outer._nay, "the earlier read must not receive the newer Restore's version").toBeDefined();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
			pendingContentVersion: before.pendingContentVersion + 1,
			yjsLastSequenceId: pointers.yjsLastSequenceId,
			yjsSnapshotId: pointers.yjsSnapshotId,
		});
	});

	test("Restore hides an old Save marker and the next Save overwrites that row", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser, nodeId, snapshotId } = fixture;
		const target = { kind: "saved", id: nodeId } as const;
		const save = async (text: string) => {
			const pending = await create_pending_proposal({ fixture, texts: { staged: text, unstaged: text } });
			const saved = await asUser.action(api.files_pending_updates.save_file_pending_update, {
				membershipId: db.membershipId,
				target,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			});
			if (saved._nay) throw new Error(saved._nay.message);
			if ("kind" in saved._yay) await test_finish_pending_update_run(asUser, saved._yay.runId);
		};
		const readMarker = () =>
			asUser.query(api.files_pending_updates.get_file_pending_update_last_sequence_saved, {
				membershipId: db.membershipId,
				nodeId,
			});
		await save("First saved text\n");
		const marker = await readMarker();
		expect(marker).not.toBeNull();
		expect(
			(
				await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
					membershipId: db.membershipId,
					nodeId,
					snapshotId,
					sessionId: "restore-marker",
				})
			)._nay,
		).toBeUndefined();
		expect(await readMarker()).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates_last_sequence_saved", marker!._id))).toEqual(marker);
		await save("Second saved text\n");
		const currentMarker = await readMarker();
		const node = (await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
		expect(currentMarker).toMatchObject({ _id: marker!._id, pendingContentVersion: node.pendingContentVersion });
	});

	test("normalizes a version saved with collaboration off when the live document already matches", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/normalize.md",
			textContent: "# Original\n",
		});
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: "# Title",
		});
		expect(saved._nay).toBeUndefined();
		const version = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const asset = await ctx.db.get("files_r2_assets", node!.assetId!);
			const snapshot = await ctx.db
				.query("files_snapshots")
				.withIndex("by_asset", (q) => q.eq("assetId", node!.assetId!))
				.first();
			return { snapshotId: snapshot!._id, r2Key: asset!.r2Key! };
		});
		expect(objects.get(version.r2Key)).toBe("# Title");

		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(on._nay).toBeUndefined();
		// Turning collaboration on points the node at the text the new document produced, so the
		// node byte size must follow that asset.
		const enabledSize = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const asset = node?.assetId ? await ctx.db.get("files_r2_assets", node.assetId) : null;
			return { contentByteSize: node?.contentByteSize, assetSize: asset?.size };
		});
		expect(enabledSize.assetSize).toBeGreaterThan(0);
		expect(enabledSize.contentByteSize).toBe(enabledSize.assetSize);
		const pointers = await test_get_file_yjs_pointers(t, nodeId);
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId: version.snapshotId,
			sessionId: "restore-normalized",
		});
		expect(restored._nay).toBeUndefined();
		expect(await test_get_file_yjs_pointers(t, nodeId)).toEqual(pointers);

		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", nodeId);
			const asset = await ctx.db.get("files_r2_assets", node!.assetId!);
			const yjsSnapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			const yjsAsset = await ctx.db.get("files_r2_assets", yjsSnapshot!.assetId);
			return { contentKey: asset!.r2Key!, yjsKey: yjsAsset!.r2Key! };
		});
		expect.soft(await new Response(objects.get(after.contentKey)).text()).toBe("# Title\n");
		const yjsDoc = new YjsDoc();
		applyUpdate(yjsDoc, new Uint8Array(await new Response(objects.get(after.yjsKey)).arrayBuffer()));
		const yjsText = files_yjs_doc_get_text({ yjsDoc, rootKind: "rich_text" });
		expect(yjsText._yay).toBe("# Title\n");
		yjsDoc.destroy();

		const download = await asUser.action(api.r2.create_signed_download_url, {
			membershipId: db.membershipId,
			fileNodeId: nodeId,
		});
		if (download._nay) throw new Error(download._nay.message);
		expect(await (await fetch(download._yay.url)).text()).toBe("# Title\n");
	});

	test("requires the Properties confirmation before a stored version removes shared history", async () => {
		const fixture = await create_file_fixture();
		const { t, db, asUser, nodeId, snapshotId, pointers } = fixture;
		const pending = await create_pending_proposal({ fixture });
		// A historical version saved as stored bytes, before the file became editable text.
		await t.run(async (ctx) =>
			ctx.db.patch("files_snapshots", snapshotId, {
				contentType: "application/octet-stream",
				yjsRootKind: null,
				collaborationEnabled: false,
			}),
		);
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
			const body = objects.get(args.sourceKey)!;
			objects.set(args.destinationKey, body);
			return { outcome: "copied", size: new TextEncoder().encode(String(body)).byteLength, etag: "copied" };
		});
		const restore = () =>
			asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId,
				sessionId: "restore-stored",
			});
		const refused = await restore();
		expect(refused._nay?.message).toBe(
			"Turn collaboration off in Properties before replacing this text file with stored content.",
		);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
		expect(await test_get_file_yjs_pointers(t, nodeId)).toEqual(pointers);
		const jobs = await t.run(async (ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs.filter((job) => job.reason === "failed_create")).toHaveLength(1);
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		expect((await restore())._nay).toBeUndefined();
		const node = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		expect(node?.contentType).toBe("application/octet-stream");
		expect(node?.yjsSnapshotId).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
	});

	test.each([false, true])(
		"keeps the destination mode when the version has the opposite mode (off: %s)",
		async (destinationOff) => {
			const { t, db, asUser, nodeId, snapshotId } = await create_file_fixture();
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			let versionId = snapshotId;
			if (!destinationOff) {
				const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: db.membershipId,
					nodeId,
					text: "Version saved with collaboration off\n",
				});
				expect(saved._nay).toBeUndefined();
				versionId = await t.run(async (ctx) => {
					const node = await ctx.db.get("files_nodes", nodeId);
					return (await ctx.db
						.query("files_snapshots")
						.withIndex("by_asset", (q) => q.eq("assetId", node!.assetId!))
						.first())!._id;
				});
			}
			const savedCurrent = await asUser.action(api.files_nodes_content.replace_file_content, {
				membershipId: db.membershipId,
				nodeId,
				text: "Current text to replace\n",
			});
			expect(savedCurrent._nay).toBeUndefined();
			if (!destinationOff) {
				const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: db.membershipId,
					nodeId,
				});
				expect(on._nay).toBeUndefined();
			}
			const before = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
			const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: versionId,
				sessionId: "restore-mode",
			});
			expect(restored._nay).toBeUndefined();
			const after = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
			expect(after?.collaborationEnabled === false).toBe(destinationOff);
			const assetId = after?.assetId;
			if (!assetId) throw new Error("Missing restored content asset");
			const restoredSnapshot = await t.run((ctx) =>
				ctx.db
					.query("files_snapshots")
					.withIndex("by_asset", (q) => q.eq("assetId", assetId))
					.first(),
			);
			expect(restoredSnapshot).toMatchObject({
				contentType: "text/plain;charset=utf-8",
				yjsRootKind: "plain_text",
				collaborationEnabled: !destinationOff,
			});
			expect(after?.yjsLastSequenceId).toBe(before?.yjsLastSequenceId);
			expect(after?.yjsSnapshotId).toBe(before?.yjsSnapshotId);
			const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				subject: { kind: "user", userId: db.userId, plugin: null },
				path: "/restore.txt",
			});
			expect(read?.content).toBe(destinationOff ? "Original text\n" : "Version saved with collaboration off\n");
		},
	);
});

describe("copy_transfer_file saved replacement", () => {
	test.each([false, true])(
		"keeps destination identity, metadata, and collaboration %s",
		async (collaborationEnabled) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t, db, asUser, scope, nodeId, pointers } = fixture;
			const sourceId = await test_create_saved_text_file(t, {
				membershipId: db.membershipId,
				path: "/source/restore.txt",
				textContent: "Replacement text\n",
			});
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId: collaborationEnabled ? sourceId : nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			await asUser.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: nodeId,
				metadataYaml: "owner: destination",
			});
			if (collaborationEnabled) {
				const yjsKey = await t.run(async (ctx) => {
					const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
					return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
				});
				const editor = new YjsDoc();
				applyUpdate(editor, new Uint8Array(await new Response(objects.get(yjsKey)).arrayBuffer()));
				const beforeEdit = encodeStateVector(editor);
				const text = editor.getText(files_YJS_DOC_KEYS.plainText);
				text.insert(text.length, "Live text before replace\n");
				expect(
					(
						await asUser.mutation(api.files_nodes.yjs_push_update, {
							membershipId: db.membershipId,
							nodeId,
							expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
							update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
							sessionId: "replace-test",
						})
					)._nay,
				).toBeUndefined();
				editor.destroy();
			}
			const started = await asUser.mutation(api.files_transfer.accept_input, {
				membershipId: db.membershipId,
				requestId: "saved-replacement",
				kind: "copy",
				expectedSourceCount: 1,
				sourceIds: [sourceId],
				targetParentId: files_ROOT_ID,
			});
			if (started._nay) throw new Error(started._nay.message);
			const { runId } = started._yay;
			expect(await asUser.mutation(api.files_transfer.seal, { membershipId: db.membershipId, runId })).toEqual({
				_yay: null,
			});
			for (let step = 0; step < 12; step++) {
				await t.mutation(internal.files_transfer.advance, { runId });
				const run = await asUser.query(api.files_transfer_status.get, { membershipId: db.membershipId, runId });
				if (run?.activity.status === "awaiting_input") break;
			}
			const waiting = await asUser.query(api.files_transfer_status.get, { membershipId: db.membershipId, runId });
			const page = await asUser.query(api.files_transfer_status.list_items, {
				membershipId: db.membershipId,
				runId,
				paginationOpts: { cursor: null, numItems: 50 },
			});
			if (!page) throw new Error("Missing transfer items");
			const item = page.page[0]!;
			expect(waiting?.activity.status).toBe("awaiting_input");
			expect(
				(
					await asUser.mutation(api.files_transfer.resolve_conflicts, {
						membershipId: db.membershipId,
						runId,
						revision: waiting!.revision,
						choices: [
							{
								itemId: item.itemId,
								choice: "replace",
								reviewedTarget: item.conflict!.target!,
								reviewedVersion: item.conflict!.version,
							},
						],
						applyToRemaining: { file: null, folder: null },
					})
				)._nay,
			).toBeUndefined();
			for (let step = 0; step < 5; step++) {
				await t.mutation(internal.files_transfer.advance, { runId });
				const copying = await t.run((ctx) => ctx.db.get("files_transfer_items", item.itemId));
				if (copying?.workId) break;
			}
			const mediaPins = await t.run((ctx) =>
				files_media_validation_db_capture_versions(ctx, { userId: db.userId, scopes: [scope] }),
			);
			await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item.itemId, attempt: 1 });
			expect(await t.run((ctx) => ctx.db.get("files_transfer_items", item.itemId))).toMatchObject({
				state: "completed",
				outputTarget: { kind: "saved", id: nodeId },
				stagedAssetIds: [],
			});
			expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({ collaborationEnabled });
			expect(
				(
					await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
						subject: { kind: "user" as const, userId: scope.userId, plugin: null },
						...scope,
						path: "/restore.txt",
						includePending: false,
					})
				)?.content,
			).toBe("Replacement text\n");
			// The old file is plain text with no pending replacement, so no media proof can check it.
			const contentClock = mediaPins.versions[2]!;
			expect(
				(await t.run((ctx) => ctx.db.get("files_content_versions", contentClock.id as Id<"files_content_versions">)))
					?.revision,
			).toBe(contentClock.revision);
			expect(
				await asUser.query(api.files_metadata.get_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
				}),
			).toEqual([{ key: "owner", value: "destination" }]);
			if (collaborationEnabled) {
				const snapshots = await t.run((ctx) =>
					ctx.db
						.query("files_snapshots")
						.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
							q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
						)
						.collect(),
				);
				const texts = await Promise.all(
					snapshots.map(async (snapshot) => {
						const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", snapshot.assetId));
						return await new Response(objects.get(asset!.r2Key!)).text();
					}),
				);
				expect(texts).toContain("Original text\nLive text before replace\n");
			}
		},
	);
});

describe("accept_file_pending_replacement", () => {
	test.each(["text", "stored bytes"] as const)(
		"keeps another owner's retained proposal when copying %s after a stored-byte restore",
		async (sourceKind) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture("rich_text");
			const { t, db, asUser, nodeId, snapshotId } = fixture;
			const otherUserId = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "copy_after_restore_owner" });
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
				return userId;
			});
			const pending = await create_pending_proposal({ fixture, userId: otherUserId });
			const readDraft = () =>
				t.run(async (ctx) => {
					const stateIds = [pending.content!.baseStateId, pending.content!.stagedStateId, pending.content!.unstagedStateId];
					return {
						pending: await ctx.db.get("files_pending_updates", pending._id),
						states: await Promise.all(stateIds.map((id) => ctx.db.get("files_pending_update_yjs_states", id))),
						pages: await Promise.all(
							stateIds.map((stateId) =>
								ctx.db
									.query("files_pending_update_yjs_state_pages")
									.withIndex("by_state_pageIndex", (q) => q.eq("stateId", stateId))
									.collect(),
							),
						),
						chunks: await ctx.db
							.query("files_text_chunks")
							.withIndex("by_pendingUpdate_chunkIndex", (q) => q.eq("pendingUpdateId", pending._id))
							.collect(),
					};
				});
			const beforeDraft = await readDraft();
			await t.run((ctx) =>
				ctx.db.patch("files_snapshots", snapshotId, {
					contentType: "application/octet-stream",
					yjsRootKind: null,
					collaborationEnabled: false,
				}),
			);
			vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				const body = objects.get(args.sourceKey)!;
				objects.set(args.destinationKey, body);
				return { outcome: "copied", size: (await new Response(body).arrayBuffer()).byteLength, etag: "copied" };
			});
			expect(
				(
					await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: db.membershipId,
						nodeId,
						acknowledgeDropCollaborativeHistory: true,
					})
				)._nay,
			).toBeUndefined();
			const contentClocks = () => t.run((ctx) => ctx.db.query("files_content_versions").collect());
			const beforeRestore = await contentClocks();
			expect(
				(
					await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
						membershipId: db.membershipId,
						nodeId,
						snapshotId,
						sessionId: "copy-after-stored-restore",
					})
				)._nay,
			).toBeUndefined();
			expect((await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))?.textKind).toBeNull();
			// The old text file could not back media, so no proof could have checked it.
			expect(await contentClocks()).toEqual(beforeRestore);
			expect(await readDraft()).toEqual(beforeDraft);
			let sourceId: Id<"files_nodes">;
			if (sourceKind === "text") {
				sourceId = await test_create_saved_text_file(t, {
					membershipId: db.membershipId,
					path: "/source.txt",
					textContent: "Copied text\n",
				});
			} else {
				const source = await asUser.mutation(api.files_nodes.create_upload_node, {
					membershipId: db.membershipId,
					parentId: files_ROOT_ID,
					filename: "source.pdf",
					contentType: "application/pdf",
					size: 3,
				});
				if (source._nay) throw new Error(source._nay.message);
				sourceId = source._yay.nodeId;
			}
			const sourceNode = await t.run((ctx) => ctx.db.get("files_nodes", sourceId));
			if (!sourceNode?.assetId) throw new Error("Missing copy source");
			if (sourceKind === "stored bytes") {
				const r2Key = "test/copy-after-restore.pdf";
				objects.set(r2Key, new Uint8Array([0, 255, 128]));
				await t.run((ctx) => ctx.db.patch("files_r2_assets", sourceNode.assetId!, { r2Key }));
			}
			const staged = await prepare_agent_replacement(fixture, sourceNode._id);
			const mediaPins = await t.run((ctx) =>
				files_media_validation_db_capture_versions(ctx, { userId: db.userId, scopes: [db] }),
			);
			expect(
				(
					await asUser.action(api.files_pending_updates.accept_file_pending_replacement, {
						membershipId: db.membershipId,
						target: { kind: "saved", id: nodeId },
						pendingUpdateId: staged._id,
						reviewedRevision: staged.revision,
					})
				)._nay,
			).toBeUndefined();
			expect(await readDraft()).toEqual(beforeDraft);
			// The accepted proposal was a pending replacement, so a proof could check the file through it.
			const contentClock = mediaPins.versions[2]!;
			expect(
				(await t.run((ctx) => ctx.db.get("files_content_versions", contentClock.id as Id<"files_content_versions">)))
					?.revision,
			).toBeGreaterThan(contentClock.revision);
		},
	);

	test("refuses replacement after the saved document receives an edit", async () => {
		const fixture = await create_file_fixture();
		const { t, db, asUser, nodeId, pointers } = fixture;
		const sourceBytes = new Uint8Array([0, 255, 10, 13, 128]);
		const source = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "source.pdf",
			contentType: "application/pdf",
			size: sourceBytes.byteLength,
		});
		if (source._nay) throw new Error(source._nay.message);
		const sourceKey = "test/stored-source.pdf";
		objects.set(sourceKey, sourceBytes);
		await t.run(async (ctx) => ctx.db.patch("files_r2_assets", source._yay.assetId, { r2Key: sourceKey }));
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
			const body = objects.get(args.sourceKey)!;
			objects.set(args.destinationKey, body);
			return { outcome: "copied", size: sourceBytes.byteLength, etag: "copied" };
		});
		const pending = await prepare_agent_replacement(fixture, source._yay.nodeId);

		// Live edits must remain safe even before the saved text asset changes.
		const yjsKey = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
		});
		const editor = new YjsDoc();
		applyUpdate(editor, new Uint8Array(await new Response(objects.get(yjsKey)).arrayBuffer()));
		const beforeEdit = encodeStateVector(editor);
		const text = editor.getText(files_YJS_DOC_KEYS.plainText);
		text.insert(text.length, "Edit before accepting the copy\n");
		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
			sessionId: "saved-copy-editor",
		});
		editor.destroy();
		expect(pushed._nay).toBeUndefined();

		const accepted = await asUser.action(api.files_pending_updates.accept_file_pending_replacement, {
			membershipId: db.membershipId,
			target: { kind: "saved", id: nodeId },
			pendingUpdateId: pending._id,
			reviewedRevision: pending.revision,
		});
		expect(accepted._nay?.message).toContain("changed");
		const after = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		expect(after?.contentType).toBe("text/plain;charset=utf-8");
		expect(after?.assetId).toBe(pending.pendingReplacement!.baseAssetId);
		expect(await test_get_file_yjs_pointers(t, nodeId)).toEqual(pointers);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
	});

	test.each([
		{ sourceOff: true, destinationOff: false },
		{ sourceOff: false, destinationOff: true },
	])("keeps the saved destination collaboration mode: %j", async ({ sourceOff, destinationOff }) => {
		const fixture = await create_file_fixture();
		const { t, db, asUser, scope, nodeId } = fixture;
		const sourceId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/source.txt",
			textContent: "Copied text\n",
		});
		for (const id of [sourceOff ? sourceId : null, destinationOff ? nodeId : null]) {
			if (id === null) continue;
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId: id,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
		}
		const staged = await prepare_agent_replacement(fixture, sourceId);
		const accepted = await asUser.action(api.files_pending_updates.accept_file_pending_replacement, {
			membershipId: db.membershipId,
			target: { kind: "saved", id: nodeId },
			pendingUpdateId: staged._id,
			reviewedRevision: staged.revision,
		});
		expect(accepted._nay).toBeUndefined();
		const after = await t.run(async (ctx) => ctx.db.get("files_nodes", nodeId));
		const expectedOff = destinationOff;
		expect(after?.collaborationEnabled === false).toBe(expectedOff);
		const assetId = after?.assetId;
		if (!assetId) throw new Error("Missing copied content asset");
		const copiedSnapshot = await t.run((ctx) =>
			ctx.db
				.query("files_snapshots")
				.withIndex("by_asset", (q) => q.eq("assetId", assetId))
				.first(),
		);
		expect(copiedSnapshot).toMatchObject({
			contentType: "text/plain;charset=utf-8",
			yjsRootKind: "plain_text",
			collaborationEnabled: !expectedOff,
		});
		expect(after?.yjsLastSequenceId !== null).toBe(!expectedOff);
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			subject: { kind: "user" as const, userId: scope.userId, plugin: null },
			...scope,
			path: "/restore.txt",
		});
		expect(read?.content).toBe("Copied text\n");
	});

	test("accepts the replacement through a review run and keeps the replaced bytes in history", async () => {
		test_spy_move_ranges();
		const fixture = await create_file_fixture();
		const { t, db, asUser } = fixture;
		// Use stored files on both sides. A text file already has a version row for its current
		// asset from its first save, so only a stored destination proves the run adds the row.
		const upload = async (filename: string, bytes: Uint8Array<ArrayBuffer>) => {
			const created = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				filename,
				contentType: "application/pdf",
				size: bytes.byteLength,
			});
			if (created._nay) throw new Error(created._nay.message);
			const key = `test/${filename}`;
			objects.set(key, files_u8_to_array_buffer(bytes));
			await t.run((ctx) => ctx.db.patch("files_r2_assets", created._yay.assetId, { r2Key: key }));
			return created._yay;
		};
		const destination = await upload("replaced.pdf", new Uint8Array([1, 2, 3]));
		const sourceBytes = new Uint8Array([0, 255, 10, 13, 128]);
		const source = await upload("source.pdf", sourceBytes);
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
			objects.set(args.destinationKey, objects.get(args.sourceKey)!);
			return { outcome: "copied", size: sourceBytes.byteLength, etag: "copied" };
		});
		const nodeId = destination.nodeId;
		const staged = await prepare_agent_replacement({ ...fixture, nodeId }, source.nodeId);
		const previousAssetId = staged.pendingReplacement!.baseAssetId;
		expect(previousAssetId).toBe(destination.assetId);
		const read_history = () =>
			t.run((ctx) =>
				ctx.db
					.query("files_snapshots")
					.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", nodeId),
					)
					.collect(),
			);
		expect(await read_history(), "the stored destination has no version row before the run").toEqual([]);

		const finished = await accept_through_review_run(fixture, staged);

		expect(finished?.activity, "Reviewed replacement completes through its background steps").toMatchObject({
			status: "succeeded",
			progress: { completed: 1 },
		});
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", staged._id))).toBeNull();
		const after = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		const afterAsset = await t.run((ctx) => ctx.db.get("files_r2_assets", after!.assetId!));
		expect(new Uint8Array(await new Response(objects.get(afterAsset!.r2Key!)).arrayBuffer())).toEqual(sourceBytes);
		expect(
			(await read_history()).map((version) => version.assetId),
			"the run adds a version row for the replaced bytes",
		).toContain(previousAssetId);
	});

	test("releases the staged copy of an occupant that a saved Move replaces", async () => {
		const fixture = await create_file_fixture();
		const { t, db, asUser } = fixture;
		// The deletion job may run from the scheduler too. Never call real R2.
		const deleted = vi.spyOn(r2_confirmed_object_delete, "delete_object").mockResolvedValue(undefined);
		const upload = async (filename: string, bytes: Uint8Array<ArrayBuffer>) => {
			const created = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				filename,
				contentType: "application/pdf",
				size: bytes.byteLength,
			});
			if (created._nay) throw new Error(created._nay.message);
			const key = `test/${filename}`;
			objects.set(key, bytes);
			await t.run((ctx) => ctx.db.patch("files_r2_assets", created._yay.assetId, { r2Key: key }));
			return created._yay;
		};
		const occupant = await upload("replaced.pdf", new Uint8Array([1, 2, 3]));
		const source = await upload("source.pdf", new Uint8Array([4, 5, 6]));
		const mover = await upload("mover.pdf", new Uint8Array([7, 8, 9]));
		vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
			objects.set(args.destinationKey, objects.get(args.sourceKey)!);
			return { outcome: "copied", size: 3, etag: "copied" };
		});
		const copy = await prepare_agent_replacement({ ...fixture, nodeId: occupant.nodeId }, source.nodeId);
		const stagedAssetId = copy.pendingReplacement!.assetId;
		const stagedKey = (await t.run((ctx) => ctx.db.get("files_r2_assets", stagedAssetId)))!.r2Key!;
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			...fixture.scope,
			target: { kind: "saved", id: mover.nodeId },
			destParent: { kind: "root" },
			destName: "replaced.pdf",
			replace: true,
		});
		if (moved._nay) throw new Error(moved._nay.message);
		const move = await t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", mover.nodeId),
				)
				.first(),
		);
		if (!move) throw new Error("Expected the Move proposal");
		const started = await asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 2,
			items: [move, copy].map((proposal) => ({
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
				selectedContentStateId: null,
			})),
		});
		if (started._nay) throw new Error(started._nay.message);
		const runId = started._yay.runId;
		const sealed = await asUser.mutation(api.files_pending_update_runs.seal, { membershipId: db.membershipId, runId });
		if (sealed._nay) throw new Error(sealed._nay.message);
		vi.useFakeTimers();
		await test_finish_pending_update_run(asUser, runId);
		vi.useRealTimers();
		const finished = await asUser.query(api.files_pending_update_runs.get, { membershipId: db.membershipId, runId });
		expect(finished?.activity).toMatchObject({ status: "succeeded", progress: { completed: 2 } });
		const after = await t.run(async (ctx) => {
			const hold = await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", stagedAssetId))
				.first();
			return {
				occupant: await ctx.db.get("files_nodes", occupant.nodeId),
				copy: await ctx.db.get("files_pending_updates", copy._id),
				asset: await ctx.db.get("files_r2_assets", stagedAssetId),
				hold,
				job: await ctx.db
					.query("files_r2_object_deletion_jobs")
					.withIndex("by_r2_key", (q) => q.eq("r2Key", stagedKey))
					.first(),
			};
		});
		expect(after.occupant?.archiveOperationId).not.toBeNull();
		expect(after.copy).toBeNull();
		// The dropped copy goes to the deletion ledger. Its storage hold settles when the delete finishes.
		expect(after.asset).toBeNull();
		expect(after.job?.reason).toBe("discarded_replacement");
		expect(after.job?.privateStorageReservationId).toBe(after.hold?._id);
		expect(after.hold?.byteCount).toBeGreaterThan(0);

		// Run the job twice. The hold settles once and the private bytes drop by its size once.
		const { hold, job } = after;
		if (!hold || !job) throw new Error("Expected the hold and its deletion job");
		const read_bytes = () => t.run(async (ctx) => (await ctx.db.get("quotas", hold.userQuotaId))!.usedCount);
		const bytesBefore = await read_bytes();
		vi.useFakeTimers();
		vi.setSystemTime(Math.max(Date.now(), (job.putMayArriveUntil ?? 0) + 1));
		for (let attempt = 0; attempt < 2; attempt++)
			await t.action(internal.r2_client.process_object_deletion_job, { jobId: job._id, generation: job.generation });
		vi.useRealTimers();
		expect(deleted).toHaveBeenCalledTimes(1);
		expect(deleted).toHaveBeenCalledWith(expect.anything(), stagedKey);
		expect((await t.run((ctx) => ctx.db.get("files_private_storage_reservations", hold._id)))?.settlement.kind).toBe(
			"deleted",
		);
		expect(await read_bytes(), "the copy leaves the private quota once").toBe(bytesBefore - hold.byteCount);
	});
});
