import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
	mock_media_storage,
	create_media,
	save_media,
	fixture,
	prepare_document_capture,
	copy_again,
} from "./files_transfer_media.setup.test.ts";

beforeEach(mock_media_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// Validation tests whose media need more than one page of 50. Each of the 51 media files needs its own
// Save, which takes 2 to 3 minutes on a busy machine, so these tests may take 5 minutes.
describe("copy_transfer_file media", () => {
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
	}, 300_000);

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
	}, 300_000);

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
	}, 300_000);
});
