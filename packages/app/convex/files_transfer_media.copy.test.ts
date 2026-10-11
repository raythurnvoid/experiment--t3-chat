import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { test_save_file_pending_update } from "./setup.test.ts";
import { files_media_build_private_src } from "../shared/files-media.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import {
	files_headless_tiptap_editor_create,
	files_headless_tiptap_editor_get_markdown,
} from "../shared/files-tiptap.ts";
import {
	mock_media_storage,
	create_media,
	save_media,
	fixture,
	map_refs,
	read_dependencies,
} from "./files_transfer_media.setup.test.ts";

beforeEach(mock_media_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("copy_transfer_file media", () => {
	test("counts saved and private source aliases separately and saves their one destination", async () => {
		const f = await fixture({ aliases: true });
		expect(f.sourceRefs).toHaveLength(2);
		expect(f.selectedMediaItems).toHaveLength(1);
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(item).toMatchObject({ state: "completed", outputTarget: { kind: "private" } });
		const setId = item!.capture!.mediaDependencySetId!;
		const dependencies = await read_dependencies(f.t, setId);
		// Two source refs can map to one copied media file.
		expect(dependencies).toHaveLength(2);
		expect(new Set(dependencies.map((dependency) => dependency.src)).size).toBe(1);
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
			count: 2,
			expectedCount: 2,
			owner: { kind: "proposal" },
		});
		await save_media({
			t: f.t,
			membershipId: f.destination.membershipId,
			userId: f.destination.userId,
			target: f.selectedMedia!.outputTarget!,
		});
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target: item!.outputTarget!,
		});
		const pending = view!.entry.pendingUpdate!;
		const saved = await test_save_file_pending_update(f.asUser, {
			membershipId: f.destination.membershipId,
			target: pending.target,
			pendingUpdateId: pending._id,
			reviewedRevision: pending.revision,
		});
		expect(saved).toMatchObject({ _yay: { target: { kind: "saved" } } });
		const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: f.destination.organizationId,
			workspaceId: f.destination.workspaceId,
			userId: f.destination.userId,
			path: "/document.md",
			includePending: false,
		});
		expect(read?.content.split(dependencies[0]!.src)).toHaveLength(3);
		for (const src of f.sourceRefs) expect(read?.content).not.toContain(src);
	});

	test.each([false, true])("adopts an empty set for rich text (replacement: %s)", async (documentReplacement) => {
		const f = await fixture({ documentReplacement, selected: false, documentText: () => "No media yet\n" });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(item?.state).toBe("completed");
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
		expect(pending?.mediaDependencySetId).toBeDefined();
		const set = await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", pending!.mediaDependencySetId!));
		expect(set).toMatchObject({
			count: 0,
			expectedCount: 0,
			sealed: true,
			owner: { kind: "proposal", pendingUpdateId: pending!._id },
		});
		expect(pending).not.toHaveProperty("mediaDependencies");
	});

	test("rewrites a real video embed from personal to current", async () => {
		const f = await fixture({
			sourceWorkspace: "personal",
			video: true,
			documentText: (src) => `Before\n\n<video src="${src}" title="Clip"></video>\n\nAfter\n`,
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "completed",
		});
		const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: f.destination.organizationId,
			workspaceId: f.destination.workspaceId,
			userId: f.destination.userId,
			overlayUserId: f.destination.userId,
			path: "/document.md",
		});
		expect(read?.content).toContain(`src="${files_media_build_private_src(f.selectedMedia!.outputTarget!.id)}"`);
		expect(read?.content).toContain('title="Clip"');
		expect(read?.content).not.toContain(f.sourceRef);
	});

	test.each([false, true])("replacement Save waits for its media (media replacement: %s)", async (replacement) => {
		const f = await fixture({ documentReplacement: true, replacement });
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		if (item?.outputTarget?.kind !== "saved") throw new Error("Expected document replacement");
		const target = item.outputTarget;
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const pending = view!.entry.pendingUpdate!;
		const before = await f.t.run((ctx) => ctx.db.get("files_nodes", target.id));
		const args = {
			membershipId: f.destination.membershipId,
			target,
			pendingUpdateId: pending._id,
			reviewedRevision: pending.revision,
		};
		expect(await test_save_file_pending_update(f.asUser, args)).toMatchObject({
			_nay: { message: expect.stringContaining("Save the selected media") },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", target.id))).toEqual(before);
		expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
		await save_media({
			t: f.t,
			membershipId: f.destination.membershipId,
			userId: f.destination.userId,
			target: f.selectedMedia!.outputTarget!,
		});
		expect(await test_save_file_pending_update(f.asUser, args)).toMatchObject({
			_yay: { target },
		});
	});

	test("refuses a second Copy over private media before the first document mapping", async () => {
		const f = await fixture();
		expect(f.document.capture).toBeNull();
		const target = f.selectedMedia!.outputTarget!;
		expect(target.kind).toBe("private");
		const before = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const original = before!.entry.pendingUpdate!.createIntent!;
		if (original.kind !== "stored") throw new Error("Expected stored media");

		const other = await create_media({ t: f.t, scope: f.destination, path: "/other.png" });
		const thread = await f.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: f.destination.membershipId,
			clientGeneratedId: "replace-media-chat",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const started = await f.t.mutation(internal.files_transfer.start_for_agent, {
			membershipId: f.destination.membershipId,
			threadId: thread._yay.threadId,
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			requestId: "replace-copied-media",
			kind: "copy",
			expectedSourceCount: 1,
			sources: [other.target],
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: "photo.png",
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.t.mutation(internal.files_transfer.seal_for_agent, {
				membershipId: f.destination.membershipId,
				threadId: thread._yay.threadId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		for (let step = 0; step < 16; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			const item = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.unique(),
			);
			if (item?.state === "completed") {
				expect(item.outputTarget).toEqual(target);
				break;
			}
			if (item?.workId) {
				await f.t.action(internal.files_nodes_content.copy_transfer_file, {
					itemId: item._id,
					attempt: item.attempt,
				});
				await f.t.mutation(internal.files_transfer.handle_copy_complete, {
					workId: item.workId,
					context: { itemId: item._id, attempt: item.attempt },
					result: { kind: "success", returnValue: null },
				});
			}
		}
		const changed = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const replacement = changed!.entry.pendingUpdate!.createIntent!;
		if (replacement.kind !== "stored") throw new Error("Expected stored replacement");
		expect(replacement.assetId).not.toBe(original.assetId);
		expect(changed!.entry.pendingUpdate!.preparation).toBeUndefined();

		const uploads = () => vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === "PUT").length;
		const beforeUploads = uploads();
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			outputTarget: null,
		});
		expect(uploads()).toBe(beforeUploads);
		expect(
			await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: f.destination.membershipId,
				target,
			}),
		).toEqual(changed);

		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: f.document.workId!,
			context: { itemId: f.document._id, attempt: f.document.attempt },
			result: { kind: "success", returnValue: null },
		});
		await f.t.mutation(internal.files_transfer.advance, { runId: f.document.runId });
		const retried = await f.asUser.mutation(api.files_transfer.retry_remaining, {
			membershipId: f.current.membershipId,
			runId: f.document.runId,
			requestId: "retry-original-media",
		});
		if (retried._nay) throw new Error(retried._nay.message);
		for (let step = 0; step < 16; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: retried._yay.runId });
			const items = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", retried._yay.runId))
					.collect(),
			);
			const document = items.find((item) => item.source.id === f.document.source.id);
			if (!document?.workId) continue;
			expect(items.find((item) => item.source.id === f.media.target.id)).toMatchObject({
				state: "completed",
				capture: null,
				outputTarget: target,
				outputMediaAssetId: original.assetId,
			});
			await f.t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: document._id,
				attempt: document.attempt,
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", document._id))).toMatchObject({
				state: "failed",
				outputTarget: null,
			});
			expect(uploads()).toBe(beforeUploads);
			return;
		}
		throw new Error("Retried document worker did not start");
	});

	test("allows unchanged media Save before the first document mapping and then saves the document", async () => {
		const f = await fixture();
		expect(f.document.capture).toBeNull();
		const mediaTarget = f.selectedMedia!.outputTarget!;
		const before = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target: mediaTarget,
		});
		const original = before!.entry.pendingUpdate!.createIntent!;
		if (original.kind !== "stored") throw new Error("Expected stored media");
		const savedMedia = await save_media({
			t: f.t,
			membershipId: f.destination.membershipId,
			userId: f.destination.userId,
			target: mediaTarget,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", savedMedia.id))).toMatchObject({
			assetId: original.assetId,
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const item = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(item?.state).toBe("completed");
		expect(item?.outputMediaAssetId).toBeUndefined();
		const target = item!.outputTarget!;
		const view = await f.asUser.query(api.files_pending_updates.get_file_pending_target, {
			membershipId: f.destination.membershipId,
			target,
		});
		const pending = view!.entry.pendingUpdate!;
		expect(await read_dependencies(f.t, pending.mediaDependencySetId)).toEqual([
			expect.objectContaining({
				src: files_media_build_private_src(mediaTarget.id),
				target: mediaTarget,
				assetId: original.assetId,
				version: expect.objectContaining({ kind: "asset" }),
			}),
		]);
		expect(
			await test_save_file_pending_update(f.asUser, {
				membershipId: f.destination.membershipId,
				target,
				pendingUpdateId: pending._id,
				reviewedRevision: pending.revision,
			}),
		).toMatchObject({ _yay: { target: { kind: "saved" } } });
	});

	test("keeps the first media pins when the worker retries before upload", async () => {
		const f = await fixture();
		const claim = { itemId: f.document._id, attempt: f.document.attempt, workId: f.document.workId! };
		const editor = files_headless_tiptap_editor_create({ initialContent: { markdown: f.documentText } });
		if (editor._nay) throw new Error(editor._nay.message);
		const sourceTextDigest = await crypto_sha256_hex(
			files_headless_tiptap_editor_get_markdown({ mut_editor: editor._yay }),
		);
		editor._yay.destroy();
		const page = { expectedCount: 1, offset: 0, sourceTextDigest };
		await f.t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		const first = await f.t.mutation(internal.files_nodes_content.prepare_transfer_file_media, {
			...claim,
			...page,
			refs: [f.sourceRef],
		});
		expect(first._yay).toHaveLength(1);
		expect(
			await f.t.mutation(internal.files_nodes_content.prepare_transfer_file_media, {
				...claim,
				...page,
				expectedCount: 51,
				refs: Array.from({ length: 51 }, () => f.sourceRef),
			}),
		).toEqual({ _nay: { message: "Invalid media selection page" } });
		await f.t.run(async (ctx) => {
			const target = f.selectedMedia!.outputTarget!;
			const pending = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.destination.userId).eq("target.kind", target.kind).eq("target.id", target.id),
				)
				.first();
			await ctx.db.patch("files_pending_updates", pending!._id, { revision: pending!.revision + 1 });
		});
		expect(
			await f.t.mutation(internal.files_nodes_content.prepare_transfer_file_media, {
				...claim,
				...page,
				refs: [f.sourceRef],
			}),
		).toEqual(first);
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			outputTarget: null,
			errorMessage: "The copied media changed while this document was being copied. Try again.",
		});
	});

	test.each([false, true])(
		"rewrites only app media and stores destination pins (replacement: %s)",
		async (documentReplacement) => {
			const f = await fixture({
				documentReplacement,
				documentText: (src) =>
					`Before\n\n![Photo](${src})\n\n\`literal ${src}\`\n\n![External](https://example.test/photo.png)\n\nAfter\n`,
			});
			const mapped = await map_refs(f);
			if (!mapped._yay || !("mediaDependencies" in mapped._yay)) throw new Error("Expected media mapping");
			await f.t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: f.document._id,
				attempt: f.document.attempt,
			});
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
					.first(),
			);
			expect(await read_dependencies(f.t, pending!.mediaDependencySetId)).toEqual(mapped._yay.mediaDependencies);
			const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: f.destination.organizationId,
				workspaceId: f.destination.workspaceId,
				userId: f.destination.userId,
				overlayUserId: f.destination.userId,
				path: "/document.md",
			});
			expect(read?.content).toContain(`![Photo](${mapped._yay.mediaDependencies[0]!.src})`);
			expect(read?.content).toContain(`\`literal ${f.sourceRef}\``);
			expect(read?.content).toContain("![External](https://example.test/photo.png)");
		},
	);

	test("refuses an unselected dependency before uploading document output", async () => {
		const f = await fixture({ selected: false });
		const uploads = () => vi.mocked(globalThis.fetch).mock.calls.filter(([, init]) => init?.method === "PUT").length;
		const before = uploads();
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			errorMessage: "Select the linked image or video files with this document",
		});
		expect(uploads()).toBe(before);
	});

	test("refuses a media revision changed while the document uploads", async () => {
		const f = await fixture();
		const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
		let changed = false;
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			if (!changed && init?.method === "PUT") {
				changed = true;
				await f.t.run(async (ctx) => {
					const target = f.selectedMedia!.outputTarget!;
					const pending = await ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", f.destination.userId).eq("target.kind", target.kind).eq("target.id", target.id),
						)
						.first();
					await ctx.db.patch("files_pending_updates", pending!._id, { revision: pending!.revision + 1 });
				});
			}
			return await fetch(input, init);
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect(changed).toBe(true);
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "failed",
			outputTarget: null,
			errorMessage: "The copied media changed while this document was being copied. Try again.",
		});
	});
});
