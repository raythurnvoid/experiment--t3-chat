// The embed and rich media tests are in files_pending_media_save.cross_workspace_embeds.test.ts, so the two
// files can run at the same time.
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
	fixture,
	proposal,
	private_text,
	saved_proposal,
	media,
	attach_dependencies,
	save,
	saved_doc,
	bulk_save,
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
