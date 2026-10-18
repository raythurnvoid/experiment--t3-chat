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

// Lower the media page from 50 to 3, so 4 media fill one page and start a second one, like 51 media
// do with the real page. Code inside files_media_dependencies.ts still uses its own value of 50.
vi.mock("./files_media_dependencies.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("./files_media_dependencies.ts")>()),
	files_media_dependencies_PAGE_SIZE: 3,
}));

beforeEach(mock_media_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// Validation tests whose media need more than one page. Each media file needs its own Save.
describe("copy_transfer_file media", () => {
	test("does not repin media replaced between validation pages", async () => {
		const f = await fixture({ mediaCount: 4 });
		const capture = await prepare_document_capture(f);
		const validate = { itemId: capture.itemId, attempt: capture.attempt, workId: capture.workId, text: capture.text };
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 3, isDone: false } });
		const other = await create_media({ t: f.t, scope: f.destination, path: "/other.png" });
		const replacement = await copy_again({ f, source: other.target, targetName: "photo.png" });
		if (replacement?.createIntent?.kind !== "stored") throw new Error("Expected replacement media");
		expect(replacement.createIntent.assetId).not.toBe(f.selectedMedia!.outputMediaAssetId);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 3 }),
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

	test("rejects a source ACL change after the first validation page without changing P", async () => {
		const f = await fixture({ mediaCount: 4 });
		const capture = await prepare_document_capture(f);
		const validate = { itemId: capture.itemId, attempt: capture.attempt, workId: capture.workId, text: capture.text };
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 3, isDone: false } });
		const pendingVersions = await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").collect());
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: f.media.target.id as Id<"files_nodes">,
			}),
		).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.query("files_pending_review_versions").collect())).toEqual(pendingVersions);
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 3 }),
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
		).toMatchObject({ _nay: { message: "Permission denied: a linked image or video is locked" } });
		for (const media of f.selectedMediaItems)
			expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", media.outputMediaAssetId!))).not.toBeNull();
	}, 120_000);

	test("rechecks pages after media Save and binds final adoption to exact text", async () => {
		const f = await fixture({ mediaCount: 4 });
		const capture = await prepare_document_capture(f);
		const validate = { itemId: capture.itemId, attempt: capture.attempt, workId: capture.workId, text: capture.text };
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 3, isDone: false } });
		await save_media({
			t: f.t,
			membershipId: f.destination.membershipId,
			userId: f.destination.userId,
			target: f.selectedMedia!.outputTarget!,
		});
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 3 }),
		).toHaveProperty("_nay");
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 0 }),
		).toEqual({ _yay: { offset: 3, isDone: false } });
		expect(
			await f.t.mutation(internal.files_nodes_content.validate_transfer_file_media, { ...validate, offset: 3 }),
		).toEqual({ _yay: { offset: 4, isDone: true } });
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
});
