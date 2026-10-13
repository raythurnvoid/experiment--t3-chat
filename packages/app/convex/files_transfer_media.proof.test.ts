// Copy media proof tests: lost replies, sealed proofs, clock checks, Archive and Stop. The other Copy
// media tests are in files_transfer_media.copy.test.ts.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_spy_handler } from "./setup.test.ts";
import { copy_transfer_file } from "./files_nodes_content.ts";
import {
	mock_media_storage,
	save_media,
	fixture,
	read_dependencies,
	prepare_document_capture,
	finish_document,
} from "./files_transfer_media.setup.test.ts";

beforeEach(mock_media_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("copy_transfer_file media", () => {
	test("reuses mappings after a lost seal reply and rejects the old attempt proof", async () => {
		const f = await fixture();
		const capture = await prepare_document_capture(f);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, {
				itemId: capture.itemId,
				attempt: capture.attempt,
				workId: capture.workId,
				text: capture.text,
				offset: 0,
			}),
		).toEqual({ _yay: { offset: 1, isDone: true } });
		const before = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		const setId = before!.capture!.mediaDependencySetId!;
		const mappings = await read_dependencies(f.t, setId);
		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: capture.workId,
			context: { itemId: capture.itemId, attempt: capture.attempt },
			result: { kind: "failed", error: "Lost seal response" },
		});
		await f.t.mutation(internal.files_transfer.advance, { runId: f.document.runId });
		const retried = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(retried!.attempt).toBe(capture.attempt + 1);
		expect(retried!.capture).toEqual(before!.capture);
		expect(
			await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, {
				...capture,
				attempt: retried!.attempt,
				workId: retried!.workId!,
			}),
		).toHaveProperty("_nay");
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: retried!._id,
			attempt: retried!.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "completed",
		});
		expect(await read_dependencies(f.t, setId)).toEqual(mappings);
		// The finished Copy retires its mappings. The proposal keeps no media set.
		const retired = await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId));
		expect(retired).toMatchObject({ owner: { kind: "cleanup" } });
		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: capture.workId,
			context: { itemId: capture.itemId, attempt: capture.attempt },
			result: { kind: "failed", error: "Late old callback" },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toEqual(retired);
	});

	test("retires a saved clipboard copy's set without deleting its media", async () => {
		const f = await fixture();
		expect(
			await f.asUser.mutation(api.files_transfer.stop, {
				membershipId: f.current.membershipId,
				runId: f.document.runId,
			}),
		).toEqual({ _yay: null });
		await finish_document(f);
		const folder = await f.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.source.membershipId,
			parentId: "root",
			path: "/copies",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const started = await f.asUser.mutation(api.files_transfer.accept_input, {
			membershipId: f.source.membershipId,
			requestId: "clipboard-media",
			kind: "copy",
			expectedSourceCount: 1,
			sourceIds: [f.document.source.id as Id<"files_nodes">],
			targetParentId: folder._yay.nodeId,
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.asUser.mutation(api.files_transfer.seal, {
				membershipId: f.source.membershipId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 24; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			const item = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.unique(),
			);
			if (!item?.workId) continue;
			await f.t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
			const completed = await f.t.run((ctx) => ctx.db.get("files_transfer_items", item._id));
			expect(completed).toMatchObject({ state: "completed", outputTarget: { kind: "saved" } });
			const setId = completed!.capture!.mediaDependencySetId!;
			expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
				owner: { kind: "cleanup" },
				count: 1,
			});
			await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId });
			expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toBeNull();
			expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", f.media.assetId))).not.toBeNull();
			return;
		}
		throw new Error("Clipboard Copy did not start");
	});

	test("requires a validation page even for an empty media set, but no clock check", async () => {
		const f = await fixture({ selected: false, documentText: () => "No media\n" });
		const capture = await prepare_document_capture(f);
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toHaveProperty(
			"_nay",
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "copying",
			outputTarget: null,
		});
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, {
				itemId: capture.itemId,
				attempt: capture.attempt,
				workId: capture.workId,
				text: capture.text,
				offset: 0,
			}),
		).toEqual({ _yay: { offset: 0, isDone: true } });
		// A proof with no media refs has nothing a later Files or access change can break.
		await f.t.run(async (ctx) => {
			for (const clock of await ctx.db.query("files_media_validation_versions").collect())
				await ctx.db.patch("files_media_validation_versions", clock._id, { revision: clock.revision + 1 });
			for (const clock of await ctx.db.query("files_content_versions").collect())
				await ctx.db.patch("files_content_versions", clock._id, { revision: clock.revision + 1 });
			for (const clock of await ctx.db.query("files_pending_review_versions").collect())
				await ctx.db.patch("files_pending_review_versions", clock._id, { revision: clock.revision + 1 });
		});
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toEqual({
			_yay: null,
		});
	});

	test("rejects a source ACL change after the media proof is sealed", async () => {
		const f = await fixture();
		const capture = await prepare_document_capture(f);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, {
				itemId: capture.itemId,
				attempt: capture.attempt,
				workId: capture.workId,
				text: capture.text,
				offset: 0,
			}),
		).toEqual({ _yay: { offset: 1, isDone: true } });
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: f.media.target.id as Id<"files_nodes">,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toMatchObject({
			_nay: { message: "Media access changed during validation. Try again." },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "copying",
			outputTarget: null,
		});
	});

	test.each(["revoked", "archived folder", "new folder"] as const)(
		"rechecks media after a stale publication proof: %s",
		async (change) => {
			const f = await fixture();
			const mediaBefore = await f.t.run((ctx) => ctx.db.get("files_nodes", f.media.target.id as Id<"files_nodes">));
			const unrelated =
				change === "archived folder"
					? await f.asUser.mutation(api.files_nodes.create_folder_node, {
							membershipId: f.destination.membershipId,
							parentId: "root",
							path: "/unrelated-folder",
						})
					: null;
			let publicationCalls = 0;
			test_spy_handler(copy_transfer_file, async (handler, ctx, args) => {
				const runMutation = ctx.runMutation.bind(ctx);
				vi.spyOn(ctx, "runMutation").mockImplementation(async (...mutationArgs) => {
					const reference = mutationArgs[0];
					if (
						getFunctionName(reference) === "files_nodes_content:finalize_transfer_file_copy" &&
						++publicationCalls === 1
					) {
						const changed =
							change === "revoked"
								? await f.asOwner.mutation(api.files_sharing.restrict_node, {
										membershipId: f.owner.membershipId,
										nodeId: f.media.target.id as Id<"files_nodes">,
									})
								: change === "archived folder"
									? await f.asUser.mutation(api.files_nodes.archive_nodes, {
											membershipId: f.destination.membershipId,
											nodeIds: [unrelated!._yay!.nodeId],
										})
									: await f.asUser.mutation(api.files_nodes.create_folder_node, {
											membershipId: f.destination.membershipId,
											parentId: "root",
											path: "/unrelated-folder",
										});
						expect(changed).toHaveProperty("_yay");
					}
					return await runMutation(reference, mutationArgs[1], mutationArgs[2]);
				});
				return await handler(ctx, args);
			});
			await f.t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: f.document._id,
				attempt: f.document.attempt,
			});
			const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
			if (change === "revoked") {
				expect(publicationCalls).toBe(1);
				expect(item).toMatchObject({ state: "failed", outputTarget: null });
			} else {
				// A new folder has a new ID, so no checked proof names it and the first publication stands.
				expect(publicationCalls).toBe(change === "new folder" ? 1 : 2);
				expect(item).toMatchObject({ state: "completed", errorMessage: null, outputTarget: { kind: "private" } });
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.media.target.id as Id<"files_nodes">))).toEqual(
					mediaBefore,
				);
			}
		},
	);

	test("fails and retires the capture when the media clock changes before every publication", async () => {
		const f = await fixture();
		const mediaBefore = await f.t.run((ctx) => ctx.db.get("files_nodes", f.media.target.id as Id<"files_nodes">));
		// A folder archive moves the clock. A new folder does not, so create them first.
		const folderIds: Id<"files_nodes">[] = [];
		for (const index of [1, 2, 3]) {
			const folder = await f.asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId: f.destination.membershipId,
				parentId: "root",
				path: "/clock-change-" + index,
			});
			if (folder._nay) throw new Error(folder._nay.message);
			folderIds.push(folder._yay.nodeId);
		}
		let publicationCalls = 0;
		const assets: { id: Id<"files_r2_assets">; r2Key: string }[] = [];
		const setIds: Id<"files_media_dependency_sets">[] = [];
		test_spy_handler(copy_transfer_file, async (handler, ctx, args) => {
			const runMutation = ctx.runMutation.bind(ctx);
			vi.spyOn(ctx, "runMutation").mockImplementation(async (...mutationArgs) => {
				const reference = mutationArgs[0];
				if (getFunctionName(reference) === "files_nodes_content:finalize_transfer_file_copy") {
					publicationCalls += 1;
					if (publicationCalls === 1) {
						const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
						const { contentAssetId, yjsSnapshotAssetId } = item!.capture!.artifact!;
						for (const assetId of [contentAssetId, yjsSnapshotAssetId]) {
							if (assetId)
								assets.push({
									id: assetId,
									r2Key: (await f.t.run((ctx) => ctx.db.get("files_r2_assets", assetId)))!.r2Key!,
								});
						}
						setIds.push(item!.capture!.mediaDependencySetId!);
					}
					expect(
						await f.asUser.mutation(api.files_nodes.archive_nodes, {
							membershipId: f.destination.membershipId,
							nodeIds: [folderIds[publicationCalls - 1]!],
						}),
					).toHaveProperty("_yay");
				}
				return await runMutation(reference, mutationArgs[1], mutationArgs[2]);
			});
			return await handler(ctx, args);
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(publicationCalls).toBe(3);
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(item).toMatchObject({
			state: "failed",
			outputTarget: null,
			errorMessage: "Media access kept changing during validation. Try again.",
			stagedAssetIds: [],
		});
		expect(item!.capture!.artifact).toBeNull();
		const jobs = await f.t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(assets.length).toBeGreaterThan(0);
		for (const asset of assets) {
			expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", asset.id))).toBeNull();
			expect(jobs.find((job) => job.r2Key === asset.r2Key)?.putMayArriveUntil).toBeGreaterThan(Date.now());
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setIds[0]!))).toMatchObject({
			owner: { kind: "cleanup" },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.media.target.id as Id<"files_nodes">))).toEqual(
			mediaBefore,
		);
	});

	test.each(["source", "destination"] as const)(
		"rejects %s media Archive after a sealed proof",
		async (changedSide) => {
			const f = await fixture();
			const savedMedia =
				changedSide === "destination"
					? await save_media({
							t: f.t,
							membershipId: f.destination.membershipId,
							userId: f.destination.userId,
							target: f.selectedMedia!.outputTarget!,
						})
					: null;
			const capture = await prepare_document_capture(f);
			const validation = {
				itemId: capture.itemId,
				attempt: capture.attempt,
				workId: capture.workId,
				text: capture.text,
				offset: 0,
			};
			expect(await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, validation)).toEqual({
				_yay: { offset: 1, isDone: true },
			});
			const nodeId = changedSide === "source" ? (f.media.target.id as Id<"files_nodes">) : savedMedia!.id;
			const membershipId = changedSide === "source" ? f.source.membershipId : f.destination.membershipId;
			expect(await f.asUser.mutation(api.files_nodes.archive_nodes, { membershipId, nodeIds: [nodeId] })).toEqual({
				_yay: null,
			});
			const archived = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
			expect(archived).not.toBeNull();
			expect(archived!.archiveOperationId).not.toBeNull();
			expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toMatchObject({
				_nay: { message: "Media access changed during validation. Try again." },
			});
			expect(await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, validation)).toHaveProperty(
				"_nay",
			);
			expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
				state: "copying",
				outputTarget: null,
			});
		},
	);

	test("retires a document replacement's set without deleting its media", async () => {
		const f = await fixture({ documentReplacement: true });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		await finish_document(f);
		const original = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		const setId = original!.capture!.mediaDependencySetId!;
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
			owner: { kind: "cleanup" },
			count: 1,
		});
		await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId });
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", f.selectedMedia!.outputMediaAssetId!))).not.toBeNull();
	});

	test("Stop fences a sealed capture and keeps completed media assets", async () => {
		const f = await fixture();
		const capture = await prepare_document_capture(f);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, {
				itemId: capture.itemId,
				attempt: capture.attempt,
				workId: capture.workId,
				text: capture.text,
				offset: 0,
			}),
		).toEqual({ _yay: { offset: 1, isDone: true } });
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		const setId = item!.capture!.mediaDependencySetId!;
		expect(
			await f.asUser.mutation(api.files_transfer.stop, {
				membershipId: f.current.membershipId,
				runId: f.document.runId,
			}),
		).toEqual({ _yay: null });
		await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture);
		await f.t.mutation(internal.files_transfer.advance, { runId: f.document.runId });
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			outputTarget: null,
		});
		await f.t.mutation(internal.files_media_dependencies.cleanup_set, { setId });
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", f.selectedMedia!.outputMediaAssetId!))).not.toBeNull();
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.selectedMedia!._id))).toMatchObject({
			state: "completed",
			outputTarget: f.selectedMedia!.outputTarget,
		});
	});
});
