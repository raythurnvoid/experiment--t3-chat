import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_save_file_pending_update, test_create_saved_text_file, test_spy_handler } from "./setup.test.ts";
import { copy_transfer_file } from "./files_nodes_content.ts";
import { files_media_build_file_src, files_media_build_private_src } from "../shared/files-media.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import {
	files_headless_tiptap_editor_create,
	files_headless_tiptap_editor_get_markdown,
} from "../shared/files-tiptap.ts";
import {
	mock_media_storage,
	create_media,
	save_media,
	fixture,
	map_refs,
	read_dependencies,
	prepare_document_capture,
	finish_document,
	copy_again,
} from "./files_transfer_media.setup.test.ts";

beforeEach(mock_media_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("files_transfer_media_db_map_refs", () => {
	test.each(["current", "personal"] as const)(
		"maps saved %s media to the ready destination draft",
		async (sourceWorkspace) => {
			const f = await fixture({ sourceWorkspace, video: sourceWorkspace === "personal" });
			const result = await map_refs(f, [f.sourceRef, f.sourceRef, "https://example.test/external.png"]);
			if (!result._yay || !("referencePairs" in result._yay)) throw new Error("Expected mappings");
			const output = f.selectedMedia!.outputTarget!;
			const destinationRef = files_media_build_private_src(output.id);
			expect(new Map(result._yay.referencePairs)).toEqual(new Map([[f.sourceRef, destinationRef]]));
			expect(result._yay.mediaDependencies).toEqual([
				expect.objectContaining({
					src: destinationRef,
					target: output,
					assetId: expect.any(String),
					version: expect.objectContaining({
						kind: "pending",
						contentType: sourceWorkspace === "personal" ? "video/mp4" : "image/png",
						textKind: null,
					}),
				}),
			]);
			expect(result._yay.mediaDependencies[0]!.assetId).not.toBe(f.media.assetId);
			expect(result._yay.mediaDependencies[0]!.assetId).toBe(f.selectedMedia!.outputMediaAssetId);
			expect(f.selectedMedia!.capture!.artifact).toBeNull();
		},
	);

	test("maps a selected active private source and its exact spelling", async () => {
		const f = await fixture({ sourceKind: "private" });
		expect(await map_refs(f)).toMatchObject({
			_yay: {
				referencePairs: [[f.sourceRef, files_media_build_private_src(f.selectedMedia!.outputTarget!.id)]],
			},
		});
	});

	test("finds the selected saved source through its published private origin", async () => {
		const f = await fixture();
		const privateRef = files_media_build_private_src(f.original.id);
		const result = await map_refs(f, [privateRef]);
		expect(result).toMatchObject({
			_yay: { referencePairs: [[privateRef, files_media_build_private_src(f.selectedMedia!.outputTarget!.id)]] },
		});
	});

	test("uses the actor's stored replacement asset instead of the saved destination bytes", async () => {
		const f = await fixture({ replacement: true });
		const result = await map_refs(f);
		if (!result._yay || !("mediaDependencies" in result._yay)) throw new Error("Expected mappings");
		const dependency = result._yay.mediaDependencies[0]!;
		expect(dependency).toMatchObject({
			target: f.savedOccupant,
			src: files_media_build_file_src(f.savedOccupant!.id),
			version: { kind: "pending" },
		});
		expect(dependency.assetId).not.toBe(f.occupant!.assetId);
		expect(dependency.assetId).not.toBe(f.media.assetId);
		expect(dependency.assetId).toBe(f.selectedMedia!.outputMediaAssetId);
	});

	test("finds a selected private source after it is saved under its stable origin", async () => {
		const f = await fixture({ sourceKind: "private" });
		const saved = await save_media({
			t: f.t,
			membershipId: f.source.membershipId,
			userId: f.source.userId,
			target: f.media.target,
		});
		const savedRef = files_media_build_file_src(saved.id);
		expect(await map_refs(f, [savedRef, f.sourceRef])).toMatchObject({
			_yay: {
				referencePairs: [
					[savedRef, files_media_build_private_src(f.selectedMedia!.outputTarget!.id)],
					[f.sourceRef, files_media_build_private_src(f.selectedMedia!.outputTarget!.id)],
				],
			},
		});
	});

	test("keeps the destination private ref after that media is saved", async () => {
		const f = await fixture();
		await save_media({
			t: f.t,
			membershipId: f.destination.membershipId,
			userId: f.destination.userId,
			target: f.selectedMedia!.outputTarget!,
		});
		expect(await map_refs(f)).toMatchObject({
			_yay: {
				mediaDependencies: [
					{
						src: files_media_build_private_src(f.selectedMedia!.outputTarget!.id),
						target: f.selectedMedia!.outputTarget,
						version: { kind: "asset" },
					},
				],
			},
		});
	});

	test("keeps unselected media errors name-free and checks access first", async () => {
		const f = await fixture({ selected: false });
		expect(await map_refs(f)).toEqual({
			_nay: { message: "Select the linked image or video files with this document" },
		});
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: f.media.target.id as Id<"files_nodes">,
			}),
		).toEqual({ _yay: null });
		expect(await map_refs(f)).toEqual({ _nay: { message: "A linked media file is not available" } });
	});

	test("transfer history does not retain a linked media path after access is revoked", async () => {
		const f = await fixture({ selected: false });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: f.document.workId!,
			context: { itemId: f.document._id, attempt: f.document.attempt },
			result: { kind: "success", returnValue: null },
		});
		await f.t.mutation(internal.files_transfer.advance, { runId: f.document.runId });
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: f.media.target.id as Id<"files_nodes">,
			}),
		).toEqual({ _yay: null });
		const args = { membershipId: f.current.membershipId, runId: f.document.runId };
		const view = await f.asUser.query(api.files_transfer.get, args);
		const items = await f.asUser.query(api.files_transfer.list_items, {
			...args,
			paginationOpts: { cursor: null, numItems: 20 },
		});
		expect(view?.activity).toMatchObject({ status: "failed", errorCode: "copy_failed" });
		expect(items?.page).toHaveLength(1);
		expect(JSON.stringify({ view, items })).not.toContain("/photo.png");
	});

	test("rejects wrong-scope and wrong-table references without names", async () => {
		const f = await fixture();
		for (const ref of [
			files_media_build_private_src(f.selectedMedia!.outputTarget!.id),
			files_media_build_file_src(f.media.assetId),
			"bonobo-file://not-an-id",
		])
			expect(await map_refs(f, [ref])).toEqual({ _nay: { message: "A linked media file is not available" } });
	});

	test.each(["failed", "copying", "skipped"] as const)("refuses a selected %s item", async (state) => {
		const f = await fixture();
		await f.t.run((ctx) => ctx.db.patch("files_transfer_items", f.selectedMedia!._id, { state }));
		expect(await map_refs(f)).toEqual({
			_nay: { message: "A selected image or video file has not finished copying" },
		});
	});

	test.each([
		"unfinalized",
		"retired",
		"wrong scope",
		"wrong owner",
		"wrong size",
		"missing hold",
		"settled hold",
		"wrong key",
		"preparing",
		"discarded",
	] as const)("refuses destination media with %s", async (fault) => {
		const f = await fixture();
		const target = f.selectedMedia!.outputTarget!;
		await f.t.run(async (ctx) => {
			const pending = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.destination.userId).eq("target.kind", target.kind).eq("target.id", target.id),
				)
				.first();
			if (pending!.createIntent!.kind !== "stored") throw new Error("Expected stored draft");
			const assetId = pending!.createIntent!.assetId;
			const hold = await ctx.db
				.query("files_private_storage_reservations")
				.withIndex("by_resource", (q) => q.eq("resource.kind", "asset").eq("resource.id", assetId))
				.first();
			if (fault === "unfinalized") await ctx.db.patch("files_r2_assets", assetId, { unfinalizedExpiresAt: Date.now() });
			if (fault === "retired") await ctx.db.patch("files_r2_assets", assetId, { uploadRetiredAt: Date.now() });
			if (fault === "wrong scope")
				await ctx.db.patch("files_r2_assets", assetId, {
					organizationId: f.source.organizationId,
					workspaceId: f.source.workspaceId,
				});
			if (fault === "wrong owner") await ctx.db.patch("files_r2_assets", assetId, { createdBy: f.owner.userId });
			if (fault === "wrong size") await ctx.db.patch("files_r2_assets", assetId, { size: 5 });
			if (fault === "missing hold") await ctx.db.delete("files_private_storage_reservations", hold!._id);
			if (fault === "settled hold")
				await ctx.db.patch("files_private_storage_reservations", hold!._id, {
					settlement: { kind: "saved", savedNodeId: f.document.source.id as Id<"files_nodes">, settledAt: Date.now() },
				});
			if (fault === "wrong key")
				await ctx.db.patch("files_private_storage_reservations", hold!._id, {
					resource: { kind: "asset", id: assetId, r2Key: "wrong-key" },
				});
			if (fault === "preparing")
				await ctx.db.patch("files_pending_updates", pending!._id, {
					preparation: { transferItemId: f.selectedMedia!._id, creationGeneration: 1 },
				});
			if (fault === "discarded")
				await ctx.db.patch("files_pending_nodes", target.id as Id<"files_pending_nodes">, { state: "discarded" });
		});
		expect(await map_refs(f)).toEqual({ _nay: { message: "A copied media file is no longer ready or readable" } });
	});

	test("refuses an oversized page before resolving refs", async () => {
		const f = await fixture();
		expect(
			await map_refs(
				f,
				Array.from({ length: 51 }, () => f.sourceRef),
			),
		).toEqual({ _nay: { message: "Invalid media selection page" } });
	});
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
		const adopted = await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId));
		expect(adopted).toMatchObject({ owner: { kind: "proposal" } });
		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: capture.workId,
			context: { itemId: capture.itemId, attempt: capture.attempt },
			result: { kind: "failed", error: "Late old callback" },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toEqual(adopted);
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
		const started = await f.asUser.mutation(api.files_transfer.start, {
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

	test("requires a validation page even for an empty media set", async () => {
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

	test.each([false, true])("rechecks media after a stale publication proof (access revoked: %s)", async (revoked) => {
		const f = await fixture();
		const mediaBefore = await f.t.run((ctx) => ctx.db.get("files_nodes", f.media.target.id as Id<"files_nodes">));
		let publicationCalls = 0;
		test_spy_handler(copy_transfer_file, async (handler, ctx, args) => {
			const runMutation = ctx.runMutation.bind(ctx);
			vi.spyOn(ctx, "runMutation").mockImplementation(async (...mutationArgs) => {
				const reference = mutationArgs[0];
				if (
					getFunctionName(reference) === "files_nodes_content:finalize_transfer_file_copy" &&
					++publicationCalls === 1
				) {
					const changed = revoked
						? await f.asOwner.mutation(api.files_sharing.restrict_node, {
								membershipId: f.owner.membershipId,
								nodeId: f.media.target.id as Id<"files_nodes">,
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
		if (revoked) {
			expect(publicationCalls).toBe(1);
			expect(item).toMatchObject({ state: "failed", outputTarget: null });
		} else {
			expect(publicationCalls).toBe(2);
			expect(item).toMatchObject({ state: "completed", errorMessage: null, outputTarget: { kind: "private" } });
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.media.target.id as Id<"files_nodes">))).toEqual(
				mediaBefore,
			);
		}
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

	test("retires the old set when a document replacement is replaced again", async () => {
		const f = await fixture({ documentReplacement: true });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		await finish_document(f);
		const original = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		const setId = original!.capture!.mediaDependencySetId!;
		const before = await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId));
		const source = await test_create_saved_text_file(f.t, {
			membershipId: f.destination.membershipId,
			path: "/new-source.md",
			textContent: "No media now\n",
		});
		const replacement = await copy_again({ f, source: { kind: "saved", id: source }, targetName: "document.md" });
		expect(replacement!.target).toEqual(original!.outputTarget);
		expect(replacement!.mediaDependencySetId).not.toBe(setId);
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
			owner: { kind: "cleanup" },
			generation: before!.generation + 1,
		});
		expect(await read_dependencies(f.t, replacement!.mediaDependencySetId)).toEqual([]);
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

	test("counts saved and private source aliases separately and saves their one destination", async () => {
		const f = await fixture({ aliases: true });
		expect(f.sourceRefs).toHaveLength(2);
		expect(f.selectedMediaItems).toHaveLength(1);
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(item).toMatchObject({ state: "completed", outputTarget: { kind: "private" } });
		const setId = item!.capture!.mediaDependencySetId!;
		const dependencies = await read_dependencies(f.t, setId);
		// Two source refs can map to one copied media file.
		expect(dependencies).toHaveLength(2);
		expect(new Set(dependencies.map((dependency) => dependency.src)).size).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
			count: 2,
			expectedCount: 2,
			owner: { kind: "proposal" },
		});
		await save_media({
			t: f.t,
			membershipId: f.destination.membershipId,
			userId: f.destination.userId,
			target: f.selectedMedia!.outputTarget!,
		});
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target: item!.outputTarget!,
		});
		const pending = view!.entry.pendingUpdate!;
		const saved = await test_save_file_pending_update(f.asUser, {
			membershipId: f.destination.membershipId,
			target: pending.target,
			pendingUpdateId: pending._id,
			reviewedRevision: pending.revision,
		});
		expect(saved).toMatchObject({ _yay: { target: { kind: "saved" } } });
		const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: f.destination.organizationId,
			workspaceId: f.destination.workspaceId,
			userId: f.destination.userId,
			path: "/document.md",
			includePending: false,
		});
		expect(read?.content.split(dependencies[0]!.src)).toHaveLength(3);
		for (const src of f.sourceRefs) expect(read?.content).not.toContain(src);
	});

	test.each([false, true])("adopts an empty set for rich text (replacement: %s)", async (documentReplacement) => {
		const f = await fixture({ documentReplacement, selected: false, documentText: () => "No media yet\n" });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(item?.state).toBe("completed");
		const pending = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q
						.eq("userId", f.destination.userId)
						.eq("target.kind", item!.outputTarget!.kind)
						.eq("target.id", item!.outputTarget!.id),
				)
				.unique(),
		);
		expect(pending?.mediaDependencySetId).toBeDefined();
		const set = await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", pending!.mediaDependencySetId!));
		expect(set).toMatchObject({
			count: 0,
			expectedCount: 0,
			sealed: true,
			owner: { kind: "proposal", pendingUpdateId: pending!._id },
		});
		expect(pending).not.toHaveProperty("mediaDependencies");
	});

	test("rewrites a real video embed from personal to current", async () => {
		const f = await fixture({
			sourceWorkspace: "personal",
			video: true,
			documentText: (src) => `Before\n\n<video src="${src}" title="Clip"></video>\n\nAfter\n`,
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "completed",
		});
		const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: f.destination.organizationId,
			workspaceId: f.destination.workspaceId,
			userId: f.destination.userId,
			overlayUserId: f.destination.userId,
			path: "/document.md",
		});
		expect(read?.content).toContain(`src="${files_media_build_private_src(f.selectedMedia!.outputTarget!.id)}"`);
		expect(read?.content).toContain('title="Clip"');
		expect(read?.content).not.toContain(f.sourceRef);
	});

	test.each([false, true])("replacement Save waits for its media (media replacement: %s)", async (replacement) => {
		const f = await fixture({ documentReplacement: true, replacement });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		if (item?.outputTarget?.kind !== "saved") throw new Error("Expected document replacement");
		const target = item.outputTarget;
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const pending = view!.entry.pendingUpdate!;
		const before = await f.t.run((ctx) => ctx.db.get("files_nodes", target.id));
		const args = {
			membershipId: f.destination.membershipId,
			target,
			pendingUpdateId: pending._id,
			reviewedRevision: pending.revision,
		};
		expect(await test_save_file_pending_update(f.asUser, args)).toMatchObject({
			_nay: { message: expect.stringContaining("Save the selected media") },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", target.id))).toEqual(before);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
		await save_media({
			t: f.t,
			membershipId: f.destination.membershipId,
			userId: f.destination.userId,
			target: f.selectedMedia!.outputTarget!,
		});
		expect(await test_save_file_pending_update(f.asUser, args)).toMatchObject({
			_yay: { target },
		});
	});

	test("refuses a second Copy over private media before the first document mapping", async () => {
		const f = await fixture();
		expect(f.document.capture).toBeNull();
		const target = f.selectedMedia!.outputTarget!;
		expect(target.kind).toBe("private");
		const before = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const original = before!.entry.pendingUpdate!.createIntent!;
		if (original.kind !== "stored") throw new Error("Expected stored media");

		const other = await create_media({ t: f.t, scope: f.destination, path: "/other.png" });
		const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.destination.membershipId,
			clientGeneratedId: "replace-media-chat",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.destination.membershipId,
			threadId: thread._yay.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			requestId: "replace-copied-media",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [other.target],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: "photo.png",
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.destination.membershipId,
				threadId: thread._yay.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 16; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			const item = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.unique(),
			);
			if (item?.state === "completed") {
				expect(item.outputTarget).toEqual(target);
				break;
			}
			if (item?.workId) {
				await f.t.action(internal.files_nodes_content.copy_transfer_file, {
					itemId: item._id,
					attempt: item.attempt,
				});
				await f.t.mutation(internal.files_transfer.handle_copy_complete, {
					workId: item.workId,
					context: { itemId: item._id, attempt: item.attempt },
					result: { kind: "success", returnValue: null },
				});
			}
		}
		const changed = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const replacement = changed!.entry.pendingUpdate!.createIntent!;
		if (replacement.kind !== "stored") throw new Error("Expected stored replacement");
		expect(replacement.assetId).not.toBe(original.assetId);
		expect(changed!.entry.pendingUpdate!.preparation).toBeUndefined();

		const uploads = () => vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === "PUT").length;
		const beforeUploads = uploads();
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			outputTarget: null,
		});
		expect(uploads()).toBe(beforeUploads);
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: f.destination.membershipId,
				target,
			}),
		).toEqual(changed);

		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: f.document.workId!,
			context: { itemId: f.document._id, attempt: f.document.attempt },
			result: { kind: "success", returnValue: null },
		});
		await f.t.mutation(internal.files_transfer.advance, { runId: f.document.runId });
		const retried = await f.asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: f.current.membershipId,
			runId: f.document.runId,
			requestId: "retry-original-media",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		for (let step = 0; step < 16; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: retried._yay.runId });
			const items = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", retried._yay.runId))
					.collect(),
			);
			const document = items.find((item) => item.source.id === f.document.source.id);
			if (!document?.workId) continue;
			expect(items.find((item) => item.source.id === f.media.target.id)).toMatchObject({
				state: "completed",
				capture: null,
				outputTarget: target,
				outputMediaAssetId: original.assetId,
			});
			await f.t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: document._id,
				attempt: document.attempt,
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", document._id))).toMatchObject({
				state: "failed",
				outputTarget: null,
			});
			expect(uploads()).toBe(beforeUploads);
			return;
		}
		throw new Error("Retried document worker did not start");
	});

	test("allows unchanged media Save before the first document mapping and then saves the document", async () => {
		const f = await fixture();
		expect(f.document.capture).toBeNull();
		const mediaTarget = f.selectedMedia!.outputTarget!;
		const before = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target: mediaTarget,
		});
		const original = before!.entry.pendingUpdate!.createIntent!;
		if (original.kind !== "stored") throw new Error("Expected stored media");
		const savedMedia = await save_media({
			t: f.t,
			membershipId: f.destination.membershipId,
			userId: f.destination.userId,
			target: mediaTarget,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", savedMedia.id))).toMatchObject({
			assetId: original.assetId,
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(item?.state).toBe("completed");
		expect(item?.outputMediaAssetId).toBeUndefined();
		const target = item!.outputTarget!;
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const pending = view!.entry.pendingUpdate!;
		expect(await read_dependencies(f.t, pending.mediaDependencySetId)).toEqual([
			expect.objectContaining({
				src: files_media_build_private_src(mediaTarget.id),
				target: mediaTarget,
				assetId: original.assetId,
				version: expect.objectContaining({ kind: "asset" }),
			}),
		]);
		expect(
			await test_save_file_pending_update(f.asUser, {
				membershipId: f.destination.membershipId,
				target,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toMatchObject({ _yay: { target: { kind: "saved" } } });
	});

	test("keeps the first media pins when the worker retries before upload", async () => {
		const f = await fixture();
		const claim = { itemId: f.document._id, attempt: f.document.attempt, workId: f.document.workId! };
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: f.documentText } });
		if (editor._nay) throw new Error(editor._nay.message);
		const sourceTextDigest = await crypto_sha256_hex(
			files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay }),
		);
		editor._yay.destroy();
		const page = { expectedCount: 1, offset: 0, sourceTextDigest };
		await f.t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const first = await f.t.mutation(internal.files_nodes_content.prepare_transfer_file_media, {
			...claim,
			...page,
			refs: [f.sourceRef],
		});
		expect(first._yay).toHaveLength(1);
		expect(
			await f.t.mutation(internal.files_nodes_content.prepare_transfer_file_media, {
				...claim,
				...page,
				expectedCount: 51,
				refs: Array.from({ length: 51 }, () => f.sourceRef),
			}),
		).toEqual({ _nay: { message: "Invalid media selection page" } });
		await f.t.run(async (ctx) => {
			const target = f.selectedMedia!.outputTarget!;
			const pending = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.destination.userId).eq("target.kind", target.kind).eq("target.id", target.id),
				)
				.first();
			await ctx.db.patch("files_pending_updates", pending!._id, { revision: pending!.revision + 1 });
		});
		expect(
			await f.t.mutation(internal.files_nodes_content.prepare_transfer_file_media, {
				...claim,
				...page,
				refs: [f.sourceRef],
			}),
		).toEqual(first);
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			outputTarget: null,
			errorMessage: "The copied media changed while this document was being copied. Try again.",
		});
	});

	test.each([false, true])(
		"rewrites only app media and stores destination pins (replacement: %s)",
		async (documentReplacement) => {
			const f = await fixture({
				documentReplacement,
				documentText: (src) =>
					`Before\n\n![Photo](${src})\n\n\`literal ${src}\`\n\n![External](https://example.test/photo.png)\n\nAfter\n`,
			});
			const mapped = await map_refs(f);
			if (!mapped._yay || !("mediaDependencies" in mapped._yay)) throw new Error("Expected media mapping");
			await f.t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: f.document._id,
				attempt: f.document.attempt,
			});
			const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
			expect(item).toMatchObject({
				state: "completed",
				outputTarget: { kind: documentReplacement ? "saved" : "private" },
			});
			const pending = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_user_target", (q) =>
						q
							.eq("userId", f.destination.userId)
							.eq("target.kind", item!.outputTarget!.kind)
							.eq("target.id", item!.outputTarget!.id),
					)
					.first(),
			);
			expect(await read_dependencies(f.t, pending!.mediaDependencySetId)).toEqual(mapped._yay.mediaDependencies);
			const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: f.destination.organizationId,
				workspaceId: f.destination.workspaceId,
				userId: f.destination.userId,
				overlayUserId: f.destination.userId,
				path: "/document.md",
			});
			expect(read?.content).toContain(`![Photo](${mapped._yay.mediaDependencies[0]!.src})`);
			expect(read?.content).toContain(`\`literal ${f.sourceRef}\``);
			expect(read?.content).toContain("![External](https://example.test/photo.png)");
		},
	);

	test("refuses an unselected dependency before uploading document output", async () => {
		const f = await fixture({ selected: false });
		const uploads = () => vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === "PUT").length;
		const before = uploads();
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			errorMessage: "Select the linked image or video files with this document",
		});
		expect(uploads()).toBe(before);
	});

	test("refuses a media revision changed while the document uploads", async () => {
		const f = await fixture();
		const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
		let changed = false;
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			if (!changed && init?.method === "PUT") {
				changed = true;
				await f.t.run(async (ctx) => {
					const target = f.selectedMedia!.outputTarget!;
					const pending = await ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", f.destination.userId).eq("target.kind", target.kind).eq("target.id", target.id),
						)
						.first();
					await ctx.db.patch("files_pending_updates", pending!._id, { revision: pending!.revision + 1 });
				});
			}
			return await fetch(input, init);
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(changed).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			outputTarget: null,
			errorMessage: "The copied media changed while this document was being copied. Try again.",
		});
	});
});
