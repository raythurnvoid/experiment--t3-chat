import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_save_file_pending_update, test_spy_handler } from "./setup.test.ts";
import { prepare_transfer_file_media } from "./files_nodes_content.ts";
import {
	mock_media_storage,
	create_media,
	save_media,
	fixture,
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

// Tests whose media need more than one page of 50.
describe("copy_transfer_file media pages", () => {
	test("does not repin media replaced between validation pages", async () => {
		const f = await fixture({ mediaCount: 51 });
		const capture = await prepare_document_capture(f);
		const validate = { itemId: capture.itemId, attempt: capture.attempt, workId: capture.workId, text: capture.text };
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 50, isDone: false } });
		const other = await create_media({ t: f.t, scope: f.destination, path: "/other.png" });
		const replacement = await copy_again({ f, source: other.target, targetName: "photo.png" });
		if (replacement?.createIntent?.kind !== "stored") throw new Error("Expected replacement media");
		expect(replacement.createIntent.assetId).not.toBe(f.selectedMedia!.outputMediaAssetId);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 50 }),
		).toHaveProperty("_nay");
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toMatchObject({ _nay: { message: "The copied media changed while this document was being copied. Try again." } });
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toHaveProperty(
			"_nay",
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "copying",
			outputTarget: null,
		});
		expect(
			await f.t.run((ctx) =>
				ctx.db.get(
					"files_r2_assets",
					replacement.createIntent!.kind === "stored" ? replacement.createIntent!.assetId : other.assetId,
				),
			),
		).not.toBeNull();
	}, 120_000);

	test("clones a same-workspace dependency set in pages without sharing its owner", async () => {
		const f = await fixture({ mediaCount: 51 });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		await finish_document(f);
		const original = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		const setId = original!.capture!.mediaDependencySetId!;
		const before = await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId));
		const clone = await copy_again({ f, source: original!.outputTarget!, targetName: "cloned.md" });
		expect(clone!.mediaDependencySetId).not.toBe(setId);
		expect(await read_dependencies(f.t, clone!.mediaDependencySetId)).toEqual(await read_dependencies(f.t, setId));
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toEqual(before);
		expect(
			await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", clone!.mediaDependencySetId!)),
		).toMatchObject({ count: 51, owner: { kind: "proposal", pendingUpdateId: clone!._id } });
	}, 120_000);

	test("rejects a source ACL change after the first validation page without changing P", async () => {
		const f = await fixture({ mediaCount: 51 });
		const capture = await prepare_document_capture(f);
		const validate = { itemId: capture.itemId, attempt: capture.attempt, workId: capture.workId, text: capture.text };
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 50, isDone: false } });
		const pendingVersions = await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").collect());
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: f.media.target.id as Id<"files_nodes">,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").collect())).toEqual(pendingVersions);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 50 }),
		).toMatchObject({ _nay: { message: "Media access changed during validation. Try again." } });
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toHaveProperty(
			"_nay",
		);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "copying",
			outputTarget: null,
		});
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toMatchObject({ _nay: { message: "A linked media file is not available" } });
		for (const media of f.selectedMediaItems)
			expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", media.outputMediaAssetId!))).not.toBeNull();
	}, 120_000);

	test("rechecks pages after media Save and binds final adoption to exact text", async () => {
		const f = await fixture({ mediaCount: 51 });
		const capture = await prepare_document_capture(f);
		const validate = { itemId: capture.itemId, attempt: capture.attempt, workId: capture.workId, text: capture.text };
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 50, isDone: false } });
		await save_media({
			t: f.t,
			membershipId: f.destination.membershipId,
			userId: f.destination.userId,
			target: f.selectedMedia!.outputTarget!,
		});
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 50 }),
		).toHaveProperty("_nay");
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 50, isDone: false } });
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 50 }),
		).toEqual({ _yay: { offset: 51, isDone: true } });
		expect(
			await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, {
				...capture,
				text: `${capture.text}\nDifferent bytes`,
			}),
		).toHaveProperty("_nay");
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "copying",
			outputTarget: null,
		});
		expect(await f.t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, capture)).toEqual({
			_yay: null,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "completed",
		});
	}, 120_000);

	// 101 media files fill two media pages of 50 and start a third one. With the document they are
	// 102 sources, so the selection also needs a second intake page of 100. The replacement row
	// uses 51 media files: that still needs a second media page, at about half the cost.
	test.each([
		{ documentReplacement: false, mediaCount: 101, mediaPages: 3 },
		{ documentReplacement: true, mediaCount: 51, mediaPages: 2 },
	])(
		"adopts $mediaCount distinct media references (replacement: $documentReplacement)",
		async ({ documentReplacement, mediaCount, mediaPages }) => {
			const f = await fixture({ mediaCount, documentReplacement });
			expect(f.selectedMediaItems).toHaveLength(mediaCount);
			expect(f.selectedMediaItems.every((item) => item.state === "completed")).toBe(true);
			let pages = 0;
			test_spy_handler(prepare_transfer_file_media, async (handler, ctx, args) => {
				pages++;
				return await handler(ctx, args);
			});
			await f.t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: f.document._id,
				attempt: f.document.attempt,
			});
			expect(pages).toBe(mediaPages);
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
					.unique(),
			);
			const dependencies = await read_dependencies(f.t, pending!.mediaDependencySetId);
			expect(dependencies).toHaveLength(mediaCount);
			expect(new Set(dependencies.map((dependency) => dependency.assetId)).size).toBe(mediaCount);
			expect(new Set(dependencies.map((dependency) => dependency.assetId))).toEqual(
				new Set(f.selectedMediaItems.map((media) => media.outputMediaAssetId)),
			);
			expect(
				await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", pending!.mediaDependencySetId!)),
			).toMatchObject({
				count: mediaCount,
				expectedCount: mediaCount,
				sealed: true,
				owner: { kind: "proposal", pendingUpdateId: pending!._id },
			});
			const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: f.destination.organizationId,
				workspaceId: f.destination.workspaceId,
				userId: f.destination.userId,
				overlayUserId: f.destination.userId,
				path: "/document.md",
			});
			for (const dependency of dependencies) expect(read?.content).toContain(`![Photo](${dependency.src})`);
			for (const src of f.sourceRefs) expect(read?.content).not.toContain(src);
			for (const media of f.selectedMediaItems)
				await save_media({
					t: f.t,
					membershipId: f.destination.membershipId,
					userId: f.destination.userId,
					target: media.outputTarget!,
				});
			expect(
				await test_save_file_pending_update(f.asUser, {
					membershipId: f.destination.membershipId,
					target: item!.outputTarget!,
					pendingUpdateId: pending!._id,
					reviewedRevision: pending!.revision,
				}),
			).toMatchObject({ _yay: { target: { kind: "saved" } } });
			for (const dependency of dependencies)
				expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", dependency.assetId))).not.toBeNull();
		},
		120_000,
	);
});
