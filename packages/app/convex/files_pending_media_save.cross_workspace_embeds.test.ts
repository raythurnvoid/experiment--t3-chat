// Split from files_pending_media_save.cross_workspace.test.ts, so the two files can run at the same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { files_media_build_private_src } from "../shared/files-media.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";
import {
	mock_media_storage,
	objects,
	fixture,
	proposal,
	private_text,
	saved_proposal,
	media,
	save,
	saved_doc,
	bulk_save,
	copy_replacement,
	cross_workspace_copy,
} from "./files_pending_media_save.setup.test.ts";

beforeEach(mock_media_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("cross-workspace Copy from public Save", () => {
	test.each([
		{ collaborative: false, removeEmbed: true },
		{ collaborative: true, removeEmbed: true },
		{ collaborative: false, removeEmbed: false },
		{ collaborative: true, removeEmbed: false },
	])(
		"bulk Save groups only selected embeds (collaboration: $collaborative, removed: $removeEmbed)",
		async ({ collaborative, removeEmbed }) => {
			const f = await fixture();
			const sourceImage = await media(f);
			const savedSourceImage = await save(f, sourceImage.pending);
			if (savedSourceImage._nay) throw new Error(savedSourceImage._nay.message);
			const source = await private_text(f, {
				staged: `First\n\n![Photo](${sourceImage.src})\n`,
				collaborative,
			});
			const savedSource = await save(f, source);
			if (savedSource._nay) throw new Error(savedSource._nay.message);
			const copied = await cross_workspace_copy({
				f,
				source: savedSource._yay.target,
				mediaSources: [savedSourceImage._yay.target],
			});
			const destination = copied.destination;
			const imageTarget = copied.media[0]!;
			const copiedImage = await proposal(destination, imageTarget);
			if (copiedImage.createIntent?.kind !== "stored") throw new Error("Expected copied media");
			const image = { src: files_media_build_private_src(imageTarget.id), assetId: copiedImage.createIntent.assetId };
			const savedImage = await save(destination, copiedImage);
			if (savedImage._nay || savedImage._yay.target.kind !== "saved") throw new Error("Expected saved media");
			const imageNodeId = savedImage._yay.target.id;
			const text = `First\n\n![Photo](${image.src})\n`;
			const partial = await saved_proposal({
				f: destination,
				target: copied.pending.target,
				staged: text,
				unstaged: `${text}\nExtra\n`,
			});
			const savedPart = await save(destination, partial);
			if (savedPart._nay || savedPart._yay.target.kind !== "saved") throw new Error("Expected partial Save");
			const nodeId = savedPart._yay.target.id;

			// S keeps the image, but bulk Save selects U. Only U may remove this grouping edge.
			const accepted = removeEmbed ? "Changed without an image\n" : `${text}\nChanged\n`;
			const full = await saved_proposal({
				f: destination,
				target: savedPart._yay.target,
				staged: text,
				unstaged: accepted,
			});
			const newImage = await media(destination, "/new.png");
			const replacement = await copy_replacement({
				f: destination,
				source: newImage.pending.target,
				targetName: "photo.png",
			});
			expect(replacement.pendingReplacement!.assetId).not.toBe(image.assetId);
			const imageAssets = await f.t.run(async (ctx) =>
				Promise.all([
					ctx.db.get("files_r2_assets", image.assetId),
					ctx.db.get("files_r2_assets", replacement.pendingReplacement!.assetId),
				]),
			);
			const imageObjects = imageAssets.map((asset) => objects.get(asset!.r2Key!));
			let imageBefore = await f.t.run((ctx) => ctx.db.get("files_nodes", imageNodeId));
			const result = await bulk_save({
				f: destination,
				selected: [full, replacement],
				afterPlan: async () => {
					// Lock after selection and planning, so the worker must recheck the plan and write policy.
					expect(
						await destination.asUser.mutation(api.files_nodes.read_only_set, {
							membershipId: destination.membershipId,
							nodeId: imageNodeId,
							readOnly: true,
						}),
					).toEqual({ _yay: null });
					imageBefore = await f.t.run((ctx) => ctx.db.get("files_nodes", imageNodeId));
				},
			});
			expect(result?.activity, result?.errors).toMatchObject({
				status: removeEmbed ? "partial" : "failed",
				progress: { completed: removeEmbed ? 1 : 0, blocked: removeEmbed ? 1 : 2 },
			});
			expect(result?.run.unitCount).toBe(removeEmbed ? 2 : 1);
			const items = await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_update_run_items")
					.withIndex("by_run_order", (q) => q.eq("runId", result!.run._id))
					.collect(),
			);
			const documentItem = items.find((item) => item.pendingUpdateId === full._id)!;
			const imageItem = items.find((item) => item.pendingUpdateId === replacement._id)!;
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_run_units", imageItem.unitId!))).toMatchObject({
				status: "blocked",
				errorCode: "read_only",
			});
			if (removeEmbed) {
				expect(documentItem.unitId).not.toBe(imageItem.unitId);
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id))).toBeNull();
				if (collaborative) {
					const doc = await saved_doc(destination, nodeId);
					expect(files_yjs_doc_get_text({ yjsDoc: doc, rootKind: "rich_text" })._yay).toBe(accepted);
					doc.destroy();
				} else {
					const asset = await f.t.run(async (ctx) => {
						const node = await ctx.db.get("files_nodes", nodeId);
						return await ctx.db.get("files_r2_assets", node!.assetId!);
					});
					expect(await new Response(objects.get(asset!.r2Key!)).text()).toBe(accepted);
				}
			} else {
				expect(documentItem.unitId).toBe(imageItem.unitId);
				expect(await proposal(destination, full.target)).toEqual(full);
			}
			expect(await proposal(destination, replacement.target)).toEqual(replacement);
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", imageNodeId))).toEqual(imageBefore);
			expect(
				await f.t.run((ctx) => Promise.all(imageAssets.map((asset) => ctx.db.get("files_r2_assets", asset!._id)))),
			).toEqual(imageAssets);
			expect(imageAssets.map((asset) => objects.get(asset!.r2Key!))).toEqual(imageObjects);
		},
	);
});
