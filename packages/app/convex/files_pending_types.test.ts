import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { fixture, insert_saved_node, parent, target } from "./files_pending_overlay.setup.test.ts";
import {
	copy_files,
	fixture as copy_fixture,
	media_proposal,
	mock_scope_copy_storage,
	save_proposal,
} from "./files_transfer_scopes_content.setup.test.ts";
import { test_move_nodes, test_run_with_flush } from "./setup.test.ts";
import * as resolver from "../server/files-visible-resolve.ts";
import { files_pending_review_facts_db_pin_structure } from "../server/files-pending-review-facts.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("pending type entries", () => {
	test("private files keep their MIME and follow a private folder move", async () => {
		const f = await fixture();
		const folder = await f.create_private("/drafts", "folder");
		const file = await f.create_private("/drafts/note.md");
		await f.draft_move(folder, { kind: "root" }, "renamed");
		const entries = await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect());
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			target: file,
			sourceKind: "content",
			contentTypeEssence: "text/markdown",
			contentTypeFamily: "text",
			ownerTreePath: "/renamed/note.md",
			isVisible: true,
			isPathless: false,
		});
		await f.undo(file);
		await f.settle();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect())).toEqual([]);
	});

	test("move-only saved files keep no MIME copy and keep structural entries after access changes", async () => {
		const f = await fixture();
		const file = await f.saved(null, "saved.md");
		const folder = await f.saved(null, "destination", "folder");
		await f.draft_move(target(file), parent(folder), "renamed.md", f.v);
		await f.restrict(folder);
		const entries = await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect());
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			target: target(file),
			sourceKind: "move",
			contentTypeEssence: null,
			contentTypeFamily: null,
			ownerTreePath: "/destination/renamed.md",
			isVisible: true,
		});
		await f.expect_overlay_true();
	});

	test("a saved MIME change advances the shared source pin without owner work", async () => {
		const f = await fixture();
		const file = await f.saved(null, "saved.md");
		await f.settle();
		const pinned = await f.t.run((ctx) => files_pending_review_facts_db_pin_structure(ctx.db, f.u));
		await test_run_with_flush(f.t, (ctx) =>
			ctx.db.patch("files_nodes", file._id, {
				contentType: "image/png",
				contentTypeEssence: "image/png",
				contentTypeFamily: "image",
			}),
		);
		const state = await f.t.run((ctx) => ctx.db.query("files_pending_review_fact_state").unique());
		expect(state?.structureRevision).toBeGreaterThan(pinned.structureRevision);
		expect(state?.pendingJobCount).toBe(0);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect())).toEqual([]);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_overlay_jobs").collect())).toEqual([]);
	});

	test("a hidden destination keeps a non-result dependency and Undo restores it", async () => {
		const f = await fixture();
		const folder = await f.saved(null, "destination", "folder");
		const file = await f.saved(null, "saved.md");
		await f.draft_move(target(file), parent(folder), "saved.md");
		await f.draft_delete(target(folder));
		await f.settle();
		const hidden = await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect());
		expect(hidden).toHaveLength(1);
		expect(hidden[0]).toMatchObject({ sourceKind: "move", isVisible: false, parent: parent(folder) });
		await f.undo(target(folder));
		await f.settle();
		const visible = await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect());
		expect(visible[0]).toMatchObject({ isVisible: true, ownerTreePath: "/destination/saved.md" });
	});

	test("repair stays counted across pages and restores a missing typed entry", async () => {
		const f = await fixture();
		await f.create_private("/note.md");
		await f.settle();
		await f.t.run(async (ctx) => {
			const entry = await ctx.db.query("files_pending_type_entries").unique();
			await ctx.db.delete("files_pending_type_entries", entry!._id);
		});
		const pinned = await f.t.run((ctx) => files_pending_review_facts_db_pin_structure(ctx.db, f.u));
		await f.t.mutation(internal.files_pending_overlay.repair_user, { ...f.u, cursor: null });
		const state = await f.t.run((ctx) => ctx.db.query("files_pending_review_fact_state").unique());
		expect(state?.pendingJobCount).toBe(1);
		expect(state?.structureRevision).toBeGreaterThan(pinned.structureRevision);
		await f.settle();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect())).toHaveLength(1);
		expect((await f.t.run((ctx) => ctx.db.query("files_pending_review_fact_state").unique()))?.pendingJobCount).toBe(0);
		await f.expect_overlay_true();
	});

	test("unfinished target work resumes before the counted job ends", async () => {
		const create = resolver.files_visible_resolve_db_create;
		vi.spyOn(resolver, "files_visible_resolve_db_create").mockImplementation((db, args) => {
			const reader = create(db, args);
			return {
				...reader,
				resolveFacts: async () => null,
				resume: (operation, options) => reader.resume(operation, { ...options, stepLimit: 1 }),
			};
		});
		const f = await fixture();
		await f.create_private("/note.md");
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect())).toEqual([]);
		expect(
			(await f.t.run((ctx) => ctx.db.query("files_pending_review_fact_state").unique()))?.pendingJobCount,
		).toBeGreaterThan(0);
		expect(
			(await f.t.run((ctx) => ctx.db.query("files_pending_overlay_resolve_work").collect())).length,
		).toBeGreaterThan(0);
		await f.settle();
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_type_entries").collect())).toHaveLength(1);
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_overlay_resolve_work").collect())).toEqual([]);
		expect((await f.t.run((ctx) => ctx.db.query("files_pending_review_fact_state").unique()))?.pendingJobCount).toBe(0);
	});

	test("a stationary replacement follows saved Move and an owner folder move", async () => {
		mock_scope_copy_storage();
		const f = await copy_fixture();
		const original = await media_proposal({ f, workspace: "current" });
		const saved = await save_proposal({ f, workspace: "current", target: original });
		if (saved._nay) throw new Error(saved._nay.message);
		const video = await media_proposal({ f, workspace: "current", path: "/source.mp4" });
		const copied = await copy_files(f, {
			sources: [video],
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			targetName: "photo.png",
		});
		expect(copied[0]).toMatchObject({ state: "completed", outputTarget: saved._yay.target });
		const read = async () =>
			await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_type_entries")
					.withIndex("by_target_user", (q) =>
						q
							.eq("target.kind", saved._yay.target.kind)
							.eq("target.id", saved._yay.target.id)
							.eq("userId", f.current.userId)
							.eq("moveView.cohortId", undefined)
							.eq("moveView.view", undefined),
					)
					.unique(),
			);
		expect(await read()).toMatchObject({
			sourceKind: "content",
			contentTypeEssence: "video/mp4",
			ownerTreePath: "/photo.png",
		});
		const folder = await test_run_with_flush(f.t, (ctx) =>
			insert_saved_node(ctx, f.current, { parent: null, name: "folder", kind: "folder" }),
		);
		if (saved._yay.target.kind !== "saved") throw new Error("Expected a saved target");
		expect(
			await test_move_nodes(f.t, f.asUser, {
				membershipId: f.current.membershipId,
				itemIds: [saved._yay.target.id],
				targetParentId: folder._id,
			}),
		).toHaveProperty("_yay");
		expect(await read()).toMatchObject({ contentTypeEssence: "video/mp4", ownerTreePath: "/folder/photo.png" });
		expect(
			await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
				organizationId: f.current.organizationId,
				workspaceId: f.current.workspaceId,
				userId: f.current.userId,
				target: target(folder),
				destParent: { kind: "root" },
				destName: "draft-folder",
			}),
		).toHaveProperty("_yay");
		expect(await read()).toMatchObject({ ownerTreePath: "/draft-folder/photo.png", isVisible: true });
		const proposal = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q
						.eq("userId", f.current.userId)
						.eq("target.kind", saved._yay.target.kind)
						.eq("target.id", saved._yay.target.id),
				)
				.unique(),
		);
		expect(proposal?.pendingMove).toBeUndefined();
		expect(
			await f.asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
				membershipId: f.current.membershipId,
				target: saved._yay.target,
				pendingUpdateId: proposal!._id,
				reviewedRevision: proposal!.revision,
			}),
		).toHaveProperty("_yay");
		expect(await read()).toBeNull();
	});
});
