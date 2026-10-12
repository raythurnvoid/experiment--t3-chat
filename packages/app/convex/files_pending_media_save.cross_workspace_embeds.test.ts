// Split from files_pending_media_save.cross_workspace.test.ts, so the two files can run at the same time.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { files_yjs_doc_clone, files_yjs_compute_diff_update_from_yjs_doc } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import {
	mock_media_storage,
	objects,
	fixture,
	proposal,
	private_text,
	saved_proposal,
	media,
	dependencies,
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
		{ collaborative: false, replaceMedia: true },
		{ collaborative: true, replaceMedia: true },
		{ collaborative: false, replaceMedia: false },
		{ collaborative: true, replaceMedia: false },
	])(
		"no-publication full Save checks rich media (collaboration: $collaborative, replacement: $replaceMedia)",
		async ({ collaborative, replaceMedia }) => {
			const f = await fixture();
			const sourceImage = await media(f);
			const savedSourceImage = await save(f, sourceImage.pending);
			if (savedSourceImage._nay) throw new Error(savedSourceImage._nay.message);
			const source = await private_text(f, {
				staged: `First\n\n![Photo](${sourceImage.dependency.src})\n`,
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
			const mappings = await dependencies(destination, copied.pending);
			expect(mappings).toHaveLength(1);
			const dependency = mappings[0]!;
			const savedImage = await save(destination, await proposal(destination, dependency.target));
			if (savedImage._nay || savedImage._yay.target.kind !== "saved") throw new Error("Expected saved media");
			const imageNodeId = savedImage._yay.target.id;
			const text = `First\n\n![Photo](${dependency.src})\n`;
			const partial = await saved_proposal({
				f: destination,
				target: copied.pending.target,
				staged: text,
				unstaged: `${text}\nExtra\n`,
			});
			const savedPart = await save(destination, partial);
			if (savedPart._nay || savedPart._yay.target.kind !== "saved") throw new Error("Expected partial Save");
			const nodeId = savedPart._yay.target.id;

			// Bulk Save selects U, which is already committed; S still has an unselected edit.
			const full = await saved_proposal({
				f: destination,
				target: savedPart._yay.target,
				staged: `${text}\nUnselected\n`,
				unstaged: text,
			});
			expect(full._id).toBe(partial._id);
			expect(await dependencies(destination, full)).toEqual([dependency]);
			let replacement: Doc<"files_pending_updates"> | null = null;
			if (replaceMedia) {
				const newImage = await media(destination, "/new.png");
				replacement = await copy_replacement({
					f: destination,
					source: newImage.pending.target,
					targetName: "photo.png",
				});
				expect(replacement.pendingReplacement!.assetId).not.toBe(dependency.assetId);
			}
			const before = await f.t.run(async (ctx) => ({
				document: await ctx.db.get("files_nodes", nodeId),
				image: await ctx.db.get("files_nodes", imageNodeId),
				assets: await ctx.db.query("files_r2_assets").collect(),
			}));
			const objectsBefore = new Map(objects);
			const result = await bulk_save({ f: destination, selected: replacement ? [full, replacement] : [full] });
			const reviewed = await f.t.run(async (ctx) => {
				const items = await ctx.db
					.query("files_pending_update_run_items")
					.withIndex("by_run_order", (q) => q.eq("runId", result!.run._id))
					.collect();
				const item = items.find((item) => item.pendingUpdateId === full._id)!;
				return { unit: await ctx.db.get("files_pending_update_run_units", item.unitId!) };
			});

			if (replacement) {
				const replacementId = replacement._id;
				expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 2 } });
				expect(reviewed.unit).toMatchObject({
					status: "blocked",
					itemCount: 2,
					errorMessage: "A linked media file changed. Review this document again.",
				});
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id))).toEqual(full);
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", replacementId))).toEqual(replacement);
			} else {
				expect(result?.activity, result?.errors).toMatchObject({
					status: "succeeded",
					progress: { completed: 1, blocked: 0 },
				});
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id))).toBeNull();
			}
			expect(
				await f.t.run(async (ctx) => ({
					document: await ctx.db.get("files_nodes", nodeId),
					image: await ctx.db.get("files_nodes", imageNodeId),
					assets: await ctx.db.query("files_r2_assets").collect(),
				})),
			).toEqual(before);
			expect(objects).toEqual(objectsBefore);
		},
	);

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
				staged: `First\n\n![Photo](${sourceImage.dependency.src})\n`,
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
			const mappings = await dependencies(destination, copied.pending);
			expect(mappings).toHaveLength(1);
			const dependency = mappings[0]!;
			const savedImage = await save(destination, await proposal(destination, dependency.target));
			if (savedImage._nay || savedImage._yay.target.kind !== "saved") throw new Error("Expected saved media");
			const imageNodeId = savedImage._yay.target.id;
			const text = `First\n\n![Photo](${dependency.src})\n`;
			const partial = await saved_proposal({
				f: destination,
				target: copied.pending.target,
				staged: text,
				unstaged: `${text}\nExtra\n`,
			});
			const savedPart = await save(destination, partial);
			if (savedPart._nay || savedPart._yay.target.kind !== "saved") throw new Error("Expected partial Save");
			const nodeId = savedPart._yay.target.id;
			expect(await dependencies(destination, await proposal(destination, savedPart._yay.target))).toEqual([dependency]);

			// S keeps the image, but bulk Save selects U. Only U may remove this grouping edge.
			const accepted = removeEmbed ? "Changed without an image\n" : `${text}\nChanged\n`;
			const full = await saved_proposal({
				f: destination,
				target: savedPart._yay.target,
				staged: text,
				unstaged: accepted,
			});
			expect(await dependencies(destination, full)).toEqual([dependency]);
			const newImage = await media(destination, "/new.png");
			const replacement = await copy_replacement({
				f: destination,
				source: newImage.pending.target,
				targetName: "photo.png",
			});
			expect(replacement.pendingReplacement!.assetId).not.toBe(dependency.assetId);
			const imageAssets = await f.t.run(async (ctx) =>
				Promise.all([
					ctx.db.get("files_r2_assets", dependency.assetId),
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
						await destination.asUser.mutation(api.files_nodes.set_node_write_policy, {
							membershipId: destination.membershipId,
							nodeId: imageNodeId,
							writePolicy: { mode: "read_only" },
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

	test.each([true, false])(
		"bulk Save checks a live embed added after planning (replacement selected: %s)",
		async (selectReplacement) => {
			const f = await fixture();
			const sourceImage = await media(f);
			const savedSourceImage = await save(f, sourceImage.pending);
			if (savedSourceImage._nay) throw new Error(savedSourceImage._nay.message);
			const source = await private_text(f, {
				staged: `Intro\n\n![Original](${sourceImage.dependency.src})\n\nFooter\n`,
				collaborative: true,
			});
			const savedSource = await save(f, source);
			if (savedSource._nay) throw new Error(savedSource._nay.message);
			const copied = await cross_workspace_copy({
				f,
				source: savedSource._yay.target,
				mediaSources: [savedSourceImage._yay.target],
			});
			const destination = copied.destination;
			const mappings = await dependencies(destination, copied.pending);
			expect(mappings).toHaveLength(1);
			const dependency = mappings[0]!;
			const savedImage = await save(destination, await proposal(destination, dependency.target));
			if (savedImage._nay || savedImage._yay.target.kind !== "saved") throw new Error("Expected saved media");
			const imageNodeId = savedImage._yay.target.id;
			const text = `Intro\n\n![Original](${dependency.src})\n\nFooter\n`;
			const partial = await saved_proposal({
				f: destination,
				target: copied.pending.target,
				staged: text,
				unstaged: `${text}\nExtra\n`,
			});
			const savedPart = await save(destination, partial);
			if (savedPart._nay || savedPart._yay.target.kind !== "saved") throw new Error("Expected partial Save");
			const nodeId = savedPart._yay.target.id;
			// S keeps the old embed. The selected U removes it but keeps the footer.
			const accepted = "Changed\n\nFooter\n";
			const full = await saved_proposal({
				f: destination,
				target: savedPart._yay.target,
				staged: text,
				unstaged: accepted,
			});
			expect(await dependencies(destination, full)).toEqual([dependency]);
			const newImage = await media(destination, "/new.png");
			const replacement = await copy_replacement({
				f: destination,
				source: newImage.pending.target,
				targetName: "photo.png",
			});
			expect(replacement.pendingReplacement!.assetId).not.toBe(dependency.assetId);
			const liveAppend = `\n![Live](${dependency.src})\n`;
			const result = await bulk_save({
				f: destination,
				selected: [full, ...(selectReplacement ? [replacement] : [])],
				afterPlan: async () => {
					// The new embed is outside U's changed lines and arrives only after the units are planned.
					const before = await saved_doc(destination, nodeId);
					expect(files_yjs_doc_get_text({ yjsDoc: before, rootKind: "rich_text" })._yay).toBe(text);
					const edited = files_yjs_doc_clone({ yjsDoc: before });
					expect(
						files_yjs_doc_update_from_text({ mut_yjsDoc: edited, rootKind: "rich_text", text: text + liveAppend })._nay,
					).toBeUndefined();
					const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: edited, yjsBeforeDoc: before });
					if (!update) throw new Error("Expected live append");
					const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
					expect(
						(
							await destination.asUser.mutation(api.files_nodes.yjs_push_update, {
								membershipId: destination.membershipId,
								nodeId,
								expectedYjsLastSequenceId: node!.yjsLastSequenceId!,
								update: files_u8_to_array_buffer(update),
								sessionId: "live-media-after-plan",
							})
						)._nay,
					).toBeUndefined();
					before.destroy();
					edited.destroy();
					expect(await proposal(destination, full.target)).toEqual(full);
				},
			});
			const pending = await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id));
			const after = await saved_doc(destination, nodeId);
			const finalText = files_yjs_doc_get_text({ yjsDoc: after, rootKind: "rich_text" })._yay;
			after.destroy();
			if (selectReplacement) {
				// The image may save independently, but the document must not publish this changed link.
				expect(result?.activity.progress?.completed).toBeLessThan(2);
				expect(pending).toEqual(full);
				expect(finalText).toBe(text + liveAppend);
			} else {
				// A replacement outside this Save must not block use of the unchanged saved media.
				expect(result?.activity).toMatchObject({ status: "succeeded", progress: { completed: 1, blocked: 0 } });
				expect(pending).toBeNull();
				expect(finalText).toBe(accepted + liveAppend);
				expect(await proposal(destination, replacement.target)).toEqual(replacement);
				expect(await f.t.run((ctx) => ctx.db.get("files_nodes", imageNodeId))).toMatchObject({
					assetId: dependency.assetId,
				});
			}
		},
	);
});
