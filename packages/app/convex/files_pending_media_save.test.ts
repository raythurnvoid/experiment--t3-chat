import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_mocks_fill_db_with, test_spy_move_ranges } from "./setup.test.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_media_build_file_src } from "../shared/files-media.ts";
import { files_yjs_doc_clone, files_yjs_compute_diff_update_from_yjs_doc } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { files_saved_placement_db_resolve_read_target } from "../server/files-saved-placement.ts";
import {
	mock_media_storage,
	fixture,
	proposal,
	private_text,
	saved_proposal,
	media,
	save,
	saved_doc,
	bulk_save,
	copy_replacement,
} from "./files_pending_media_save.setup.test.ts";

beforeEach(mock_media_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Save ordinary rich-text media", () => {
	test.each([false, true])(
		"ordinary Save keeps broken and unselected links (selected media: %s)",
		async (selectMedia) => {
			const f = await fixture();
			const unselected = await media(f, "/unselected.png");
			const image = await media(f, "/selected.png");
			// Put ignored links before the selected one, across more than one media page.
			const refs = [
				...Array.from({ length: 9 }, (_, index) => files_media_build_file_src(`missing-${index}`)),
				unselected.src,
				image.src,
			];
			const text = `Intro\n\n${refs.map((src) => `![Photo](${src})`).join("\n\n")}\n`;
			const pending = await private_text(f, { staged: text });
			const result = await bulk_save({ f, selected: [pending, ...(selectMedia ? [image.pending] : [])] });
			expect(result?.activity, "ordinary Save keeps broken and unselected links as text").toMatchObject({
				status: "succeeded",
				progress: { completed: selectMedia ? 2 : 1, blocked: 0 },
			});
			const target = await f.t.run((ctx) =>
				files_saved_placement_db_resolve_read_target(ctx.db, { ...f.scope, target: pending.target }),
			);
			if (target?.kind !== "saved") throw new Error("Expected saved document");
			const after = await saved_doc(f, target.id);
			expect(files_yjs_doc_get_text({ yjsDoc: after, rootKind: "rich_text" })._yay).toBe(text);
			after.destroy();
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toBeNull();
			expect(await proposal(f, unselected.pending.target)).toEqual(unselected.pending);
			if (selectMedia)
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", image.pending._id))).toBeNull();
			else expect(await proposal(f, image.pending.target)).toEqual(image.pending);
		},
	);

	test.each([true, false])(
		"ordinary Save checks a live embed added after planning (media selected: %s)",
		async (selectMedia) => {
			test_spy_move_ranges();
			const f = await fixture();
			const text = "Intro\n\nFooter\n";
			const saved = await save(f, await private_text(f, { staged: text, collaborative: true }));
			if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved document");
			const nodeId = saved._yay.target.id;
			const accepted = "Changed\n\nFooter\n";
			const pending = await saved_proposal({ f, target: saved._yay.target, staged: accepted });
			const image = await media(f);
			const liveAppend = `\n![Live](${image.src})\n`;
			const result = await bulk_save({
				f,
				selected: [pending, ...(selectMedia ? [image.pending] : [])],
				afterPlan: async () => {
					// This link is absent from the graph. The document still has a one-item group.
					const before = await saved_doc(f, nodeId);
					const edited = files_yjs_doc_clone({ yjsDoc: before });
					expect(
						files_yjs_doc_update_from_text({ mut_yjsDoc: edited, rootKind: "rich_text", text: text + liveAppend })._nay,
					).toBeUndefined();
					const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: edited, yjsBeforeDoc: before });
					if (!update) throw new Error("Expected live append");
					const node = await f.t.run((ctx) => ctx.db.get("files_nodes", nodeId));
					expect(
						(
							await f.asUser.mutation(api.files_nodes.yjs_push_update, {
								membershipId: f.membershipId,
								nodeId,
								expectedYjsLastSequenceId: node!.yjsLastSequenceId!,
								update: files_u8_to_array_buffer(update),
								sessionId: "ordinary-live-media-after-plan",
							})
						)._nay,
					).toBeUndefined();
					before.destroy();
					edited.destroy();
					expect(await proposal(f, pending.target)).toEqual(pending);
				},
			});
			const after = await saved_doc(f, nodeId);
			const finalText = files_yjs_doc_get_text({ yjsDoc: after, rootKind: "rich_text" })._yay;
			after.destroy();
			if (selectMedia) {
				expect(
					result?.activity.progress?.completed,
					"late selected ordinary media keeps the document unpublished",
				).toBeLessThan(2);
				const unit = await f.t.run(async (ctx) => {
					const item = await ctx.db
						.query("files_pending_update_run_items")
						.withIndex("by_run_pendingUpdate", (q) =>
							q.eq("runId", result!.run._id).eq("pendingUpdateId", pending._id),
						)
						.unique();
					return await ctx.db.get("files_pending_update_run_units", item!.unitId!);
				});
				expect(unit, "late selected ordinary media reaches the strict media check").toMatchObject({
					status: "blocked",
					itemCount: 1,
					errorCode: "needs_review",
					errorMessage: "A linked media file changed. Review this document again.",
				});
				expect(await proposal(f, pending.target)).toEqual(pending);
				expect(finalText).toBe(text + liveAppend);
			} else {
				expect(result?.activity, "ordinary Save keeps a live unselected media link as text").toMatchObject({
					status: "succeeded",
					progress: { completed: 1, blocked: 0 },
				});
				expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toBeNull();
				expect(finalText).toBe(accepted + liveAppend);
				expect(await proposal(f, image.pending.target)).toEqual(image.pending);
			}
		},
	);

	// The review reads the selected delete as reviewed, so the link joins it and the link stays text.
	test("a saved private alias joins its new media delete in one review unit", async () => {
		const f = await fixture();
		const image = await media(f);
		const saved = await save(f, image.pending);
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
		const target = saved._yay.target;
		const text = `![Photo](${image.src})\n`;
		const pending = await private_text(f, { staged: text });
		expect(
			(await f.t.mutation(internal.files_pending_updates.upsert_file_pending_archive_in_db, { ...f.scope, target }))
				._nay,
		).toBeUndefined();
		const archive = await proposal(f, target);
		expect(archive._id).not.toBe(image.pending._id);
		const result = await bulk_save({ f, selected: [pending, archive] });
		expect(result?.activity, "the reviewed delete keeps the linked media readable for Save").toMatchObject({
			status: "succeeded",
			progress: { completed: 2, blocked: 0 },
		});
		expect(result?.run.unitCount, "the link joins the delete in one unit").toBe(1);
		const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...f.scope,
			path: "/document.md",
			includePending: false,
		});
		expect(read?.content).toBe(text);
	});

	test("a saved private alias joins the new media replacement", async () => {
		const f = await fixture();
		const image = await media(f);
		const saved = await save(f, image.pending);
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
		const target = saved._yay.target;
		const source = await media(f, "/new.png");
		const replacement = await copy_replacement({ f, source: source.pending.target, targetName: "photo.png" });
		expect(replacement._id).not.toBe(image.pending._id);
		if (!replacement.pendingReplacement) throw new Error("Expected media replacement");
		const pending = await private_text(f, { staged: `![Photo](${image.src})\n` });
		const result = await bulk_save({ f, selected: [pending, replacement] });
		expect(result?.activity, result?.errors).toMatchObject({ status: "succeeded", progress: { completed: 2, blocked: 0 } });
		expect(result?.run.unitCount, "the link joins the replacement in one unit").toBe(1);
		// Save resolves the private alias to the saved file and proves the replacement it selected.
		const content = await f.t.run(async (ctx) => {
			const unit = await ctx.db
				.query("files_pending_update_run_units")
				.withIndex("by_run_order", (q) => q.eq("runId", result!.run._id))
				.unique();
			return await ctx.db
				.query("files_move_cohort_content")
				.withIndex("by_cohort_proposal", (q) => q.eq("cohortId", unit!.cohortId!).eq("pendingUpdateId", pending._id))
				.unique();
		});
		expect(content?.mediaProof, "Save proves the selected replacement").toMatchObject({
			expectedCount: 1,
			validatedCount: 1,
			sealed: true,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", target.id))).toMatchObject({
			assetId: replacement.pendingReplacement.assetId,
		});
	});
});

