import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api.js";
import { test_save_file_pending_update, test_spy_handler } from "./setup.test.ts";
import { prepare_transfer_file_media } from "./files_nodes_content.ts";
import {
	mock_media_storage,
	save_media,
	fixture,
	read_dependencies,
	finish_document,
	copy_again,
} from "./files_transfer_media.setup.test.ts";

// Lower the media page from 50 to 3, so a few media cross it the same way 51 media cross the real page.
// The full-size test sets the real page back. Code inside files_media_dependencies.ts still uses 50.
const media_page = vi.hoisted(() => ({ size: 3 }));
vi.mock("./files_media_dependencies.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("./files_media_dependencies.ts")>()),
	get files_media_dependencies_PAGE_SIZE() {
		return media_page.size;
	},
}));

beforeEach(mock_media_storage);

afterEach(() => {
	media_page.size = 3;
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/**
 * Copy a document with `mediaCount` distinct media, check its dependency set and text, then Save it.
 */
async function adopt_media(row: { documentReplacement: boolean; mediaCount: number; mediaPages: number }) {
	const { documentReplacement, mediaCount, mediaPages } = row;

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
}

// Tests that adopt or clone a copied media set that needs more than one page. Each media file needs its
// own Save.
describe("copy_transfer_file media", () => {
	test("clones a same-workspace dependency set in pages without sharing its owner", async () => {
		const f = await fixture({ mediaCount: 4 });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		await finish_document(f);
		const original = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		const setId = original!.capture!.mediaDependencySetId!;
		const before = await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId));
		let pages = 0;
		test_spy_handler(prepare_transfer_file_media, async (handler, ctx, args) => {
			pages++;
			return await handler(ctx, args);
		});
		const clone = await copy_again({ f, source: original!.outputTarget!, targetName: "cloned.md" });
		expect(pages).toBe(2);
		expect(clone!.mediaDependencySetId).not.toBe(setId);
		expect(await read_dependencies(f.t, clone!.mediaDependencySetId)).toEqual(await read_dependencies(f.t, setId));
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toEqual(before);
		expect(
			await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", clone!.mediaDependencySetId!)),
		).toMatchObject({ count: 4, owner: { kind: "proposal", pendingUpdateId: clone!._id } });
	}, 120_000);

	// 4 media files fill one media page of 3 and start a second one, for a private and a saved output.
	test.each([
		{ documentReplacement: false, mediaCount: 4, mediaPages: 2 },
		{ documentReplacement: true, mediaCount: 4, mediaPages: 2 },
	])("adopts $mediaCount distinct media references (replacement: $documentReplacement)", adopt_media, 120_000);

	// 101 media files fill two real media pages of 50 and start a third one. With the document they are 102
	// sources, so the selection also needs a second intake page of 100. Each media file needs its own
	// Save, so this takes minutes. It runs only with test:files:full-size.
	test("adopts 101 distinct media references (replacement: false)", async () => {
		media_page.size = 50;
		await adopt_media({ documentReplacement: false, mediaCount: 101, mediaPages: 3 });
	}, 1_800_000);
});
