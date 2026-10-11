import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { files_visible_db_create_reader } from "./files_visible.ts";
import { files_transfer_db_get_entry_version } from "./files_transfer.ts";
import { files_media_build_private_src } from "../shared/files-media.ts";
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
	attach_dependencies,
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
	test("a later document refusal rolls back the earlier copied media Save", async () => {
		const f = await fixture();
		const source = await media(f);
		const savedSource = await save(f, source.pending);
		if (savedSource._nay) throw new Error(savedSource._nay.message);
		const copied = await cross_workspace_copy({ f, source: savedSource._yay.target });
		const target = copied.pending.target;
		if (target.kind !== "private" || copied.pending.createIntent?.kind !== "stored")
			throw new Error("Expected private media");
		const version = await f.t.run(async (ctx) => {
			const entry = await (await files_visible_db_create_reader(ctx, copied.destination.scope)).resolveTarget(target);
			if (!entry) throw new Error("Expected copied media");
			return await files_transfer_db_get_entry_version(ctx, entry);
		});
		if (!version) throw new Error("Expected copied media version");
		const selected = {
			src: files_media_build_private_src(target.id),
			target,
			assetId: copied.pending.createIntent.assetId,
			version,
		};
		const unselected = await media(copied.destination, "/clip.mp4");
		const doc = await attach_dependencies({
			f: copied.destination,
			pending: await private_text(copied.destination, {
				staged: `![Photo](${selected.src})\n\n<video src="${unselected.dependency.src}" controls></video>\n`,
			}),
			dependencies: [selected, unselected.dependency],
		});
		const result = await bulk_save({ f: copied.destination, selected: [copied.pending, doc] });
		expect(result?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 2 } });
		expect(await proposal(copied.destination, target)).toEqual(copied.pending);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_nodes", target.id))).toMatchObject({ state: "active" });
	});

	test.each(["document.md", "document.txt", "asset.md", "photo.png", "folder"])(
		"full %s Copy Save publishes the file and removes its proposal",
		async (name) => {
			const f = await fixture();
			let source: Doc<"files_pending_updates">;
			if (name === "folder") {
				const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
					...f.scope,
					path: "/folder",
					kind: "folder",
				});
				if (created._nay) throw new Error(created._nay.message);
				source = await proposal(f, created._yay.target);
			} else if (name === "photo.png") source = (await media(f)).pending;
			else
				source = await private_text(f, {
					path: `/${name}`,
					staged: "First\n\nSecond\n",
					collaborative: name !== "asset.md",
				});
			const savedSource = await save(f, source);
			if (savedSource._nay || savedSource._yay.target.kind !== "saved") throw new Error("Expected saved source");
			const sourceId = savedSource._yay.target.id;
			const before = await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId));
			const copied = await cross_workspace_copy({ f, source: savedSource._yay.target });
			const saved = await save(copied.destination, copied.pending);
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved copy");
			const savedId = saved._yay.target.id;
			expect(savedId).not.toBe(sourceId);
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", savedId))).toMatchObject({
				workspaceId: copied.destination.scope.workspaceId,
				path: `/${name}`,
				kind: name === "folder" ? "folder" : "file",
				archiveOperationId: null,
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", copied.pending._id))).toBeNull();
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId))).toEqual(before);
		},
	);

	test.each([
		{ name: "rich Yjs", path: "/document.md", collaborative: true },
		{ name: "plain Yjs", path: "/document.txt", collaborative: true },
		{ name: "asset text", path: "/document.md", collaborative: false },
	])("$name partial Save waits for a later full Save of the same proposal", async ({ path, collaborative }) => {
		const f = await fixture();
		const text = "First\n\nSecond\n";
		const source = await private_text(f, { path, staged: text, collaborative });
		const savedSource = await save(f, source);
		if (savedSource._nay) throw new Error(savedSource._nay.message);
		const copied = await cross_workspace_copy({ f, source: savedSource._yay.target });
		const partial = await saved_proposal({
			f: copied.destination,
			target: copied.pending.target,
			staged: "First\n",
			unstaged: text,
		});
		const savedPart = await save(copied.destination, partial);
		if (savedPart._nay) throw new Error(savedPart._nay.message);
		const full = await saved_proposal({ f: copied.destination, target: savedPart._yay.target, staged: text });
		expect(full._id).toBe(partial._id);
		const saved = await save(copied.destination, full);
		if (saved._nay) throw new Error(saved._nay.message);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id))).toBeNull();
		if (savedSource._yay.target.kind !== "saved") throw new Error("Expected saved source");
		const sourceId = savedSource._yay.target.id;
		expect((await f.t.run((ctx) => ctx.db.get("files_nodes", sourceId)))?.archiveOperationId).toBeNull();
	});

	test.each([true, false])(
		"bulk full Copy Save without a new publication keeps the saved file (collaboration: %s)",
		async (collaborative) => {
			const f = await fixture();
			const text = "First\n";
			const source = await private_text(f, { path: "/document.txt", staged: text, collaborative });
			const savedSource = await save(f, source);
			if (savedSource._nay) throw new Error(savedSource._nay.message);
			const copied = await cross_workspace_copy({ f, source: savedSource._yay.target });
			const partial = await saved_proposal({
				f: copied.destination,
				target: copied.pending.target,
				staged: text,
				unstaged: `${text}Extra\n`,
			});
			const savedPart = await save(copied.destination, partial);
			if (savedPart._nay || savedPart._yay.target.kind !== "saved") throw new Error("Expected partial Save");
			expect(
				await f.t.run((ctx) =>
					ctx.db
						.query("files_pending_places")
						.withIndex("by_target_user", (q) =>
							q
								.eq("target.kind", "private")
								.eq("target.id", copied.pending.target.id)
								.eq("userId", copied.destination.scope.userId)
								.eq("moveView.cohortId", undefined)
								.eq("moveView.view", undefined),
						)
						.unique(),
				),
				"partial Save retires the normal private place for its published alias",
			).toBeNull();
			const nodeId = savedPart._yay.target.id;
			const before = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
			const full = await saved_proposal({
				f: copied.destination,
				target: savedPart._yay.target,
				staged: `${text}Unselected\n`,
				unstaged: text,
			});
			expect(full._id).toBe(partial._id);
			const saved = await bulk_save({ f: copied.destination, selected: [full] });
			expect(saved?.activity, saved?.errors).toMatchObject({
				status: "succeeded",
				progress: { completed: 1, blocked: 0 },
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(before);
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", full._id))).toBeNull();
		},
	);

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

	test.each(["rich_text", "plain_text"] as const)("%s Copy Save keeps the accepted live merge", async (rootKind) => {
		const f = await fixture();
		const text = "First\n\nSecond\n";
		const source = await private_text(f, {
			path: rootKind === "rich_text" ? "/document.md" : "/document.txt",
			staged: text,
		});
		const savedSource = await save(f, source);
		if (savedSource._nay) throw new Error(savedSource._nay.message);
		const copied = await cross_workspace_copy({ f, source: savedSource._yay.target });
		const partial = await saved_proposal({
			f: copied.destination,
			target: copied.pending.target,
			staged: "First\n",
			unstaged: text,
		});
		const savedPart = await save(copied.destination, partial);
		if (savedPart._nay || savedPart._yay.target.kind !== "saved") throw new Error("Expected partial Save");
		const nodeId = savedPart._yay.target.id;
		const full = await saved_proposal({ f: copied.destination, target: savedPart._yay.target, staged: text });
		const before = await saved_doc(copied.destination, nodeId);
		const edited = files_yjs_doc_clone({ yjsDoc: before });
		expect(files_yjs_doc_update_from_text({ mut_yjsDoc: edited, rootKind, text: "LIVE\n" })._nay).toBeUndefined();
		const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: edited, yjsBeforeDoc: before });
		if (!update) throw new Error("Expected live edit");
		const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		expect(
			(
				await f.asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: copied.destination.membershipId,
					nodeId,
					expectedYjsLastSequenceId: node!.yjsLastSequenceId!,
					update: files_u8_to_array_buffer(update),
					sessionId: "live-copy",
				})
			)._nay,
		).toBeUndefined();
		before.destroy();
		edited.destroy();
		const saved = await save(copied.destination, full);
		if (saved._nay) throw new Error(saved._nay.message);
		const after = await saved_doc(copied.destination, nodeId);
		const accepted = files_yjs_doc_get_text({ yjsDoc: after, rootKind });
		expect(accepted._yay).toContain("LIVE");
		expect(accepted._yay).toContain("Second");
		after.destroy();
	});
});
