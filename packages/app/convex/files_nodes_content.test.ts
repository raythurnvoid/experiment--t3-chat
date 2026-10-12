import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { applyUpdate, Doc as YjsDoc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { api, internal } from "./_generated/api.js";
import {
	test_convex,
	test_create_saved_text_file,
	test_get_file_yjs_pointers,
	test_mocks_fill_db_with,
	test_save_file_pending_update,
	test_spy_handler,
} from "./setup.test.ts";
import {
	r2_create_asset_key,
	r2_confirmed_object_delete,
	r2_PUT_MAY_ARRIVE_MARGIN_MS,
	r2_server_side_copy,
} from "./r2_client.ts";
import { files_ROOT_ID, files_u8_to_array_buffer, files_YJS_DOC_KEYS } from "../shared/files.ts";
import { files_nodes_db_hard_delete_node } from "./files_nodes.ts";
import { copy_transfer_file } from "./files_nodes_content.ts";
import { files_pending_nodes_db_discard } from "./files_pending_nodes.ts";
import { activities_db_require_by_source_id } from "./activities_db.ts";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
	objects,
	mock_nodes_content_storage,
	create_file_fixture,
	create_private_text_fixture,
	create_transfer_copy_item,
	create_sealed_transfer_capture,
	saved_copy_id,
	start_agent_copy,
	create_private_copy_source,
	create_pending_proposal,
	expect_retired_uploads,
} from "./files_nodes_content.setup.test.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

beforeEach(mock_nodes_content_storage);

describe("public private text Save", () => {
	test.each([false, true])(
		"publishes complete text with collaboration %s and settles storage above the new cap",
		async (collaborationEnabled) => {
			const { t, db, asUser, proposal, target, text } = await create_private_text_fixture(collaborationEnabled);
			await t.run(async (ctx) => {
				for (const hold of await ctx.db.query("files_private_storage_reservations").collect()) {
					await ctx.db.patch("quotas", hold.userQuotaId, { maxCount: 0 });
					if (hold.workspaceQuotaId) await ctx.db.patch("quotas", hold.workspaceQuotaId, { maxCount: 0 });
				}
				expect(await ctx.db.query("files_nodes").collect()).toEqual([]);
			});
			const result = await test_save_file_pending_update(asUser, {
				membershipId: db.membershipId,
				target,
				pendingUpdateId: proposal._id,
				reviewedRevision: proposal.revision,
			});
			if (result._nay) throw new Error(result._nay.message);
			const savedTarget = result._yay.target;
			if (savedTarget.kind !== "saved") throw new Error("Expected the saved text");
			await t.run(async (ctx) => {
				const node = await ctx.db.get("files_nodes", savedTarget.id);
				expect(node).toMatchObject({
					path: "/private.txt",
					assetId: expect.any(String),
					textKind: "plain_text",
					collaborationEnabled,
				});
				const chunks = await ctx.db.query("files_text_chunks").collect();
				expect(chunks.map((chunk) => chunk.textChunk).join("")).toBe(text);
				expect(await ctx.db.query("files_snapshots").collect()).toMatchObject([
					{ fileNodeId: result._yay.target.id, assetId: node!.assetId },
				]);
				expect(await ctx.db.query("files_pending_node_publish_receipts").collect()).toMatchObject([
					{
						privateNodeId: target.id,
						savedNodeId: result._yay.target.id,
						proposalRevision: proposal.revision,
					},
				]);
				expect(await ctx.db.get("files_pending_nodes", target.id as Id<"files_pending_nodes">)).toMatchObject({
					state: "published",
					creationGeneration: 2,
				});
				const holds = await ctx.db.query("files_private_storage_reservations").collect();
				expect(
					holds.find((hold) => hold.resource.kind === "node" && hold.resource.id === target.id)?.settlement.kind,
				).toBe("saved");
				for (const hold of holds) {
					expect(await ctx.db.get("quotas", hold.userQuotaId)).toMatchObject({ usedCount: 0 });
				}
				if (collaborationEnabled) {
					expect(await ctx.db.get("files_yjs_docs_last_sequences", node!.yjsLastSequenceId!)).toMatchObject({
						lastSequence: 0,
						lineageGeneration: 0,
					});
				} else {
					expect(node!.yjsLastSequenceId).toBeNull();
					expect(await ctx.db.query("files_yjs_snapshots").collect()).toEqual([]);
				}
			});
		},
	);

	test("refuses a saved name collision without publishing assets or settling the draft", async () => {
		const { t, db, asUser, proposal, target } = await create_private_text_fixture(false);
		const occupant = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "/private.txt",
		});
		expect(occupant._nay).toBeUndefined();
		const holdsBefore = await t.run((ctx) => ctx.db.query("files_private_storage_reservations").collect());
		const result = await test_save_file_pending_update(asUser, {
			membershipId: db.membershipId,
			target,
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
		});
		expect(result._nay).toBeDefined();
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_nodes").collect()).toHaveLength(1);
			expect(await ctx.db.query("files_snapshots").collect()).toEqual([]);
			expect(await ctx.db.query("files_pending_node_publish_receipts").collect()).toEqual([]);
			expect(await ctx.db.get("files_pending_nodes", target.id as Id<"files_pending_nodes">)).toMatchObject({
				state: "active",
				creationGeneration: 1,
			});
			expect(await ctx.db.query("files_private_storage_reservations").collect()).toEqual(holdsBefore);
		});
	});
});

