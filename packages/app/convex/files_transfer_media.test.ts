import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { files_media_build_file_src, files_media_build_private_src } from "../shared/files-media.ts";
import { mock_media_storage, save_media, fixture, map_refs } from "./files_transfer_media.setup.test.ts";

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