describe("Save copied rich-text media", () => {
	// A copied document saves like any other document. A link to a deleted or changed image stays in
	// the text. A replacement copy saves through the direct Save path. A new copy saves through a review
	// run. A review of several items reads the copy's links, but does not select the image.
	test.each([
		{ embed: "copied", change: "deleted", replacement: false, review: false },
		{ embed: "copied", change: "deleted", replacement: true, review: false },
		{ embed: "added later", change: "deleted", replacement: false, review: false },
		{ embed: "copied", change: "replaced", replacement: false, review: false },
		{ embed: "copied", change: "deleted", replacement: false, review: true },
	] as const)(
		"saves a link to a $change image (embed $embed, replacement: $replacement, review: $review)",
		async ({ embed, change, replacement, review }) => {
			const f = await fixture();
			const image = await media(f);
			const savedImage = await save(f, image.pending);
			if (savedImage._nay || savedImage._yay.target.kind !== "saved") throw new Error("Expected saved media");
			const imageTarget = savedImage._yay.target;
			const text = `Copied\n\n![Photo](${files_media_build_file_src(imageTarget.id)})\n`;
			const source = await private_text(f, { path: "/source.md", staged: embed === "copied" ? text : "Copied\n" });
			if (replacement)
				expect((await save(f, await private_text(f, { path: "/copy.md", staged: "Old\n" })))._nay).toBeUndefined();
			let copied = await copy_replacement({ f, source: source.target, targetName: "copy.md" });
			expect(copied.target.kind).toBe(replacement ? "saved" : "private");
			expect(copied.copiedFrom).toBeDefined();
			if (change === "deleted")
				expect(
					await f.asUser.mutation(api.files_nodes.archive_nodes, {
						membershipId: f.membershipId,
						nodeIds: [imageTarget.id],
					}),
				).toEqual({ _yay: null });
			else {
				const imageAsset = async () => (await f.t.run((ctx) => ctx.db.get("files_nodes", imageTarget.id)))?.assetId;
				const before = await imageAsset();
				const other = await media(f, "/other.png");
				const replaced = await copy_replacement({ f, source: other.pending.target, targetName: "photo.png" });
				expect((await save(f, replaced))._nay).toBeUndefined();
				expect(await imageAsset()).not.toBe(before);
			}
			if (embed === "added later") copied = await saved_proposal({ f, target: copied.target, staged: text });
			if (review) {
				const other = await private_text(f, { path: "/other.md", staged: "Other\n" });
				expect(
					(await bulk_save({ f, selected: [copied, other] }))?.activity,
					"an unselected deleted image never blocks a review",
				).toMatchObject({ status: "succeeded", progress: { completed: 2, blocked: 0 } });
			} else expect((await save(f, copied))._nay, `a ${change} image never blocks Save`).toBeUndefined();
			const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				...f.scope,
				path: "/copy.md",
				includePending: false,
			});
			expect(read?.content).toBe(text);
		},
	);
});