describe("private text publication", () => {
	test.each(["html", "htm"])("keeps %s source through saves, collaboration changes, and restore", async (extension) => {
		vi.useFakeTimers();
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
		const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
		const text = "<!doctype html>\n<html><head><title>Brief</title></head><body><p>Original</p></body></html>\n";
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: `/brief.${extension}`,
			textContent: text,
		});
		const snapshot = await t.run((ctx) => ctx.db.query("files_snapshots").first());
		if (!snapshot) throw new Error("Missing HTML snapshot");
		expect(snapshot).toMatchObject({ contentType: "text/html;charset=utf-8", yjsRootKind: "plain_text" });
		const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: db.membershipId,
			nodeId,
			acknowledgeDropCollaborativeHistory: true,
		});
		expect(off._nay).toBeUndefined();
		const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
			membershipId: db.membershipId,
			nodeId,
			text: text.replace("Original", "Saved"),
		});
		expect(saved._nay).toBeUndefined();
		expect(
			await asUser.query(api.files_nodes_content.get_non_collaborative_file_content, {
				membershipId: db.membershipId,
				nodeId,
			}),
		).toEqual({ _yay: { text: text.replace("Original", "Saved"), textKind: "plain_text" } });
		for (const task of await t.run((ctx) => ctx.db.query("files_yjs_cleanup_tasks").collect())) {
			await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
		}
		const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
			membershipId: db.membershipId,
			nodeId,
		});
		expect(on._nay).toBeUndefined();
		const restored = await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
			membershipId: db.membershipId,
			nodeId,
			snapshotId: snapshot._id,
			sessionId: "restore-html",
		});
		expect(restored._nay).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
			contentType: "text/html;charset=utf-8",
			textKind: "plain_text",
			collaborationEnabled: true,
		});
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			path: `/brief.${extension}`,
		});
		expect(read?.content).toBe(text);
	});
});

