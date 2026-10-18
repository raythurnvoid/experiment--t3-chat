import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { r2_server_side_copy } from "./r2_client.ts";
import { files_media_dependencies_db_create, files_media_dependencies_db_seal } from "./files_media_dependencies.ts";
import { files_media_validation_db_capture_versions } from "./files_media_validation.ts";
import { test_create_saved_text_file, test_finish_saved_scope_jobs } from "./setup.test.ts";
import { crypto_sha256_hex } from "../server/crypto-utils.ts";
import { files_media_build_file_src, files_media_build_private_src } from "../shared/files-media.ts";
import { start_agent_transfer, start_transfer } from "./files_transfer.setup.test.ts";
import {
	mock_scope_copy_storage,
	fixture,
	media_proposal,
	save_proposal,
	start_copy,
	copy_files,
} from "./files_transfer_scopes_content.setup.test.ts";

beforeEach(mock_scope_copy_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("same-workspace document Copy", () => {
	test("copies a document with a missing image and keeps its exact link", async () => {
		const f = await fixture();
		const media = await media_proposal({ f, workspace: "current" });
		const saved = await save_proposal({ f, workspace: "current", target: media });
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
		const mediaId = saved._yay.target.id;
		const src = files_media_build_file_src(mediaId);
		const documentId = await test_create_saved_text_file(f.t, {
			membershipId: f.current.membershipId,
			path: "/document.md",
			textContent: `Keep **bold** and <span data-type="comment" data-lb-thread-id="old-thread">these words</span>.\n\n![Photo](${src})\n`,
		});
		// A link can outlive the media after its archived file is purged.
		await f.t.run((ctx) => ctx.db.delete("files_nodes", mediaId));
		expect(
			await f.asUser.query(api.r2.get_media_by_reference, {
				membershipId: f.current.membershipId,
				src,
			}),
		).toBeNull();
		const items = await copy_files(f, {
			sources: [{ kind: "saved", id: documentId }],
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			targetName: "copy.md",
		});
		expect(items[0], items[0]?.errorMessage ?? "Copy should complete").toMatchObject({ state: "completed" });
		const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: f.current.organizationId,
			workspaceId: f.current.workspaceId,
			userId: f.current.userId,
			subject: { kind: "user", userId: f.current.userId, plugin: null },
			overlayUserId: f.current.userId,
			path: "/copy.md",
		});
		expect(read?.content).toContain(`![Photo](${src})`);
		expect(read?.content).toContain("Keep **bold** and these words.");
		expect(read?.content).not.toContain("old-thread");
		expect(items[0]!.capture?.mediaDependencySetId).toBeUndefined();
		expect(await save_proposal({ f, workspace: "current", target: items[0]!.outputTarget! })).toHaveProperty("_yay");
	});

	test.each(["other user's private", "hidden", "wrong workspace", "unready", "changed"] as const)(
		"keeps a %s video link without copying its media",
		async (fault) => {
			const f = await fixture();
			const workspace = fault === "wrong workspace" ? "personal" : "current";
			let src: string;
			let mediaId: Id<"files_nodes"> | undefined;
			if (fault === "unready") {
				const uploading = await f.asUser.mutation(api.files_nodes.create_upload_node, {
					membershipId: f.current.membershipId,
					parentId: "root",
					filename: "clip.mp4",
					contentType: "video/mp4",
					size: 4,
				});
				if (uploading._nay) throw new Error(uploading._nay.message);
				mediaId = uploading._yay.nodeId;
				src = files_media_build_file_src(mediaId);
			} else {
				const media = await media_proposal({
					f: fault === "other user's private" ? { ...f, current: f.owner } : f,
					workspace,
					path: "/clip.mp4",
				});
				src = files_media_build_private_src(media.id);
				if (fault !== "other user's private") {
					const saved = await save_proposal({ f, workspace, target: media });
					if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
					mediaId = saved._yay.target.id;
					src = files_media_build_file_src(mediaId);
				}
			}
			const documentId = await test_create_saved_text_file(f.t, {
				membershipId: f.current.membershipId,
				path: "/document.md",
				textContent: `Before\n\n<video src="${src}" title="Clip"></video>\n\nAfter\n`,
			});
			if (fault === "hidden") {
				expect(
					await f.asOwner.mutation(api.files_sharing.restrict_node, {
						membershipId: f.owner.membershipId,
						nodeId: mediaId!,
					}),
				).toEqual({ _yay: null });
				await test_finish_saved_scope_jobs(f.t);
			}
			let changed = false;
			if (fault === "changed") {
				const fetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
				vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
					if (!changed && init?.method === "PUT") {
						changed = true;
						expect(
							await f.asUser.mutation(api.files_nodes.archive_nodes, {
								membershipId: f.current.membershipId,
								nodeIds: [mediaId!],
							}),
						).toHaveProperty("_yay");
					}
					return await fetch(input, init);
				});
			}
			const unreadable = fault === "hidden" || fault === "other user's private" || fault === "wrong workspace";
			// A restricted saved file is locked, not missing.
			const locked = fault === "hidden" ? { status: "locked" } : null;
			if (unreadable)
				expect(
					await f.asUser.query(api.r2.get_media_by_reference, {
						membershipId: f.current.membershipId,
						src,
					}),
				).toEqual(locked);
			const callsBefore = vi.mocked(globalThis.fetch).mock.calls.length;
			const copiesBefore = vi.mocked(r2_server_side_copy.copy_object).mock.calls.length;
			const items = await copy_files(f, {
				sources: [{ kind: "saved", id: documentId }],
				sourceWorkspace: "current",
				destinationWorkspace: "current",
				targetName: "copy.md",
			});
			expect(items[0], items[0]?.errorMessage ?? "Copy should complete").toMatchObject({ state: "completed" });
			expect(items[0]!.capture?.mediaDependencySetId).toBeUndefined();
			if (fault === "changed") expect(changed).toBe(true);
			expect(vi.mocked(r2_server_side_copy.copy_object).mock.calls).toHaveLength(copiesBefore);
			const calls = vi.mocked(globalThis.fetch).mock.calls.slice(callsBefore);
			// Only the document's text and snapshot are uploaded.
			expect(calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(2);
			const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				organizationId: f.current.organizationId,
				workspaceId: f.current.workspaceId,
				userId: f.current.userId,
				subject: { kind: "user", userId: f.current.userId, plugin: null },
				overlayUserId: f.current.userId,
				path: "/copy.md",
			});
			expect(read?.content).toContain(`src="${src}"`);
			if (unreadable)
				expect(
					await f.asUser.query(api.r2.get_media_by_reference, {
						membershipId: f.current.membershipId,
						src,
					}),
				).toEqual(locked);
		},
	);

	test("keeps a broken link when current and personal resolve to the same workspace", async () => {
		const original = await fixture();
		const thread = await original.asUser.mutation(api.ai_chat.thread_create, {
			membershipId: original.personal.membershipId,
			clientGeneratedId: "personal-copy-chat",
			lastMessageAt: Date.now(),
		});
		if (thread._nay) throw new Error(thread._nay.message);
		const f = { ...original, current: original.personal, threadId: thread._yay.threadId };
		const src = "bonobo-file://missing-image";
		const documentId = await test_create_saved_text_file(f.t, {
			membershipId: f.current.membershipId,
			path: "/document.md",
			textContent: `![Photo](${src})\n`,
		});
		const items = await copy_files(f, {
			sources: [{ kind: "saved", id: documentId }],
			sourceWorkspace: "current",
			destinationWorkspace: "personal",
			targetName: "copy.md",
		});
		expect(items[0], items[0]?.errorMessage ?? "Copy should complete").toMatchObject({ state: "completed" });
		expect(items[0]!.capture?.mediaDependencySetId).toBeUndefined();
		const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: f.personal.organizationId,
			workspaceId: f.personal.workspaceId,
			userId: f.personal.userId,
			subject: { kind: "user", userId: f.personal.userId, plugin: null },
			overlayUserId: f.personal.userId,
			path: "/copy.md",
		});
		expect(read?.content).toBe(`![Photo](${src})\n`);
	});

	test("resumes an older same-workspace Copy and retires its prepared media set", async () => {
		const f = await fixture();
		const text = "Resume this Copy\n";
		const documentId = await test_create_saved_text_file(f.t, {
			membershipId: f.current.membershipId,
			path: "/document.md",
			textContent: text,
		});
		const started = await start_copy({
			f,
			source: { kind: "saved", id: documentId },
			sourceWorkspace: "current",
			destinationWorkspace: "current",
		});
		expect(
			await f.t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
				itemId: started.item._id,
				attempt: started.item.attempt,
			}),
		).toHaveProperty("_yay");
		const sourceTextDigest = await crypto_sha256_hex(text);
		const setId = await f.t.run(async (ctx) => {
			const item = await ctx.db.get("files_transfer_items", started.item._id);
			const created = await files_media_dependencies_db_create(ctx, {
				organizationId: f.current.organizationId,
				workspaceId: f.current.workspaceId,
				userId: f.current.userId,
				owner: { kind: "capture", itemId: item!._id },
				expectedCount: 0,
			});
			if (created._nay) throw new Error(created._nay.message);
			const pins = await files_media_validation_db_capture_versions(ctx, {
				userId: f.current.userId,
				scopes: [f.current],
			});
			// Old media preparation left the text digest null until the document was sealed.
			await ctx.db.patch("files_media_dependency_sets", created._yay, {
				captureProof: {
					attempt: started.item.attempt,
					workId: started.claim.workId,
					sourceTextDigest,
					textDigest: null,
					validatedCount: 0,
					...pins,
				},
			});
			await ctx.db.patch("files_transfer_items", item!._id, {
				capture: { ...item!.capture!, mediaDependencySetId: created._yay },
			});
			expect(await files_media_dependencies_db_seal(ctx, { setId: created._yay, generation: 0 })).toEqual({
				_yay: null,
			});
			return created._yay;
		});
		await f.t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: started.claim.workId,
			context: { itemId: started.item._id, attempt: started.item.attempt },
			result: { kind: "failed", error: "Worker stopped before document seal" },
		});
		await f.t.mutation(internal.files_transfer.advance, { runId: started.runId });
		const retried = await f.t.run((ctx) => ctx.db.get("files_transfer_items", started.item._id));
		expect(retried!.attempt).toBe(started.item.attempt + 1);
		expect(retried!.capture!.mediaDependencySetId).toBe(setId);
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
			owner: { kind: "capture" },
			captureProof: { textDigest: null },
		});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: retried!._id,
			attempt: retried!.attempt,
		});
		const completed = await f.t.run((ctx) => ctx.db.get("files_transfer_items", retried!._id));
		expect(completed, completed?.errorMessage ?? "Resumed Copy should complete").toMatchObject({ state: "completed" });
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
			owner: { kind: "cleanup" },
			generation: 1,
		});
	});

	test("clipboard Copy publishes a document with its archived image link", async () => {
		const f = await fixture();
		const media = await media_proposal({ f, workspace: "current" });
		const saved = await save_proposal({ f, workspace: "current", target: media });
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
		const src = files_media_build_file_src(saved._yay.target.id);
		const documentId = await test_create_saved_text_file(f.t, {
			membershipId: f.current.membershipId,
			path: "/document.md",
			textContent: `![Photo](${src})\n`,
		});
		const archived = await f.asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: f.current.membershipId,
			nodeIds: [saved._yay.target.id],
		});
		expect(archived).toEqual({ _yay: null });
		expect(
			await f.asUser.query(api.r2.get_media_by_reference, {
				membershipId: f.current.membershipId,
				src,
			}),
		).toBeNull();
		const folder = await f.asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: f.current.membershipId,
			parentId: "root",
			path: "/copies",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const started = await start_transfer(f.asUser, {
			membershipId: f.current.membershipId,
			requestId: "clipboard-copy",
			kind: "copy",
			sourceIds: [documentId],
			targetParentId: folder._yay.nodeId,
		});
		if (started._nay) throw new Error(started._nay.message);
		for (let step = 0; step < 64; step++) {
			await f.t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			const item = await f.t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.first(),
			);
			if (item?.state === "completed" || item?.state === "failed") break;
			if (!item?.workId) continue;
			await f.t.action(internal.files_nodes_content.copy_transfer_file, { itemId: item._id, attempt: item.attempt });
			await f.t.mutation(internal.files_transfer.handle_copy_complete, {
				workId: item.workId,
				context: { itemId: item._id, attempt: item.attempt },
				result: { kind: "success", returnValue: null },
			});
		}
		const output = await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
			membershipId: f.current.membershipId,
			path: "/copies/document.md",
		});
		expect(output).toMatchObject({ target: { kind: "saved" } });
		const read = await f.t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			organizationId: f.current.organizationId,
			workspaceId: f.current.workspaceId,
			userId: f.current.userId,
			subject: { kind: "user", userId: f.current.userId, plugin: null },
			path: "/copies/document.md",
			includePending: false,
		});
		expect(read?.content).toBe(`![Photo](${src})\n`);
	});

	test("refuses an actual selected image the actor cannot read", async () => {
		const f = await fixture();
		const media = await media_proposal({ f, workspace: "current" });
		const saved = await save_proposal({ f, workspace: "current", target: media });
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved media");
		expect(
			await f.asOwner.mutation(api.files_sharing.restrict_node, {
				membershipId: f.owner.membershipId,
				nodeId: saved._yay.target.id,
			}),
		).toEqual({ _yay: null });
		await test_finish_saved_scope_jobs(f.t);
		const started = await start_agent_transfer(f.t, {
			membershipId: f.current.membershipId,
			threadId: f.threadId,
			sources: [saved._yay.target],
			sourceWorkspace: "current",
			destinationWorkspace: "current",
			requestId: "hidden-image-copy",
			kind: "copy",
			targetParent: { kind: "root" },
			targetPath: "/",
			targetName: "copy.png",
			missingParentNames: [],
			conflictPolicy: { file: "replace", folder: "error" },
		});
		if (started._nay) throw new Error(started._nay.message);
		const view = await f.asUser.query(api.files_transfer_queries.get, {
			membershipId: f.current.membershipId,
			runId: started._yay.runId,
		});
		expect(view?.activity).toMatchObject({ status: "failed", errorMessage: "Permission denied" });
		expect(
			await f.asUser.query(api.files_nodes.get_visible_target_by_path, {
				membershipId: f.current.membershipId,
				path: "/copy.png",
			}),
		).toBeNull();
	});
});