describe("Save near a draft move into a folder the member can no longer read", () => {
	/**
	 * A second member of the workspace, with the member role. The fixture user is the owner.
	 */
	async function member(f: Awaited<ReturnType<typeof fixture>>) {
		const v = await f.t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "media-save-member" });
			await test_mocks_fill_db_with.plan(ctx, { userId, plan: "Pay As You Go" });
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: f.scope.organizationId,
				workspaceId: f.scope.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, { ...f.scope, userId, role: "member", now: Date.now() });
			return { userId, membershipId };
		});
		return {
			...f,
			membershipId: v.membershipId,
			scope: { ...f.scope, userId: v.userId },
			asUser: f.t.withIdentity({ issuer: "https://clerk.test", external_id: v.userId }),
		};
	}

	async function saved_folder(f: Awaited<ReturnType<typeof fixture>>, path: string) {
		const created = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			path,
			kind: "folder",
		});
		if (created._nay) throw new Error(created._nay.message);
		const saved = await save(f, await proposal(f, created._yay.target));
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected a saved folder");
		return saved._yay.target;
	}

	/**
	 * The owner saves an image. The member links to the saved file.
	 */
	async function saved_media(f: Awaited<ReturnType<typeof fixture>>, path: string) {
		const image = await media(f, path);
		const saved = await save(f, image.pending);
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
		return files_media_build_file_src(saved._yay.target.id);
	}

	/**
	 * The member drafts `mv /proj /team/`, then the owner restricts /team without sharing it.
	 */
	async function block_proj(
		f: Awaited<ReturnType<typeof fixture>>,
		v: Awaited<ReturnType<typeof member>>,
		folders: { proj: { id: Id<"files_nodes"> }; team: { id: Id<"files_nodes"> } },
	) {
		const moved = await f.t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			...v.scope,
			target: { kind: "saved", id: folders.proj.id },
			destParent: { kind: "saved", id: folders.team.id },
			destName: "proj",
		});
		if (moved._nay) throw new Error(moved._nay.message);
		const restricted = await f.asUser.mutation(api.files_sharing.restrict_node, {
			membershipId: f.membershipId,
			nodeId: folders.team.id,
		});
		if (restricted._nay) throw new Error(restricted._nay.message);
	}

	test("a document inside the blocked moved folder still saves its media links", async () => {
		const f = await fixture();
		const v = await member(f);
		const proj = await saved_folder(f, "/proj");
		const team = await saved_folder(f, "/team");
		const doc = await save(f, await private_text(f, { path: "/proj/plan.md", staged: "Plan\n" }));
		if (doc._nay) throw new Error(doc._nay.message);
		const src = await saved_media(f, "/photo.png");
		const pending = await saved_proposal({ f: v, target: doc._yay.target, staged: `Plan\n\n![Photo](${src})\n` });
		await block_proj(f, v, { proj, team });

		// The document has no move of its own, so its row keeps Accept on.
		expect(
			await v.asUser.query(api.files_pending_target.get_file_pending_target, {
				membershipId: v.membershipId,
				target: pending.target,
			}),
		).toMatchObject({ entry: { path: "/proj/plan.md" }, canAccept: true, moveDestinationUnreadable: false });
		expect((await save(v, pending))._nay).toBeUndefined();
	});
});