describe("copy_transfer_file", () => {
	test("publishes both copies once when another worker publishes after validation", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture("rich_text", "First file\n");
		const { t, db, asUser, nodeId } = fixture;
		const secondId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/second.md",
			textContent: "Second file\n",
		});
		const folder = await asUser.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			path: "/copies",
		});
		if (folder._nay) throw new Error(folder._nay.message);
		const started = await asUser.mutation(api.files_transfer.start, {
			membershipId: db.membershipId,
			requestId: "parallel-copy",
			kind: "copy",
			expectedSourceCount: 2,
			sourceIds: [nodeId, secondId],
			targetParentId: folder._yay.nodeId,
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await asUser.mutation(api.files_transfer.seal, {
				membershipId: db.membershipId,
				runId: started._yay.runId,
			}),
		).toEqual({ _yay: null });
		let items: Doc<"files_transfer_items">[] = [];
		for (let step = 0; step < 20; step++) {
			await t.mutation(internal.files_transfer.advance, { runId: started._yay.runId });
			items = await t.run((ctx) =>
				ctx.db
					.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
					.collect(),
			);
			if (items.length === 2 && items.every((item) => item.workId)) break;
		}
		expect(items.map((item) => item.state)).toEqual(["copying", "copying"]);
		const sources = await t.run(async (ctx) =>
			Promise.all([nodeId, secondId].map((id) => ctx.db.get("files_nodes", id))),
		);
		let releaseValidation!: () => void;
		const bothValidated = new Promise<void>((resolve) => {
			releaseValidation = resolve;
		});
		let validationCalls = 0;
		let publicationCalls = 0;
		// Hold the first two finished pages outside their transactions. Both proofs then pin the
		// same clocks. No embeds, so publication skips the clock check.
		test_spy_handler(copy_transfer_file, async (handler, ctx, args) => {
			const runMutation = ctx.runMutation.bind(ctx);
			vi.spyOn(ctx, "runMutation").mockImplementation(async (...mutationArgs) => {
				const reference = mutationArgs[0];
				const result = await runMutation(reference, mutationArgs[1], mutationArgs[2]);
				if (getFunctionName(reference) === "files_nodes_content:validate_transfer_file_media") {
					validationCalls += 1;
					if (validationCalls === 2) releaseValidation();
					if (validationCalls <= 2) await bothValidated;
				}
				if (getFunctionName(reference) === "files_nodes_content:finalize_transfer_file_copy") publicationCalls += 1;
				return result;
			});
			return await handler(ctx, args);
		});
		await Promise.all(
			items.map((item) =>
				t.action(internal.files_nodes_content.copy_transfer_file, {
					itemId: item._id,
					attempt: item.attempt,
				}),
			),
		);
		for (const [index, item] of items.entries()) {
			const completed = await t.run((ctx) => ctx.db.get("files_transfer_items", item._id));
			expect(completed).toMatchObject({ state: "completed", errorMessage: null });
			const saved = await t.run((ctx) => ctx.db.get("files_nodes", saved_copy_id(completed)));
			expect(objects.get(r2_create_asset_key({ ...db, assetId: saved!.assetId! }))).toBe(
				index === 0 ? "First file\n" : "Second file\n",
			);
		}
		expect(validationCalls).toBe(2);
		expect(publicationCalls).toBe(2);
		expect(
			await t.run(async (ctx) => Promise.all([nodeId, secondId].map((id) => ctx.db.get("files_nodes", id)))),
		).toEqual(sources);
	});

	test.each(["saved", "private"] as const)(
		"creates a private copy from a %s draft with unstaged edits",
		async (kind) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t, db, scope } = fixture;
			const source = kind === "private" ? await create_private_copy_source(fixture) : null;
			if (!source) await create_pending_proposal({ fixture });
			const copy = await start_agent_copy({ fixture, source: source?.target });
			expect(copy.item.preparation).not.toBeNull();
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(1);
			const sourceBefore = await t.run((ctx) => ctx.db.query("files_pending_updates").collect());
			await t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: copy.item._id,
				attempt: copy.item.attempt,
			});
			const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id));
			expect(item?.errorMessage).toBeNull();
			expect(item?.state).toBe("completed");
			expect(item?.outputTarget).toEqual({ kind: "private", id: copy.item.preparation!.privateNodeId });
			expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(1);
			const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
				...scope,
				path: "/copied.txt",
				overlayUserId: db.userId,
			});
			expect(read?.content).toBe(source?.text ?? "---\nreview: accepted\n---\n\nAccepted text\n\nProposed text\n");
			for (const pending of sourceBefore.filter((doc) => doc._id !== copy.item.preparation!.pendingUpdateId)) {
				expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
			}
			const proposal = await t.run((ctx) =>
				ctx.db.get("files_pending_updates", copy.item.preparation!.pendingUpdateId),
			);
			expect(proposal).toMatchObject({
				revision: 2,
				createIntent: { kind: "text" },
				content: { base: { kind: "new" } },
			});
			expect(proposal?.preparation).toBeUndefined();
		},
	);

	test("rebases a read-only source into the capture without changing its draft", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture("plain_text", "Saved line\nDraft line\n");
		const { t, db, asUser, scope, nodeId, pointers } = fixture;
		const pending = await create_pending_proposal({
			fixture,
			userId: db.userId,
			texts: {
				staged: "Saved line\nStaged line\n",
				unstaged: "Saved line\nStaged line\nUnstaged line\n",
			},
		});
		const yjsKey = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
		});
		const document = new YjsDoc();
		applyUpdate(document, new Uint8Array(await new Response(objects.get(yjsKey)).arrayBuffer()));
		const before = encodeStateVector(document);
		document.getText(files_YJS_DOC_KEYS.plainText).insert(0, "New saved line\n");
		expect(
			(
				await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(document, before)),
					sessionId: "new-saved-line",
				})
			)._nay,
		).toBeUndefined();
		document.destroy();
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();
		const copy = await start_agent_copy({ fixture });
		await t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id))).toMatchObject({
			state: "completed",
			errorMessage: null,
		});
		expect(
			(
				await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					...scope,
					path: "/copied.txt",
					overlayUserId: db.userId,
				})
			)?.content,
		).toBe("New saved line\nSaved line\nStaged line\nUnstaged line\n");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pending._id))).toEqual(pending);
	});

	test("discarding a preparing copy fences its late worker", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await start_agent_copy({ fixture });
		const preparation = copy.item.preparation!;
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_pending_nodes", preparation.privateNodeId);
			if (!node) throw new Error("Missing preparation");
			expect(
				await files_pending_nodes_db_discard(ctx, {
					...fixture.scope,
					privateNodeId: node._id,
					pendingUpdateId: preparation.pendingUpdateId,
					expectedRevision: preparation.proposalRevision,
				}),
			).toEqual({ _yay: null });
		});
		await t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id))).toMatchObject({
			state: "canceled",
			outputTarget: null,
			cancelReason: "proposal_discard",
		});
		expect(await t.run((ctx) => ctx.db.query("files_nodes").collect())).toHaveLength(1);
		expect(await t.run((ctx) => ctx.db.get("files_pending_nodes", preparation.privateNodeId))).toMatchObject({
			state: "discarded",
		});
	});

	test.each([
		{ rootKind: "plain_text", collaborative: true },
		{ rootKind: "plain_text", collaborative: false },
		{ rootKind: "rich_text", collaborative: true },
		{ rootKind: "rich_text", collaborative: false },
	] as const)("copies saved content and metadata with %j", async ({ rootKind, collaborative }) => {
		vi.useFakeTimers();
		const sourceText =
			rootKind === "rich_text"
				? '---\nproject: copied\n---\n\nKeep **bold** and <span data-type="comment" data-lb-thread-id="old-thread">these words</span>.\n'
				: '  exact text\n\tspaces, Unicode: 😀\n<span data-type="comment" data-lb-thread-id="literal">plain code</span>';
		const fixture = await create_file_fixture(rootKind, sourceText);
		const { t, db, asUser, scope, nodeId } = fixture;
		if (!collaborative) {
			expect(
				(
					await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: db.membershipId,
						nodeId,
						acknowledgeDropCollaborativeHistory: true,
					})
				)._nay,
			).toBeUndefined();
		}
		expect(
			(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
					metadataYaml: "owner: Ray\nchecked: true\ncount: 4",
				})
			)._nay,
		).toBeUndefined();
		const before = await t.run((ctx) => ctx.db.get("files_nodes", nodeId));
		const meterBefore = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", db.userId))
				.first(),
		);
		const copy = await create_transfer_copy_item(fixture);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		expect(item?.errorMessage).toBeNull();
		expect(item?.state).toBe("completed");
		const copiedId = saved_copy_id(item);
		const copied = await t.run((ctx) => ctx.db.get("files_nodes", copiedId));
		expect(copied).toMatchObject({
			contentType: before?.contentType,
			textKind: rootKind,
			collaborationEnabled: collaborative,
			writePolicy: null,
		});
		expect(copied?.assetId).not.toBe(before?.assetId);
		expect(copied?.yjsLastSequenceId === null).toBe(!collaborative);
		if (collaborative) expect(copied?.yjsLastSequenceId).not.toBe(before?.yjsLastSequenceId);
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			path: item!.outputPath!,
		});
		if (rootKind === "plain_text") {
			expect(read?.content).toBe(sourceText);
		} else {
			expect(read?.content).toContain("Keep **bold** and these words.");
			expect(read?.content).not.toContain("old-thread");
			expect(read?.content).not.toContain('data-type="comment"');
		}
		await t.run(async (ctx) => {
			const metadata = await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", copiedId),
				)
				.collect();
			expect(metadata.filter((entry) => entry.docKind === "value").map((entry) => entry.fieldPath)).toEqual(
				expect.arrayContaining(["metadata.owner", "metadata.checked", "metadata.count"]),
			);
			if (rootKind === "rich_text") expect(metadata.map((entry) => entry.fieldPath)).toContain("frontmatter.project");
			expect(
				await ctx.db
					.query("files_snapshots")
					.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("fileNodeId", copiedId),
					)
					.collect(),
			).toHaveLength(1);
			expect(
				await ctx.db
					.query("files_pending_updates")
					.withIndex("by_target", (q) => q.eq("target.kind", "saved").eq("target.id", copiedId))
					.collect(),
			).toHaveLength(0);
		});
		// A lost action response can be retried without another node, version, or charge.
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		const meterAfter = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", db.userId))
				.first(),
		);
		expect(meterAfter?.meter?.consumedUnits).toBe((meterBefore?.meter?.consumedUnits ?? 0) + 1);
		expect((await t.run((ctx) => activities_db_require_by_source_id(ctx, copy.runId))).progress?.completed).toBe(1);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toEqual(before);
	});

	test("copies a read-only source into an independent document that stays locked", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser, scope, nodeId } = fixture;
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId,
					writePolicy: { mode: "read_only" },
				})
			)._nay,
		).toBeUndefined();
		const copy = await create_transfer_copy_item(fixture);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		const copiedId = saved_copy_id(item);
		const copied = await t.run((ctx) => ctx.db.get("files_nodes", copiedId));
		// A copy keeps the source file's own rule. The destination default does not unlock it.
		expect(copied?.writePolicy).toEqual({ mode: "read_only" });
		const pointers = await test_get_file_yjs_pointers(t, copiedId);
		const snapshotKey = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
		});
		const editor = new YjsDoc();
		applyUpdate(editor, new Uint8Array(await new Response(objects.get(snapshotKey)).arrayBuffer()));
		const beforeEdit = encodeStateVector(editor);
		editor.getText(files_YJS_DOC_KEYS.plainText).insert("Original text\n".length, "Copy edit\n");
		const refused = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId: copiedId,
			expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
			sessionId: "clipboard-destination",
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(refused._nay?.message).toBe("This item is read-only.");
		expect(
			(
				await asUser.mutation(api.files_nodes.set_node_write_policy, {
					membershipId: db.membershipId,
					nodeId: copiedId,
					writePolicy: null,
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId: copiedId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
					sessionId: "clipboard-destination",
				})
			)._nay,
		).toBeUndefined();
		editor.destroy();
		expect(
			(
				await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					...scope,
					path: "/copies/restore.txt",
				})
			)?.content,
		).toBe("Original text\nCopy edit\n");
		expect(
			(
				await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					...scope,
					path: "/restore.txt",
				})
			)?.content,
		).toBe("Original text\n");
	});

	test("pins saved Yjs edits and leaves later edits and pending proposals behind", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser, scope, nodeId, pointers } = fixture;
		await create_pending_proposal({ fixture });
		const yjsKey = await t.run(async (ctx) => {
			const snapshot = await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId);
			return (await ctx.db.get("files_r2_assets", snapshot!.assetId))!.r2Key!;
		});
		const editor = new YjsDoc();
		applyUpdate(editor, new Uint8Array(await new Response(objects.get(yjsKey)).arrayBuffer()));
		const beforeEdit = encodeStateVector(editor);
		editor.getText(files_YJS_DOC_KEYS.plainText).insert("Original text\n".length, "Saved latest edit\n");
		expect(
			(
				await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeEdit)),
					sessionId: "clipboard-source",
				})
			)._nay,
		).toBeUndefined();
		const copy = await create_transfer_copy_item(fixture);
		await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, { itemId: copy.itemId, attempt: 1 });
		const beforeLaterEdit = encodeStateVector(editor);
		editor.getText(files_YJS_DOC_KEYS.plainText).insert(0, "Later edit\n");
		expect(
			(
				await asUser.mutation(api.files_nodes.yjs_push_update, {
					membershipId: db.membershipId,
					nodeId,
					expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
					update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, beforeLaterEdit)),
					sessionId: "later-source-edit",
				})
			)._nay,
		).toBeUndefined();
		editor.destroy();
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			path: "/copies/restore.txt",
		});
		expect(read?.content).toBe("Original text\nSaved latest edit\n");
	});

	test.each(["application/pdf", "image/png", "video/mp4", "text/html;charset=utf-8"])(
		"copies stored %s bytes without conversion or shared assets",
		async (contentType) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t, db, asUser } = fixture;
			const bytes = new Uint8Array([0, 255, 13, 10, 128, 70]);
			const source = await asUser.mutation(api.files_nodes.create_upload_node, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				filename: "stored.html",
				contentType,
				size: bytes.byteLength,
			});
			if (source._nay) throw new Error(source._nay.message);
			const sourceKey = "test/clipboard-stored";
			objects.set(sourceKey, bytes);
			await t.run((ctx) => ctx.db.patch("files_r2_assets", source._yay.assetId, { r2Key: sourceKey }));
			vi.spyOn(r2_server_side_copy, "copy_object").mockImplementation(async (_ctx, args) => {
				objects.set(args.destinationKey, bytes);
				return { outcome: "copied", size: bytes.byteLength, etag: "copied" };
			});
			const copy = await create_transfer_copy_item(fixture, source._yay.nodeId);
			await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
			const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
			const copiedId = saved_copy_id(item);
			const copied = await t.run((ctx) => ctx.db.get("files_nodes", copiedId));
			expect(copied).toMatchObject({ contentType, textKind: null, collaborationEnabled: null, yjsSnapshotId: null });
			expect(copied?.assetId).not.toBe(source._yay.assetId);
			await t.run((ctx) =>
				files_nodes_db_hard_delete_node(ctx, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					nodeId: source._yay.nodeId,
				}),
			);
			const asset = await t.run((ctx) => ctx.db.get("files_r2_assets", copied!.assetId!));
			expect(asset?.r2Key).not.toBe(sourceKey);
			expect(new Uint8Array(await new Response(objects.get(asset!.r2Key!)).arrayBuffer())).toEqual(bytes);
			expect(await t.run((ctx) => ctx.db.query("plugins_event_runs").collect())).toHaveLength(0);
		},
	);

	test.each(["stop", "permission"])(
		"refuses publication after %s during upload and cleans staged assets",
		async (change) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t, db, asUser } = fixture;
			const copy = await create_transfer_copy_item(fixture);
			const savedFetch = globalThis.fetch;
			let changed = false;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
					const response = await savedFetch(input, init);
					if (init?.method === "PUT" && !changed) {
						changed = true;
						if (change === "stop") {
							await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId: copy.runId });
						} else {
							await t.run((ctx) => ctx.db.patch("organizations_workspaces_users", db.membershipId, { active: false }));
						}
					}
					return response;
				}),
			);
			await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
			const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
			expect(item?.outputTarget).toBeNull();
			expect(item?.stagedAssetIds).toEqual([]);
			await expect_retired_uploads(t, 2);
			await t.run(async (ctx) => {
				const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
				for (const job of jobs) expect(job.putMayArriveUntil).toBeGreaterThan(Date.now());
			});
		},
	);

	test("releases failed writes and lets a later attempt use fresh assets", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		const savedFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const response = await savedFetch(input, init);
				if (init?.method === "PUT") throw new Error("Storage failed after receiving bytes");
				return response;
			}),
		);
		await expect(
			t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 }),
		).rejects.toThrow("Storage failed");
		await expect_retired_uploads(t, 2);
		vi.stubGlobal("fetch", savedFetch);
		await t.run((ctx) => ctx.db.patch("files_transfer_items", copy.itemId, { attempt: 2 }));
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 2 });
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.state).toBe("completed");
	});

	test("keeps the first source bytes and metadata after a failed attempt", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser, scope, nodeId } = fixture;
		expect(
			(
				await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
					membershipId: db.membershipId,
					nodeId,
					acknowledgeDropCollaborativeHistory: true,
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
					metadataYaml: "owner: first",
				})
			)._nay,
		).toBeUndefined();
		const copy = await create_transfer_copy_item(fixture);
		const savedFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const response = await savedFetch(input, init);
				if (init?.method === "PUT") throw new Error("Storage failed after receiving bytes");
				return response;
			}),
		);
		await expect(
			t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: copy.itemId,
				attempt: 1,
			}),
		).rejects.toThrow("Storage failed");
		vi.stubGlobal("fetch", savedFetch);
		expect(
			(
				await asUser.action(api.files_nodes_content.replace_file_content, {
					membershipId: db.membershipId,
					nodeId,
					text: "Newer source text\n",
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await asUser.mutation(api.files_metadata.set_entries, {
					membershipId: db.membershipId,
					fileNodeId: nodeId,
					metadataYaml: "owner: newer",
				})
			)._nay,
		).toBeUndefined();
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: "work_review" as never,
			context: { itemId: copy.itemId, attempt: 1 },
			result: { kind: "failed", error: "Storage failed" },
		});
		await t.mutation(internal.files_transfer.advance, { runId: copy.runId });
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 2 });
		const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		expect(item?.state).toBe("completed");
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			path: "/copies/restore.txt",
		});
		expect(read?.content).toBe("Original text\n");
		const metadata = await asUser.query(api.files_metadata.get_entries, {
			membershipId: db.membershipId,
			fileNodeId: saved_copy_id(item),
		});
		expect(metadata).toEqual([{ key: "owner", value: "first" }]);
	});

	test("reuses sealed assets after a failed attempt and keeps them when history is deleted", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, scope } = fixture;
		const copy = await create_sealed_transfer_capture(fixture);
		const captured = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		expect(captured?.stagedAssetIds).toEqual([]);
		expect(captured?.capture?.artifact?.contentAssetId).toBe(copy.assets.contentAssetId);
		objects.delete(copy.source.asset!.r2Key!);
		objects.delete(copy.source.yjsSnapshotAsset!.r2Key!);
		await t.mutation(internal.files_transfer.handle_copy_complete, {
			workId: copy.claim.workId,
			context: { itemId: copy.itemId, attempt: 1 },
			result: { kind: "failed", error: "Lost seal response" },
		});
		await t.mutation(internal.files_transfer.advance, { runId: copy.runId });
		const storageCalls = vi.mocked(globalThis.fetch).mock.calls.length;
		const beforeMeter = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", db.userId))
				.first(),
		);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 2 });
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 2 });
		const laterStorage = vi.mocked(globalThis.fetch).mock.calls.slice(storageCalls);
		expect(laterStorage).toHaveLength(1);
		expect(laterStorage[0]![1]?.method).not.toBe("PUT");
		const item = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		expect(item).toMatchObject({ state: "completed", capture: { artifact: null }, stagedAssetIds: [] });
		const output = await t.run((ctx) => ctx.db.get("files_nodes", saved_copy_id(item)));
		expect(output?.assetId).toBe(copy.assets.contentAssetId);
		const pointers = await test_get_file_yjs_pointers(t, saved_copy_id(item));
		expect((await t.run((ctx) => ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId)))?.assetId).toBe(
			copy.assets.yjsSnapshotAssetId,
		);
		const afterMeter = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", db.userId))
				.first(),
		);
		expect(afterMeter?.meter?.consumedUnits).toBe((beforeMeter?.meter?.consumedUnits ?? 0) + 1);
		await t.mutation(internal.files_transfer.delete_run_batch, { runId: copy.runId });
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", copy.assets.contentAssetId))).not.toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", copy.assets.yjsSnapshotAssetId!))).not.toBeNull();
		expect(
			(
				await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
					...scope,
					path: "/copies/restore.txt",
				})
			)?.content,
		).toBe("Original text\n");
	});

	test.each(["stop", "skip", "mode change", "credit loss"])("releases a sealed capture after %s", async (change) => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser, nodeId } = fixture;
		const copy = await create_sealed_transfer_capture(fixture);
		if (change === "stop") {
			await asUser.mutation(api.files_transfer.stop, { membershipId: db.membershipId, runId: copy.runId });
		} else if (change === "skip") {
			await asUser.mutation(api.files_nodes.create_folder_node, {
				membershipId: db.membershipId,
				parentId: copy.folderId,
				path: "restore.txt",
			});
			await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
			expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.capture?.artifact).not.toBeNull();
			const run = await asUser.query(api.files_transfer.get, { membershipId: db.membershipId, runId: copy.runId });
			await asUser.mutation(api.files_transfer.resolve_conflicts, {
				membershipId: db.membershipId,
				runId: copy.runId,
				revision: run!.revision,
				choices: [{ itemId: copy.itemId, choice: "skip" }],
				applyToRemaining: { file: null, folder: null },
			});
			await t.mutation(internal.files_transfer.handle_copy_complete, {
				workId: copy.claim.workId,
				context: { itemId: copy.itemId, attempt: 1 },
				result: { kind: "success", returnValue: null },
			});
			await t.mutation(internal.files_transfer.advance, { runId: copy.runId });
		} else if (change === "mode change") {
			await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
		} else {
			await t.run(async (ctx) => {
				await test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" });
				const usage = await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", db.userId))
					.first();
				await ctx.db.patch("billing_usage_snapshots", usage!._id, { meter: { ...usage!.meter!, balance: 0 } });
			});
		}
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
			outputTarget: null,
			stagedAssetIds: [],
			capture: { artifact: null },
		});
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", copy.assets.contentAssetId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", copy.assets.yjsSnapshotAssetId!))).toBeNull();
		const jobs = await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		for (const assetId of [copy.assets.contentAssetId, copy.assets.yjsSnapshotAssetId!]) {
			const job = jobs.find((job) => job.r2Key === r2_create_asset_key({ ...fixture.scope, assetId }));
			expect(job?.putMayArriveUntil).toBeGreaterThan(Date.now());
		}
	});

	test("refuses an old work claim without releasing the current sealed capture", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await create_sealed_transfer_capture(fixture);
		const before = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
		const oldClaim = { ...copy.claim, workId: "old_work" as never };
		expect(
			await t.mutation(internal.files_nodes_content.finalize_transfer_file_copy, {
				...oldClaim,
				...copy.assets,
				text: "Wrong claim",
			}),
		).toEqual({ _yay: null });
		await t.mutation(internal.files_nodes_content.discard_transfer_file_attempt, {
			...oldClaim,
			message: "Old worker failed",
		});
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toEqual(before);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", copy.assets.contentAssetId))).not.toBeNull();
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.state).toBe("completed");
	});

	test("fails when the pinned source bytes disappear before sealing", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		const prepared = await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
			itemId: copy.itemId,
			attempt: 1,
		});
		if (!prepared._yay?.asset) throw new Error("Missing captured source");
		objects.delete(prepared._yay.asset.r2Key!);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
			state: "failed",
			errorMessage: "The captured source content is no longer available",
			outputTarget: null,
			stagedAssetIds: [],
		});
	});

	test.each(["source asset", "source snapshot", "sealed content"])(
		"fails in the source read transaction when the %s is gone",
		async (missing) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t } = fixture;
			const copy =
				missing === "sealed content"
					? await create_sealed_transfer_capture(fixture)
					: await create_transfer_copy_item(fixture);
			const args = { itemId: copy.itemId, attempt: 1 };
			const prepared = await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, args);
			if (!prepared._yay) throw new Error("Missing captured source");
			const source = prepared._yay;
			const missingAssetId = missing === "source snapshot" ? source.yjsSnapshotAsset!._id : source.asset!._id;
			await t.run((ctx) => ctx.db.delete("files_r2_assets", missingAssetId));

			expect(await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, args)).toEqual({
				_nay: { message: "The captured source content is no longer available" },
			});
			expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
				state: "failed",
				errorMessage: "The captured source content is no longer available",
				outputTarget: null,
				stagedAssetIds: [],
				capture: { artifact: null },
			});
			expect(
				await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
					...args,
					workId: source.workId,
					contentSize: source.asset!.size,
				}),
			).toEqual({ _yay: null });
			if (source.capture.artifact?.yjsSnapshotAssetId) {
				expect(
					await t.run((ctx) => ctx.db.get("files_r2_assets", source.capture.artifact!.yjsSnapshotAssetId!)),
				).toBeNull();
			}
		},
	);

	test.each(["after preflight", "during upload", "between retries"])(
		"keeps the original payer when ownership changes %s",
		async (change) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t, db, asUser } = fixture;
			const newOwnerId = await t.run(async (ctx) => {
				const newOwner = await test_mocks_fill_db_with.membership(ctx, {
					organizationName: "personal",
					workspaceName: "home",
				});
				const organization = await ctx.db.get("organizations", db.organizationId);
				if (!organization?.defaultWorkspaceId) throw new Error("Missing default workspace");
				await ctx.db.insert("organizations_workspaces_users", {
					organizationId: db.organizationId,
					workspaceId: organization.defaultWorkspaceId,
					userId: newOwner.userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
				});
				await ctx.db.patch("organizations", db.organizationId, { billingMode: "organization_owner" });
				return newOwner.userId;
			});
			const copy = await create_transfer_copy_item(fixture);
			const meterBefore = await t.run((ctx) =>
				ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", db.userId))
					.first(),
			);
			const transfer = async () => {
				const result = await asUser.mutation(api.access_control.transfer_organization_ownership, {
					organizationId: db.organizationId,
					newOwnerUserId: newOwnerId,
				});
				expect(result._nay).toBeUndefined();
			};
			const savedFetch = globalThis.fetch;
			let uploaded = false;
			if (change === "after preflight") {
				const prepared = await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, {
					itemId: copy.itemId,
					attempt: 1,
				});
				expect(prepared._yay).toBeTruthy();
				await transfer();
			} else {
				vi.stubGlobal(
					"fetch",
					vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
						const response = await savedFetch(input, init);
						if (init?.method === "PUT") {
							if (change === "between retries") throw new Error("Storage failed after receiving bytes");
							if (!uploaded) {
								uploaded = true;
								await transfer();
							}
						}
						return response;
					}),
				);
			}
			if (change === "between retries") {
				await expect(
					t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 }),
				).rejects.toThrow("Storage failed");
				await transfer();
				vi.stubGlobal("fetch", savedFetch);
				await t.run((ctx) => ctx.db.patch("files_transfer_items", copy.itemId, { attempt: 2 }));
			}
			await t.action(internal.files_nodes_content.copy_transfer_file, {
				itemId: copy.itemId,
				attempt: change === "between retries" ? 2 : 1,
			});
			expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
				state: "completed",
				billedUserId: db.userId,
			});
			await t.run(async (ctx) => {
				const oldOwnerMeter = await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", db.userId))
					.first();
				const newOwnerMeter = await ctx.db
					.query("billing_usage_snapshots")
					.withIndex("by_user", (q) => q.eq("userId", newOwnerId))
					.first();
				expect(oldOwnerMeter?.meter?.consumedUnits).toBe((meterBefore?.meter?.consumedUnits ?? 0) + 1);
				expect(newOwnerMeter?.meter?.consumedUnits).toBe(0);
			});
		},
	);

	test("pauses on a name conflict created during upload", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		const savedFetch = globalThis.fetch;
		let occupied = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const response = await savedFetch(input, init);
				if (init?.method === "PUT" && !occupied) {
					occupied = true;
					const created = await asUser.mutation(api.files_nodes.create_folder_node, {
						membershipId: db.membershipId,
						parentId: copy.folderId,
						path: "restore.txt",
					});
					expect(created._nay).toBeUndefined();
				}
				return response;
			}),
		);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
			state: "conflict",
			conflictKind: "name_conflict",
			outputTarget: null,
			stagedAssetIds: [],
		});
		expect((await t.run((ctx) => activities_db_require_by_source_id(ctx, copy.runId))).status).toBe("awaiting_input");
		await expect_retired_uploads(t, 2);
	});

	test("keeps a late-started worker's cleanup hold until its upload can finish", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await start_agent_copy({ fixture });
		const attemptExpiresAt = copy.item.attemptExpiresAt!;
		vi.setSystemTime(attemptExpiresAt - 60_000);
		const uploadStarted = Promise.withResolvers<void>();
		const releaseUploads = Promise.withResolvers<void>();
		const savedFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				if (init?.method === "PUT") {
					uploadStarted.resolve();
					await releaseUploads.promise;
				}
				return await savedFetch(input, init);
			}),
		);
		vi.spyOn(r2_confirmed_object_delete, "delete_object").mockImplementation(async (_ctx, key) => {
			objects.delete(key);
		});
		const worker = t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: copy.item._id,
			attempt: copy.item.attempt,
		});
		await uploadStarted.promise;
		const stagedItem = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id));
		const assetId = stagedItem!.stagedAssetIds[0]!;
		const r2Key = r2_create_asset_key({ ...fixture.scope, assetId });
		vi.setSystemTime(attemptExpiresAt + 1);
		await t.mutation(internal.files_transfer.recover_expired_attempts, {});
		const job = await t.run((ctx) =>
			ctx.db
				.query("files_r2_object_deletion_jobs")
				.withIndex("by_r2_key", (q) => q.eq("r2Key", r2Key))
				.unique(),
		);
		if (!job?.privateStorageReservationId) throw new Error("Expected an owned deletion job");

		// The worker started one minute before expiry. This PUT still fits its ten-minute runtime.
		vi.setSystemTime(attemptExpiresAt + r2_PUT_MAY_ARRIVE_MARGIN_MS + 1);
		await t.action(internal.r2_client.process_object_deletion_job, { jobId: job._id, generation: job.generation });
		vi.setSystemTime(attemptExpiresAt + 6 * 60_000);
		releaseUploads.resolve();
		await worker;
		expect(objects.has(r2Key)).toBe(true);
		const afterLateUpload = await t.run((ctx) => ctx.db.get("files_r2_object_deletion_jobs", job._id));
		expect(afterLateUpload).not.toBeNull();
		expect(
			(await t.run((ctx) => ctx.db.get("files_private_storage_reservations", job.privateStorageReservationId!)))
				?.settlement.kind,
		).toBe("held");
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.item._id)))?.outputTarget).toBeNull();

		vi.setSystemTime(afterLateUpload!.putMayArriveUntil! + 1);
		await t.action(internal.r2_client.process_object_deletion_job, { jobId: job._id, generation: job.generation });
		expect(objects.has(r2Key)).toBe(false);
		expect(
			(await t.run((ctx) => ctx.db.get("files_private_storage_reservations", job.privateStorageReservationId!)))
				?.settlement.kind,
		).toBe("deleted");
	});

	test("keeps current staging when an old or duplicate attempt arrives", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		await t.mutation(internal.files_nodes_content.get_transfer_file_copy_data, { itemId: copy.itemId, attempt: 1 });
		const first = await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
			itemId: copy.itemId,
			attempt: 1,
			workId: "work_review" as never,
			contentSize: 14,
			yjsSnapshotSize: 24,
		});
		expect(first._yay).not.toBeNull();
		expect(
			await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
				itemId: copy.itemId,
				attempt: 1,
				workId: "work_review" as never,
				contentSize: 14,
				yjsSnapshotSize: 24,
			}),
		).toEqual({ _yay: null });
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.stagedAssetIds).toHaveLength(2);
		await t.mutation(internal.files_nodes_content.discard_transfer_file_attempt, { itemId: copy.itemId, attempt: 1 });
		await t.run((ctx) => ctx.db.patch("files_transfer_items", copy.itemId, { attempt: 2 }));
		const second = await t.mutation(internal.files_nodes_content.stage_transfer_file_copy_assets, {
			itemId: copy.itemId,
			attempt: 2,
			workId: "work_review" as never,
			contentSize: 14,
			yjsSnapshotSize: 24,
		});
		if (!second._yay) throw new Error("Missing fresh staging");
		expect(second._yay.contentAssetId).not.toBe(first._yay?.contentAssetId);
		await t.mutation(internal.files_nodes_content.discard_transfer_file_attempt, { itemId: copy.itemId, attempt: 1 });
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", second._yay!.contentAssetId))).not.toBeNull();
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.stagedAssetIds).toEqual([
			second._yay.contentAssetId,
			second._yay.yjsSnapshotAssetId,
		]);
	});

	test.each(["allocation", "source read"])(
		"keeps the winning worker's staging when a duplicate fails at %s",
		async (failure) => {
			vi.useFakeTimers();
			const fixture = await create_file_fixture();
			const { t } = fixture;
			const copy = await create_transfer_copy_item(fixture);
			const firstRead = Promise.withResolvers<void>();
			const secondRead = Promise.withResolvers<void>();
			const releaseFirstRead = Promise.withResolvers<void>();
			const releaseSecondRead = Promise.withResolvers<void>();
			const uploadStarted = Promise.withResolvers<void>();
			const releaseUploads = Promise.withResolvers<void>();
			const savedFetch = globalThis.fetch;
			let reads = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
					if (init?.method === "PUT") {
						uploadStarted.resolve();
						await releaseUploads.promise;
					} else {
						reads += 1;
						if (reads === 1) {
							firstRead.resolve();
							await releaseFirstRead.promise;
						} else if (reads === 2) {
							secondRead.resolve();
							await releaseSecondRead.promise;
							if (failure === "source read") return new Response(null, { status: 404 });
						}
					}
					return await savedFetch(input, init);
				}),
			);
			const first = t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
			await firstRead.promise;
			const duplicate = t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
			await secondRead.promise;
			releaseFirstRead.resolve();
			await uploadStarted.promise;
			releaseSecondRead.resolve();
			await duplicate;
			const duringUpload = await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId));
			releaseUploads.resolve();
			await first;
			expect(duringUpload?.stagedAssetIds).toHaveLength(2);
			expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.state).toBe("completed");
		},
	);

	test("rechecks the credit gate after storage finishes", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		const savedFetch = globalThis.fetch;
		let changed = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const response = await savedFetch(input, init);
				if (init?.method === "PUT" && !changed) {
					changed = true;
					await t.run(async (ctx) => {
						await test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" });
						const usage = await ctx.db
							.query("billing_usage_snapshots")
							.withIndex("by_user", (q) => q.eq("userId", db.userId))
							.first();
						await ctx.db.patch("billing_usage_snapshots", usage!._id, { meter: { ...usage!.meter!, balance: 0 } });
					});
				}
				return response;
			}),
		);
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId))).toMatchObject({
			state: "failed",
			errorMessage: "Insufficient funds",
			outputTarget: null,
			stagedAssetIds: [],
		});
		await expect_retired_uploads(t, 2);
	});

	test("requires a paid plan for stored bytes even with free credits", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db, asUser } = fixture;
		const source = await asUser.mutation(api.files_nodes.create_upload_node, {
			membershipId: db.membershipId,
			parentId: files_ROOT_ID,
			filename: "stored.pdf",
			contentType: "application/pdf",
			size: 3,
		});
		if (source._nay) throw new Error(source._nay.message);
		await t.run(async (ctx) => {
			await ctx.db.patch("files_r2_assets", source._yay.assetId, { r2Key: "test/paid-copy" });
			await test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" });
		});
		const copy = await create_transfer_copy_item(fixture, source._yay.nodeId);
		const storageCalls = vi.mocked(globalThis.fetch).mock.calls.length;
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(storageCalls);
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.errorMessage).toBe(
			"This workspace's plan does not include file uploads",
		);
	});

	test("checks credits before reading or writing storage", async () => {
		vi.useFakeTimers();
		const fixture = await create_file_fixture();
		const { t, db } = fixture;
		const copy = await create_transfer_copy_item(fixture);
		await t.run(async (ctx) => {
			await test_mocks_fill_db_with.plan(ctx, { userId: db.userId, plan: "Free" });
			const usage = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", db.userId))
				.first();
			await ctx.db.patch("billing_usage_snapshots", usage!._id, { meter: { ...usage!.meter!, balance: 0 } });
		});
		const storageCalls = vi.mocked(globalThis.fetch).mock.calls.length;
		await t.action(internal.files_nodes_content.copy_transfer_file, { itemId: copy.itemId, attempt: 1 });
		expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(storageCalls);
		expect((await t.run((ctx) => ctx.db.get("files_transfer_items", copy.itemId)))?.errorMessage).toBe(
			"Insufficient funds",
		);
	});
});

describe("snapshot content fields", () => {
	test.each(["plain_text", "rich_text"] as const)(
		"records each saved %s mode without changing older versions",
		async (rootKind) => {
			vi.useFakeTimers();
			const { t, db, asUser, scope, nodeId } = await create_file_fixture(rootKind);
			const materialized = await t.action(internal.files_nodes_content.materialize_file_content, {
				...scope,
				nodeId,
				targetSequence: 0,
			});
			expect(materialized._nay).toBeUndefined();
			const off = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: db.membershipId,
				nodeId,
				acknowledgeDropCollaborativeHistory: true,
			});
			expect(off._nay).toBeUndefined();
			const saved = await asUser.action(api.files_nodes_content.replace_file_content, {
				membershipId: db.membershipId,
				nodeId,
				text: "Saved with collaboration off\n",
			});
			expect(saved._nay).toBeUndefined();

			const tasks = await t.run((ctx) => ctx.db.query("files_yjs_cleanup_tasks").collect());
			for (const task of tasks) {
				await t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
			}
			const on = await asUser.action(api.files_nodes_content.set_file_collaborative, {
				membershipId: db.membershipId,
				nodeId,
			});
			expect(on._nay).toBeUndefined();

			const snapshots = await t.run((ctx) => ctx.db.query("files_snapshots").collect());
			expect(snapshots.map((snapshot) => snapshot.collaborationEnabled)).toEqual([true, true, false, true]);
			for (const snapshot of snapshots) {
				expect(snapshot).toMatchObject({
					contentType: rootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
					yjsRootKind: rootKind,
				});
				expect(snapshot).not.toHaveProperty("nonCollaborative");
			}
		},
	);
});

// The cleanup, materialize, restore and replacement tests are in files_nodes_content.restore.test.ts.
