import { RateLimiter } from "@convex-dev/rate-limiter";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "./_generated/api.js";
import {
	test_save_file_pending_update,
	test_finish_pending_update_run,
	test_apply_file_pending_move,
	test_convex,
	test_drain_billing_usage_event_outbox,
	test_rename_node,
	test_move_nodes,
	test_get_file_yjs_pointers,
	test_meta_search,
	test_mocks_fill_db_with,
} from "./setup.test.ts";
import type { Id } from "./_generated/dataModel.js";
import { billing_PRODUCTS, billing_get_recurring_credits_cents } from "../shared/billing.ts";
import { billing_db_ensure_anonymous_user_usage_snapshot } from "./billing.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_private_storage_db_reserve } from "./files_private_storage.ts";
import { files_pending_nodes_db_create } from "./files_pending_nodes.ts";
import { files_nodes_db_get_content_version } from "./files_nodes.ts";
import { files_pending_updates_db_mark_content_for_rebase } from "./files_pending_updates.ts";
import { billing_event } from "../server/billing.ts";
import { r2_create_asset_key } from "./r2_client.ts";
import {
	files_db_get_pending_update,
	files_DRAFT_IDLE_EXPIRY_MS,
	files_ROOT_ID,
	files_pending_update_has_yjs_content,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import {
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_clone,
	files_yjs_doc_create_from_array_buffer_update,
} from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_MAX_YJS_RECONSTRUCTED_STATE_BYTES,
	files_MAX_YJS_WIRE_BYTES,
	files_get_utf8_byte_size,
	files_PENDING_UPDATE_STALE_BASE_MESSAGE,
} from "../shared/files.ts";
import { files_metadata_MAX_FRONTMATTER_FIELDS } from "../shared/files-metadata.ts";
import { Doc as YDoc, XmlElement as YXmlElement, encodeStateAsUpdate, encodeStateAsUpdateV2 } from "yjs";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	accept_as_member,
	build_file_diff_update_from_snapshot,
	create_private_text_for_test,
	enqueueActionSpy,
	expect_consumed_pending_content_cleanup_for_test,
	expire_pending_update_for_test,
	file_save_events,
	list_pending_update_plain_text_chunks,
	list_pending_update_text_chunks,
	mock_pending_updates_storage,
	normalize_pending_update_markdown,
	persist_file_pending_update_rebased_state_for_test,
	r2Objects,
	read_committed_text,
	read_file_markdown_from_yjs,
	read_file_yjs_state,
	read_pending_review_state_for_test,
	read_pending_row_markdown_state,
	read_pending_row_state_bytes,
	read_pending_update_expiry_check,
	read_pending_update_last_sequence_saved_doc,
	read_pending_update_row,
	read_seeded_pending_row,
	reviewed_pending_for_test,
	save_as_member,
	save_pending_review_for_test,
	seal_output_family_for_test,
	seed_billing_snapshot_for_user,
	seed_chat_thread,
	seed_committed_chunks_for_file,
	seed_file_with_markdown,
	seed_folder_node,
	seed_non_collaborative_file,
	seed_signed_in_file_with_markdown,
	set_pending_test_read_only,
	set_pending_test_writable,
	stage_and_seal_input_family_for_test,
	upsert_file_pending_archive_for_test,
	upsert_file_pending_move_for_test,
	upsert_file_pending_update_internal_for_test,
	upsert_file_pending_update_public_for_test,
} from "./files_pending_updates.setup.test.ts";

// Wrap the shared markdown serializer in a delegating mock so focused tests can make one call
// fail with the real producer's cause-carrying `_nay` shape. A crafted Y.Doc cannot force that
// failure: y-prosemirror drops elements it cannot convert instead of throwing.
const { filesYjsDocGetMarkdownMock } = vi.hoisted(() => {
	return {
		filesYjsDocGetMarkdownMock: vi.fn(),
	};
});

vi.mock("../shared/files-tiptap.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../shared/files-tiptap.ts")>();
	filesYjsDocGetMarkdownMock.mockImplementation(actual.files_yjs_doc_get_text);
	return {
		...actual,
		files_yjs_doc_get_text: filesYjsDocGetMarkdownMock,
	};
});

beforeEach(mock_pending_updates_storage);

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("save_file_pending_update", () => {
	test.each([false, true])("public Save converts each Markdown chunk once with remaining draft %s", async (partial) => {
		const accepted = normalize_pending_update_markdown(
			Array.from({ length: 90 }, (_, index) => `## Section ${index}\n\n${"searchable words ".repeat(10)}`).join("\n\n"),
		);
		const remaining = partial
			? normalize_pending_update_markdown(`${accepted}\n\n${"later draft ".repeat(1400)}`)
			: accepted;
		const draft = await create_private_text_for_test({ path: "/paged-save.md", staged: accepted, unstaged: remaining });
		const { t, asUser } = draft;
		const conversion = vi.spyOn(await import("../shared/files-tiptap.ts"), "files_tiptap_markdown_list_to_plain_text");
		const queued = await asUser.action(api.files_pending_updates.save_file_pending_update, {
			membershipId: draft.membershipId,
			target: draft.target,
			pendingUpdateId: draft.pendingUpdateId,
			reviewedRevision: draft.proposal.revision,
		});
		if (queued._nay) throw new Error(queued._nay.message);
		if (!("kind" in queued._yay)) throw new Error("Expected the public Save job");
		const { runId, activityId } = queued._yay;
		await test_finish_pending_update_run(asUser, runId);
		expect(
			await t.run((ctx) => ctx.db.get("activities", activityId)),
			"The native Save finishes before its work count is checked",
		).toMatchObject({ status: "succeeded", progress: { completed: 1, failed: 0, blocked: 0 } });
		const receipt = await t.run((ctx) => ctx.db.query("files_pending_node_publish_receipts")
			.withIndex("by_privateNode", (q) => q.eq("privateNodeId", draft.target.id)).unique());
		if (!receipt) throw new Error("Expected the published file");
		const chunks = await t.run((ctx) =>
			ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_source_fileNode_yjsSeq_chunk", (q) =>
					q
						.eq("organizationId", draft.organizationId)
						.eq("workspaceId", draft.workspaceId)
						.eq("sourceKind", "committed")
						.eq("fileNodeId", receipt.savedNodeId),
				)
				.collect(),
		);
		expect(chunks.map((chunk) => chunk.textChunk).join(""), "Paged Save keeps the exact accepted text").toBe(accepted);
		expect(chunks.length, "This Save crosses the eight-chunk page boundary").toBeGreaterThan(8);
		const pendingChunks = await t.run((ctx) =>
			list_pending_update_text_chunks({ ctx, pendingUpdateId: draft.pendingUpdateId }),
		);
		if (partial) {
			expect(pendingChunks.map((chunk) => chunk.textChunk).join(""), "Paged Save keeps the exact remaining draft").toBe(
				remaining,
			);
			expect(pendingChunks.length).toBeGreaterThan(8);
			const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", draft.pendingUpdateId));
			if (!proposal) throw new Error("Expected the remaining draft");
			expect(
				(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: proposal }))).unstagedMarkdown,
			).toBe(remaining);
		} else expect(pendingChunks).toEqual([]);
		expect(
			conversion.mock.calls.flatMap(([args]) => args.markdownList),
			"Save converts each accepted and remaining Markdown chunk once across its native pages",
		).toEqual([...chunks, ...pendingChunks].map((chunk) => chunk.textChunk));
	});

	test("save_file_pending_update returns Not found when there is no pending doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-missing-doc",
				name: "pending-edits-save-missing-doc",
				markdown: "# Missing doc base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const deletedProposalId = await t.run(async (ctx) => {
			const id = await ctx.db.insert("files_pending_updates", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			});
			await ctx.db.delete("files_pending_updates", id);
			return id;
		});
		const saveResult = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			pendingUpdateId: deletedProposalId,
			reviewedRevision: 1,
		});

		expect(saveResult._nay?.message).toBe("Not found");
	});

	test("save_file_pending_update throws when a file points to missing Yjs state", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-broken-yjs",
				name: "pending-edits-save-broken-yjs",
				markdown: "# Broken Yjs base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const pendingMarkdown = `${seeded.baseMarkdown}\n\nPending chunk`;
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: pendingMarkdown,
			unstagedMarkdown: pendingMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		await t.run(async (ctx) => {
			const file = await ctx.db.get("files_nodes", seeded.nodeId);
			if (!file?.yjsSnapshotId) {
				throw new Error("Expected seeded file Yjs snapshot");
			}
			await ctx.db.delete("files_yjs_snapshots", file.yjsSnapshotId);
		});

		await expect(
			test_save_file_pending_update(asUser, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				...(await reviewed_pending_for_test(t, {
					membershipId: seeded.membershipId,
					target: { kind: "saved", id: seeded.nodeId },
				})),
			}),
		).rejects.toThrow("fileNode.yjsSnapshotId points to a missing or mismatched files_yjs_snapshots doc");
	});

	test("save_file_pending_update blocks Free users at zero credits before saving", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-zero-credits",
				name: "pending-edits-save-zero-credits",
				markdown: "# Save base",
			}),
		);
		await t.run(async (ctx) => {
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique();
			if (!usageSnapshot?.meter) {
				throw new Error("Expected seeded billing snapshot meter");
			}
			await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
				meter: {
					...usageSnapshot.meter,
					creditedUnits: 0,
					balance: 0,
				},
			});
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked chunk`,
		});

		const saveResult = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});

		expect(saveResult).toEqual({
			_nay: {
				message: "Insufficient funds",
			},
		});
		await test_drain_billing_usage_event_outbox(t);
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.anything(),
		);

		const savedMarkdownAfterDeniedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterDeniedSave).toBe(seeded.baseMarkdown);
	});

	test("save_file_pending_update blocks anonymous users at zero credits before saving", async () => {
		const t = test_convex();
		const recurringCredits = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);

		const seeded = await t.run(async (ctx) => {
			const result = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-save-anon-zero-credits",
				name: "pending-edits-save-anon-zero-credits",
				markdown: "# Anon save base",
			});
			// Replace the signed-in billing snapshot with an anonymous one and drain it.
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", result.userId))
				.unique();
			if (usageSnapshot) await ctx.db.delete("billing_usage_snapshots", usageSnapshot._id);
			await billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId: result.userId, now: Date.now() });
			const user = await ctx.db.get("users", result.userId);
			if (!user) {
				throw new Error("Expected anonymous user");
			}
			await ctx.runMutation(internal.billing.ingest_anonymous_user_events, {
				billedUserEvents: [
					{
						billedUser: user,
						event: billing_event({
							name: "manual_credit",
							externalCustomerId: result.userId,
							externalId: "manual_credit::anonymous_pending_updates::1",
							metadata: {
								amount: recurringCredits,
							},
						}),
					},
				],
			});
			return result;
		});

		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: seeded.userId,
			name: "Anonymous User",
		});

		await upsert_file_pending_update_public_for_test(asAnonymous, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked anon chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nBlocked anon chunk`,
		});

		const saveResult = await test_save_file_pending_update(asAnonymous, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});

		expect(saveResult).toEqual({
			_nay: {
				message: "Insufficient funds",
			},
		});
		await test_drain_billing_usage_event_outbox(t);
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.anything(),
		);

		const savedMarkdownAfterDeniedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterDeniedSave).toBe(seeded.baseMarkdown);
	});

	test("save_file_pending_update bills anonymous users locally after a successful save", async () => {
		const t = test_convex();
		const recurringCredits = billing_get_recurring_credits_cents(billing_PRODUCTS.Free.name);

		const seeded = await t.run(async (ctx) => {
			const result = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-save-anon-success",
				name: "pending-edits-save-anon-success",
				markdown: "# Anon save base",
			});
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", result.userId))
				.unique();
			if (usageSnapshot) await ctx.db.delete("billing_usage_snapshots", usageSnapshot._id);
			await billing_db_ensure_anonymous_user_usage_snapshot(ctx, { userId: result.userId, now: Date.now() });
			return result;
		});

		const asAnonymous = t.withIdentity({
			issuer: process.env.VITE_CONVEX_HTTP_URL!,
			subject: seeded.userId,
			name: "Anonymous User",
		});

		await upsert_file_pending_update_public_for_test(asAnonymous, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nSaved anon chunk`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nSaved anon chunk`,
		});

		const saveResult = await test_save_file_pending_update(asAnonymous, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing anonymous save billing");
		}

		expect(saveResult._yay.newSequence).not.toBeNull();
		await test_drain_billing_usage_event_outbox(t);
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.anything(),
		);

		const usageSnapshot = await t.run((ctx) =>
			ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique(),
		);
		expect(usageSnapshot?.meter?.consumedUnits).toBe(1);
		expect(usageSnapshot?.meter?.balance).toBe(recurringCredits - 1);

		const savedMarkdown = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdown).toContain("Saved anon chunk");
	});

	test("save_file_pending_update supports partial save and keeps unresolved pending doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save",
				name: "pending-edits-save",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
		const unstagedMarkdown = `${stagedMarkdown}\n\nUnresolved chunk`;
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});

		const saveResult = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing partial save");
		}
		expect(saveResult._yay.newSequence).not.toBeNull();
		const savedVersion = `${(await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId}:${saveResult._yay.newSequence}`;
		await test_drain_billing_usage_event_outbox(t);
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
			events: [
				expect.objectContaining({
					name: "file_save",
					externalCustomerId: seeded.userId,
					externalId: `file_save::${seeded.userId}::${seeded.userId}::${seeded.organizationId}::${seeded.workspaceId}::${seeded.nodeId}::${savedVersion}`,
					metadata: expect.objectContaining({
						amount: 1,
						actorUserId: seeded.userId,
						billedUserId: seeded.userId,
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						nodeId: seeded.nodeId,
						version: savedVersion,
					}),
				}),
			],
		});

		const yjsUpdatesAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.order("asc")
				.collect(),
		);
		expect(yjsUpdatesAfterSave).toHaveLength(1);
		expect(yjsUpdatesAfterSave[0]?.createdBy).toBe(seeded.userId);

		const pendingUpdateLastSequenceSaved = await t.run(async (ctx) =>
			read_pending_update_last_sequence_saved_doc({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(saveResult._yay.newSequence);

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).not.toBeNull();
		expect(pendingAfterSave!.content?.base).toMatchObject({ kind: "yjs", sequence: saveResult._yay.newSequence });
		const pendingAfterSaveMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingAfterSave! }),
		);
		expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("Accepted chunk");
		expect(pendingAfterSaveMarkdownState.baseMarkdown).not.toContain("Unresolved chunk");
		expect(pendingAfterSaveMarkdownState.stagedMarkdown).toBe(pendingAfterSaveMarkdownState.baseMarkdown);
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Accepted chunk");
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Unresolved chunk");

		const savedMarkdownAfterPartialSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterPartialSave).toContain("Accepted chunk");
		expect(savedMarkdownAfterPartialSave).not.toContain("Unresolved chunk");
	});

	test("saving a plain-text proposal writes the staged text into the live document byte for byte", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-plain-save.json",
				name: "pending-plain-save.json",
				markdown: '{"base": true}\n',
				rootKind: "plain_text",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		// Byte-exact plain text on purpose: no trailing newline and markdown-hostile characters.
		const stagedText = '{"pending": [1, 2, 3], "note": "*not markdown*"}';
		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedText,
			unstagedMarkdown: stagedText,
		});
		expect(upserted._nay).toBeUndefined();

		const saveResult = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(saveResult._nay).toBeUndefined();

		// The accept diff assumes the staged branch shares the live document's lineage. A staged
		// branch rebuilt in a fresh Y.Doc would pass the seal shape check but duplicate the text
		// here, so assert byte equality, not containment.
		const savedText = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				rootKind: "plain_text",
			}),
		);
		expect(savedText).toBe(stagedText);

		// staged == unstaged, so the save is a full consume and the pending row is gone.
		const rowAfterSave = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(rowAfterSave).toBeNull();
	});

	test("save_file_pending_update clears pending doc when all changes are resolved", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-full",
				name: "pending-edits-save-full",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const pendingUpdateLastSequenceSavedBeforeFirstSave = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedBeforeFirstSave).toBeNull();

		const resolvedMarkdown = `${seeded.baseMarkdown}\n\nFully resolved`;
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: resolvedMarkdown,
			unstagedMarkdown: resolvedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const saveResult = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing full save");
		}
		expect(saveResult._yay.newSequence).not.toBeNull();

		const pendingUpdateLastSequenceSaved = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(saveResult._yay.newSequence);

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).toBeNull();

		const savedMarkdownAfterFullSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterFullSave).toContain("Fully resolved");
	});

	test("save_file_pending_update rejects a stale pendingUpdateId instead of falling back to the current scoped doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-stale-id",
				name: "pending-edits-save-stale-id",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const staleMarkdown = `${seeded.baseMarkdown}\n\nStale doc`;
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: staleMarkdown,
			unstagedMarkdown: staleMarkdown,
		});

		const stalePendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!stalePendingRow) {
			throw new Error("Missing stale pending doc while testing save fallback");
		}

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});

		const currentMarkdown = `${seeded.baseMarkdown}\n\nCurrent doc`;
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: currentMarkdown,
			unstagedMarkdown: currentMarkdown,
		});

		const currentPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!currentPendingRow) {
			throw new Error("Missing current pending doc while testing save fallback");
		}
		expect(currentPendingRow._id).not.toBe(stalePendingRow._id);

		const saveResult = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: stalePendingRow._id,
			})),
			pendingUpdateId: stalePendingRow._id,
		});
		// The stale id must not fall back to the newer row: saving it would publish a
		// proposal this tab never had open.
		expect(saveResult._nay?.message).toBe("Not found");

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).not.toBeNull();
		expect(pendingAfterSave!._id).toBe(currentPendingRow._id);

		const pendingUpdateLastSequenceSaved = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(pendingUpdateLastSequenceSaved).toBeNull();

		const savedMarkdownAfterRejectedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterRejectedSave).not.toContain("Current doc");
	});

	test("save_file_pending_update rejects a stale pendingUpdateId instead of accepting a newer copy proposal", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-stale-id-replace-source.md",
				name: "save-stale-id-replace-source.md",
				markdown: "# Stale save replace source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-stale-id-replace-dest.md",
				name: "save-stale-id-replace-dest.md",
				markdown: "# Stale save replace dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});

		// Tab A opens the diff editor on proposal one and holds its id.
		const firstUpserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			stagedMarkdown: dest.baseMarkdown,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nProposal one`,
		});
		if (firstUpserted._nay) {
			throw new Error(firstUpserted._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the stale save");
		}

		// Tab B discards proposal one, then the agent proposes a cp onto the file.
		await t.run(async (ctx) => {
			const [textChunks, plainTextChunks] = await Promise.all([
				list_pending_update_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});
		const replacementMarkdown = normalize_pending_update_markdown(`${source.baseMarkdown}\n\nReplacement content`);
		const secondUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: replacementMarkdown,
			unstagedMarkdown: replacementMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/save-stale-id-replace-source.md" },
		});
		if (secondUpserted._nay) {
			throw new Error(secondUpserted._nay.message);
		}
		const secondRowBefore = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!secondRowBefore) {
			throw new Error("Missing copy row before the stale save lands");
		}

		// Tab A's Save click still carries proposal one's id: acting on the copy row would publish
		// its content — accepting a proposal the user never accepted.
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
				pendingUpdateId: firstRow._id,
			})),
			pendingUpdateId: firstRow._id,
		});
		expect(saved._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// Nothing was published and the copy row stays intact.
			const committedMarkdown = await read_file_markdown_from_yjs({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				nodeId: dest.nodeId,
			});
			expect(committedMarkdown).not.toContain("Replacement content");
			const rowAfter = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(rowAfter?._id).toBe(secondRowBefore._id);
			expect(rowAfter?.copiedFrom).toEqual({
				target: { kind: "saved", id: source.nodeId },
				path: "/save-stale-id-replace-source.md",
			});
		});
	});

	test("save_file_pending_update keeps unresolved doc based on saved pending base when remote drift exists", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-no-staged",
				name: "pending-edits-save-no-staged",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: `${seeded.baseMarkdown}\n\nRemote drift`,
			}),
		);

		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const saveResultPromise = test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		await expect(saveResultPromise, "Save reconstructs the pinned Yjs updates").resolves.toMatchObject({
			_yay: { newSequence: null },
		});
		const saveResult = await saveResultPromise;
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing save without staged changes");
		}
		expect(saveResult._yay.newSequence).toBeNull();

		const pendingUpdateLastSequenceSaved = await t.run(async (ctx) =>
			read_pending_update_last_sequence_saved_doc({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(pendingUpdateLastSequenceSaved).not.toBeNull();
		expect(pendingUpdateLastSequenceSaved!.lastSequenceSaved).toBe(1);

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave).not.toBeNull();
		expect(pendingAfterSave!.content?.base).toMatchObject({ kind: "yjs", sequence: 1 });

		const pendingAfterSaveMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingAfterSave! }),
		);
		expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("# Save base");
		expect(pendingAfterSaveMarkdownState.baseMarkdown).toContain("Remote drift");
		expect(pendingAfterSaveMarkdownState.stagedMarkdown).toBe(pendingAfterSaveMarkdownState.baseMarkdown);
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Unresolved only");
		expect(pendingAfterSaveMarkdownState.unstagedMarkdown).toContain("Remote drift");

		const savedMarkdownAfterNoStagedSave = await t.run(async (ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(savedMarkdownAfterNoStagedSave).toContain("# Save base");
		expect(savedMarkdownAfterNoStagedSave).toContain("Remote drift");
		expect(savedMarkdownAfterNoStagedSave).not.toContain("Unresolved only");
	});

	test("save_file_pending_update returns rate-limit _nay and preserves pending doc when the limiter rejects", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-rate-limited",
				name: "pending-edits-save-rate-limited",
				markdown: "# Save base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Rate Limit User",
			email: "rate-limit-user@example.com",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nStaged change`;
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingBeforeSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingBeforeSave).not.toBeNull();

		for (let i = 0; i < 2; i++) {
			const result = await test_save_file_pending_update(asUser, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				...(await reviewed_pending_for_test(t, {
					membershipId: seeded.membershipId,
					target: { kind: "saved", id: seeded.nodeId },
				})),
			});
			if (result._nay) {
				throw new Error(`Expected save #${i + 1} to succeed, got: ${result._nay.message}`);
			}

			const saveMarkdown = `${seeded.baseMarkdown}\n\nStaged change ${i + 1}`;
			const upsert = await upsert_file_pending_update_internal_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				stagedMarkdown: saveMarkdown,
				unstagedMarkdown: saveMarkdown,
			});
			if (upsert._nay) {
				throw new Error(upsert._nay.message);
			}
		}

		const pendingBeforeBlockedSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingBeforeBlockedSave).not.toBeNull();

		const lastSequenceSavedBeforeBlockedSave = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(lastSequenceSavedBeforeBlockedSave?.lastSequenceSaved).toBe(2);

		// The bucket allows a burst of 50, so force the next limiter check to reject instead of
		// exhausting it with 50 real saves.
		vi.spyOn(RateLimiter.prototype, "limit").mockResolvedValueOnce({ ok: false, retryAfter: 5_000 } as never);

		const saveResult = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (!saveResult._nay) {
			throw new Error("Expected save_file_pending_update to be rate limited");
		}
		expect(saveResult._nay.message).toBe("Rate limit exceeded");

		const pendingAfterSave = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterSave?._id).toBe(pendingBeforeBlockedSave?._id);

		const lastSequenceSavedAfter = await asUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(lastSequenceSavedAfter?._id).toBe(lastSequenceSavedBeforeBlockedSave?._id);
		expect(lastSequenceSavedAfter?.lastSequenceSaved).toBe(2);

		const yjsUpdatesAfterSave = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_yjs_updates")
					.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("fileNodeId", seeded.nodeId),
					)
					.collect(),
				ctx.db
					.query("files_yjs_docs_last_sequences")
					.withIndex("by_organization_workspace_fileNode", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("fileNodeId", seeded.nodeId),
					)
					.first(),
			]).then(([updates, lastSequence]) => ({
				updateCount: updates.length,
				lastSequence: lastSequence?.lastSequence ?? null,
			})),
		);
		expect(yjsUpdatesAfterSave.updateCount).toBe(2);
		expect(yjsUpdatesAfterSave.lastSequence).toBe(2);
	});

	test("save_file_pending_update_in_db rejects a stale replayed save without publishing or billing again", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-stale-replay",
				name: "pending-edits-save-stale-replay",
				markdown: "# Stale replay base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
		const unstagedMarkdown = `${stagedMarkdown}\n\nUnresolved chunk`;
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});

		// Two tabs' save actions read this same live base before either mutation runs.
		const originalFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		const firstSave = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (firstSave._nay) {
			throw new Error(firstSave._nay.message);
		}
		if (!firstSave._yay) {
			throw new Error("Missing save result _yay while testing the stale replayed save");
		}
		expect(firstSave._yay.newSequence).toBe(1);
		await test_drain_billing_usage_event_outbox(t);
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, expect.anything());
		enqueueActionSpy.mockClear();

		// The second tab's mutation still runs with its stale action-read sequence.
		const rowBeforeReplay = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!rowBeforeReplay) {
			throw new Error("Missing pending row while testing the stale replayed save");
		}
		const replayedSave = await asUser.mutation(internal.files_pending_updates.save_file_pending_update_in_db, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			pendingUpdateId: rowBeforeReplay._id,
			expectedRevision: rowBeforeReplay.revision,
			baseYjsSequence: originalFileState.yjsSequence,
			baseLineageGeneration: 0,
		});
		expect(replayedSave._nay?.message).toBe("Stale save");
		await test_drain_billing_usage_event_outbox(t);
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.anything(),
		);

		await t.run(async (ctx) => {
			// No second publish: the sequence and update count stay at the first save's values.
			const yjsUpdates = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(yjsUpdates).toHaveLength(1);
			const lastSequenceDoc = await ctx.db
				.query("files_yjs_docs_last_sequences")
				.withIndex("by_organization_workspace_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first();
			expect(lastSequenceDoc?.lastSequence).toBe(1);
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?.content?.base).toMatchObject({ kind: "yjs", sequence: 1 });
		});
	});

	test("save_file_pending_update_in_db rejects a save whose base misses another user's commit", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-save-concurrent-commit",
				name: "pending-edits-save-concurrent-commit",
				markdown: "# Concurrent commit base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
		const unstagedMarkdown = `${stagedMarkdown}\n\nUnresolved chunk`;
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});

		// The save action reads this live base, then another user commits before the mutation runs.
		const actionReadFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const otherUserDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: `${seeded.baseMarkdown}\n\nOther user's commit`,
			}),
		);
		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			update: otherUserDiff,
			sessionId: "other-user-session",
		});
		// The push above bills its own event; only the stale save below must not bill.
		await test_drain_billing_usage_event_outbox(t);
		enqueueActionSpy.mockClear();

		// The mutation still runs with the action-read sequence: saving would stamp the pushed
		// sequence onto row content that lacks the other user's commit, hiding that commit
		// from pending reads while claiming the latest sequence.
		const rowBeforeStaleSave = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!rowBeforeStaleSave) {
			throw new Error("Missing pending row while testing the concurrent-commit stale save");
		}
		const saved = await asUser.mutation(internal.files_pending_updates.save_file_pending_update_in_db, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			pendingUpdateId: rowBeforeStaleSave._id,
			expectedRevision: rowBeforeStaleSave.revision,
			baseYjsSequence: actionReadFileState.yjsSequence,
			baseLineageGeneration: 0,
		});
		expect(saved._nay?.message).toBe("Stale save");
		await test_drain_billing_usage_event_outbox(t);
		expect(enqueueActionSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			internal.billing.ingest_events,
			expect.anything(),
		);

		await t.run(async (ctx) => {
			// Only the other user's commit exists; nothing was published on top of it.
			const yjsUpdates = await ctx.db
				.query("files_yjs_updates")
				.withIndex("by_organization_workspace_fileNode_sequence", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(yjsUpdates).toHaveLength(1);
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?.content?.base).toMatchObject({ kind: "yjs", sequence: 0 });
		});
	});
});

describe("save_file_pending_update on a file with collaboration off", () => {
	test("a full accept publishes the staged text as a member save and settles the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-accept.txt", text: "base line" }),
		);
		const stagedText = "base line\nagent line";
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedText,
			unstagedMarkdown: stagedText,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		expect(saved).toEqual({
			_yay: { target: { kind: "saved", id: seeded.nodeId }, newSequence: null, pendingUpdateRevision: null },
		});

		// The branches are retired to a cleanup task; the sweeper drain deletes them.
		await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {});
		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			if (!node?.assetId) {
				throw new Error("Expected the node to keep a content asset");
			}
			return {
				assetId: node.assetId,
				asset: await ctx.db.get("files_r2_assets", node.assetId),
				committedText: await read_committed_text({ ctx, ...seeded }),
				snapshots: (await ctx.db.query("files_snapshots").collect()).filter(
					(snapshot) => snapshot.fileNodeId === seeded.nodeId,
				),
				doc: await ctx.db.get("files_pending_updates", row._id),
				states: await ctx.db.query("files_pending_update_yjs_states").collect(),
				pendingChunks: await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id }),
				lastSequenceSaved: await read_pending_update_last_sequence_saved_doc({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			};
		});

		// The staged text is the file now, byte for byte, under a new version snapshot.
		expect(after.assetId).not.toBe(seeded.assetId);
		expect(after.committedText).toBe(stagedText);
		expect(after.snapshots).toHaveLength(1);
		expect(after.snapshots[0]?.assetId).toBe(after.assetId);

		// The version object holds the staged text, and its asset row is finalized, so the
		// unfinalized-asset sweep leaves the file's current content alone.
		const versionKey = r2_create_asset_key({
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			assetId: after.assetId,
		});
		expect(after.asset?.r2Key).toBe(versionKey);
		expect(after.asset?.unfinalizedExpiresAt).toBeUndefined();
		expect(r2Objects.get(versionKey)).toBe(stagedText);

		// The proposal is done: no doc, no branches, no pending chunks, and no Sync marker (that
		// marker only feeds the Sync gate, which this mode hides).
		expect(after.doc).toBeNull();
		expect(after.states).toHaveLength(0);
		expect(after.pendingChunks).toHaveLength(0);
		expect(after.lastSequenceSaved).toBeNull();

		// One save billed, with the version snapshot as the save id.
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(1);
		expect(enqueueActionSpy).toHaveBeenCalledWith(expect.anything(), internal.billing.ingest_events, {
			events: [
				expect.objectContaining({
					name: "file_save",
					externalCustomerId: seeded.userId,
					externalId: `file_save::${seeded.userId}::${seeded.userId}::${seeded.organizationId}::${seeded.workspaceId}::${seeded.nodeId}::${after.assetId}`,
					metadata: expect.objectContaining({ amount: 1, nodeId: seeded.nodeId, version: after.assetId }),
				}),
			],
		});
	});

	test("a full accept publishes the text and pending move together", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-accept-mixed.txt", text: "base line" }),
		);
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		const stagedText = "base line\nagent line";
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			stagedMarkdown: stagedText,
			unstagedMarkdown: stagedText,
		});
		expect(upserted._nay).toBeUndefined();
		const moved = await upsert_file_pending_move_for_test({
			...ids,
			destParentId: files_ROOT_ID,
			destName: "off-accept-mixed-renamed.txt",
		});
		expect(moved._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		expect(saved._nay).toBeUndefined();

		await t.run(async (ctx) => {
			expect(await read_committed_text({ ctx, ...seeded })).toBe(stagedText);
			expect(await ctx.db.get("files_pending_updates", row._id)).toBeNull();
			expect(saved._yay).toEqual({
				target: { kind: "saved", id: seeded.nodeId },
				newSequence: null,
				pendingUpdateRevision: null,
			});
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id })).toHaveLength(0);
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/off-accept-mixed-renamed.txt");
		});
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(1);
	});

	test("a member save between the upload and the commit refuses and hands the upload to the deletion ledger", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-accept-race.txt", text: "base line" }),
		);
		const stagedText = "base line\nagent line";
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedText,
			unstagedMarkdown: stagedText,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		// The action has read the doc and is uploading the version object when the first PUT
		// lands. A member save right then moves the node to another asset before the commit runs.
		const fetchMock = vi.mocked(globalThis.fetch);
		const uploadFetch = fetchMock.getMockImplementation();
		if (!uploadFetch) throw new Error("Expected the R2 fetch stub");
		let savedDuringUpload = false;
		fetchMock.mockImplementation(async (url, init) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (!savedDuringUpload && urlString.startsWith("https://r2.test/upload?key=")) {
				savedDuringUpload = true;
				await save_as_member({ t, seeded, text: "member line" });
			}
			return uploadFetch(url, init);
		});
		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		fetchMock.mockImplementation(uploadFetch);
		expect(savedDuringUpload).toBe(true);
		expect(saved._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);

		const after = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			return {
				assetId: node?.assetId,
				committedText: await read_committed_text({ ctx, ...seeded }),
				doc: await ctx.db.get("files_pending_updates", row._id),
				assetKeys: (await ctx.db.query("files_r2_assets").collect()).map((asset) =>
					r2_create_asset_key({
						organizationId: asset.organizationId,
						workspaceId: asset.workspaceId,
						assetId: asset._id,
					}),
				),
				deletionJobs: (await ctx.db.query("files_r2_object_deletion_jobs").collect()).filter(
					(job) => job.reason === "failed_create",
				),
			};
		});
		// The member's text stays the file, and the proposal stays for the member to discard.
		expect(after.committedText).toBe("member line");
		expect(after.doc).not.toBeNull();

		// The accept's version object was uploaded but is nobody's content now: its asset row is
		// gone and a deletion job owns its key, so nothing waits for the unfinalized-asset sweep.
		expect(after.deletionJobs).toHaveLength(1);
		const releasedKey = after.deletionJobs[0]!.r2Key;
		expect(r2Objects.get(releasedKey)).toBe(stagedText);
		expect(after.assetKeys).not.toContain(releasedKey);
		expect(after.assetKeys).toContain(
			r2_create_asset_key({
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				assetId: after.assetId!,
			}),
		);
	});

	test("a full accept on a Markdown file commits the staged branch as the rich text document reads it", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-accept.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\n- Agent item");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		expect(saved).toEqual({
			_yay: { target: { kind: "saved", id: seeded.nodeId }, newSequence: null, pendingUpdateRevision: null },
		});

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).not.toBe(seeded.assetId);
			expect(await read_committed_text({ ctx, ...seeded })).toBe(stagedMarkdown);
		});
	});

	test("a partial accept publishes the staged text and keeps the unstaged edits on the new base", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-partial.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAccepted change");
		const unstagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAccepted change\n\nUnresolved change");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		expect(saved._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).not.toBe(seeded.assetId);
			expect(await read_committed_text({ ctx, ...seeded })).toBe(stagedMarkdown);

			// The doc lives on, based on the new content asset, with the unstaged text untouched.
			const docAfter = await ctx.db.get("files_pending_updates", row._id);
			if (!docAfter) {
				throw new Error("Expected the unstaged edits to keep the pending doc");
			}
			expect(docAfter.content?.base).toEqual({ kind: "asset", assetId: node?.assetId });
			expect(docAfter.updatedAt).not.toBe(row.updatedAt);
			// The result names the rewritten doc, so the diff view can wait for its doc query to show it.
			expect(saved._yay).toEqual({
				target: { kind: "saved", id: seeded.nodeId },
				newSequence: null,
				pendingUpdateRevision: docAfter.revision,
			});
			expect(await read_pending_row_markdown_state({ ctx, pendingUpdate: docAfter })).toEqual({
				baseMarkdown: stagedMarkdown,
				stagedMarkdown,
				unstagedMarkdown,
			});
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id })).not.toHaveLength(0);
		});
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(1);
	});

	test("an accept with nothing staged writes and bills nothing and leaves the doc as it is", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-nothing-staged.md", text: "# Off base" }),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: normalize_pending_update_markdown("# Off base"),
			unstagedMarkdown: normalize_pending_update_markdown("# Off base\n\nUnresolved change"),
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		expect(saved).toEqual({
			_yay: { target: { kind: "saved", id: seeded.nodeId }, newSequence: null, pendingUpdateRevision: row.revision },
		});

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).toBe(seeded.assetId);
			expect(
				(await ctx.db.query("files_snapshots").collect()).filter((s) => s.fileNodeId === seeded.nodeId),
			).toHaveLength(0);
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(0);
	});

	test("refuses a stale proposal after a member save and changes nothing", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-accept-stale.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const savedAssetId = await save_as_member({ t, seeded, text: "# Off base\n\nMember line" });
		const read_file = () =>
			t.run(async (ctx) => ({
				assetId: (await ctx.db.get("files_nodes", seeded.nodeId))?.assetId,
				committedText: await read_committed_text({ ctx, ...seeded }),
				snapshotCount: (await ctx.db.query("files_snapshots").collect()).filter((s) => s.fileNodeId === seeded.nodeId)
					.length,
			}));
		const beforeAccept = await read_file();
		expect(beforeAccept.assetId).toBe(savedAssetId);
		await test_drain_billing_usage_event_outbox(t);
		const billedBefore = file_save_events().length;
		const count_deletion_jobs = () =>
			t.run(async (ctx) => (await ctx.db.query("files_r2_object_deletion_jobs").collect()).length);
		const objectsBefore = r2Objects.size;
		const deletionJobsBefore = await count_deletion_jobs();

		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		expect(saved._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);

		// The member's text stays the file; nothing was uploaded, versioned, or billed. The action
		// refuses before its upload: no new object in the bucket and no deletion job for one.
		expect(await read_file()).toEqual(beforeAccept);
		expect(r2Objects.size).toBe(objectsBefore);
		expect(await count_deletion_jobs()).toBe(deletionJobsBefore);
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(billedBefore);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", row._id))).toEqual(row);
	});

	test("refuses at zero credits before inserting the version asset", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-no-credits.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		await t.run(async (ctx) => {
			await test_mocks_fill_db_with.plan(ctx, { userId: seeded.userId, plan: "Free" });
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique();
			if (!usageSnapshot?.meter) {
				throw new Error("Expected seeded billing snapshot meter");
			}
			await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
				meter: { ...usageSnapshot.meter, creditedUnits: 0, balance: 0 },
			});
		});
		const assetsBefore = await t.run((ctx) => ctx.db.query("files_r2_assets").collect());
		const count_deletion_jobs = () =>
			t.run(async (ctx) => (await ctx.db.query("files_r2_object_deletion_jobs").collect()).length);
		const objectsBefore = r2Objects.size;
		const deletionJobsBefore = await count_deletion_jobs();

		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		expect(saved).toEqual({ _nay: { message: "Insufficient funds" } });

		// The credit check runs before the upload: no asset row, no object, no deletion job.
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual(assetsBefore);
		expect(r2Objects.size).toBe(objectsBefore);
		expect(await count_deletion_jobs()).toBe(deletionJobsBefore);
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(0);
	});

	test("refuses a read-only file", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-read-only.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		const objectsBefore = r2Objects.size;
		const deletionJobsBefore = await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		expect(saved._nay?.name).toBe("read_only");
		expect(r2Objects.size).toBe(objectsBefore);
		expect(await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual(deletionJobsBefore);
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.assetId).toBe(seeded.assetId);
		});
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(0);
	});

	test("the action refuses a pending delete before uploading a version", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-action-delete.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const archived = await upsert_file_pending_archive_for_test(ids);
		expect(archived._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);
		const assetsBefore = await t.run((ctx) => ctx.db.query("files_r2_assets").collect());
		const objectsBefore = r2Objects.size;
		const deletionJobsBefore = await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());

		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		expect(saved._nay?.message).toBe("File has a pending delete");
		expect(r2Objects.size).toBe(objectsBefore);
		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual(assetsBefore);
		expect(await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual(deletionJobsBefore);
		expect(await read_seeded_pending_row(t, seeded)).toEqual(row);
		expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe("# Off base");
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(0);
	});

	test("a rate-limited accept writes nothing and leaves the doc as it was", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-rate-limit.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);
		const assetsBefore = await t.run((ctx) => ctx.db.query("files_r2_assets").collect());
		const objectsBefore = r2Objects.size;
		const limitSpy = vi
			.spyOn(RateLimiter.prototype, "limit")
			.mockResolvedValueOnce({ ok: false, retryAfter: 5_000 } as never);

		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		expect(saved).toEqual({ _nay: { name: "rate_limited", message: "Rate limit exceeded" } });
		expect(limitSpy).toHaveBeenCalledWith(expect.anything(), "save_file_pending_update", expect.anything());

		expect(await t.run((ctx) => ctx.db.query("files_r2_assets").collect())).toEqual(assetsBefore);
		expect(r2Objects.size).toBe(objectsBefore);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", row._id))).toEqual(row);
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(0);
	});

	test("the commit refuses a save action that read the doc before another tab rewrote it", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-replay.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		// The action read `updatedAt` before another tab's partial accept rewrote the doc. Its
		// commit must not publish the old staged text over that.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const replayed = await asUser.mutation(
			internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: row._id,
				expectedRevision: row.revision - 1,
				publish: null,
			},
		);
		expect(replayed._nay?.message).toBe("Stale save");

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).toBe(seeded.assetId);
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(0);
	});

	test("the commit refuses when a delete was proposed after the action read the doc", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-commit-delete.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const archived = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		expect(archived._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const committed = await asUser.mutation(
			internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: row._id,
				expectedRevision: row.revision,
				publish: null,
			},
		);
		expect(committed._nay?.message).toBe("File has a pending delete");

		await t.run(async (ctx) => {
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(0);
	});

	test("the commit checks the lock again after the action's own check", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-commit-lock.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		// The action saw an unlocked file; a member locked it before the commit ran.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const locked = await asUser.mutation(api.files_nodes.set_node_write_policy, {
			writePolicy: { mode: "read_only" },
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(locked._nay).toBeUndefined();
		const committed = await asUser.mutation(
			internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: row._id,
				expectedRevision: row.revision,
				publish: null,
			},
		);
		expect(committed._nay).toMatchObject({ name: "read_only", message: "This item is read-only." });

		await t.run(async (ctx) => {
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(0);
	});

	test("the commit refuses when collaboration was turned on after the action read the doc", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-commit-collab-on.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		// The ON toggle also marks the proposal. Flip the flag alone, so the commit's own check is
		// the one that refuses.
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { collaborationEnabled: true }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const committed = await asUser.mutation(
			internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: row._id,
				expectedRevision: row.revision,
				publish: null,
			},
		);
		expect(committed._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(0);
	});

	test("the commit refuses at zero credits even when the action's check passed", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-commit-credits.md", text: "# Off base" }),
		);
		const stagedMarkdown = normalize_pending_update_markdown("# Off base\n\nAgent line");
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);

		// The action checked credits and uploaded the version object; the credits ran out before
		// its commit ran.
		const prepared = await t.mutation(internal.files_pending_updates.prepare_pending_save_assets, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			pendingUpdateId: row._id,
			expectedRevision: row.revision,
			contentSize: files_get_utf8_byte_size(stagedMarkdown),
		});
		if (prepared._nay) throw new Error(prepared._nay.message);
		const versionSnapshotAssetId = prepared._yay.assets[0]!.assetId;
		await t.run(async (ctx) => {
			await test_mocks_fill_db_with.plan(ctx, { userId: seeded.userId, plan: "Free" });
			const usageSnapshot = await ctx.db
				.query("billing_usage_snapshots")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique();
			if (!usageSnapshot?.meter) {
				throw new Error("Expected seeded billing snapshot meter");
			}
			await ctx.db.patch("billing_usage_snapshots", usageSnapshot._id, {
				meter: { ...usageSnapshot.meter, creditedUnits: 0, balance: 0 },
			});
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const committed = await asUser.mutation(
			internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				pendingUpdateId: row._id,
				expectedRevision: row.revision,
				publish: {
					text: stagedMarkdown,
					textSize: files_get_utf8_byte_size(stagedMarkdown),
					versionSnapshotAssetId,
				},
			},
		);
		expect(committed).toEqual({ _nay: { message: "Insufficient funds" } });

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.assetId).toBe(seeded.assetId);
			expect(await read_committed_text({ ctx, ...seeded })).toBe("# Off base");
			expect(await ctx.db.get("files_pending_updates", row._id)).toEqual(row);
		});
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(0);
	});

	test("a refused partial accept retires its output batch, so the next operation is not blocked", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-accept-race-partial.txt", text: "base line" }),
		);
		const stagedText = "base line\nagent line";
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: stagedText,
			unstagedMarkdown: stagedText + "\nunstaged line",
		});
		expect(upserted._nay).toBeUndefined();
		const row = await read_seeded_pending_row(t, seeded);
		// The retire marks the batch expired; the scheduled cleanup deletes the row later.
		const count_active_batches = () =>
			t.run(
				async (ctx) =>
					(await ctx.db.query("files_pending_update_operation_batches").collect()).filter(
						(batch) =>
							batch.target.kind === "saved" && batch.target.id === seeded.nodeId && (batch.expiresAt === undefined || batch.expiresAt > Date.now()),
					).length,
			);
		const count_active_temporary_states = () =>
			t.run(
				async (ctx) =>
					(await ctx.db.query("files_pending_update_yjs_states").collect()).filter(
						(state) => state.owner.kind === "temporary" && state.owner.expiresAt > Date.now(),
					).length,
			);
		expect(await count_active_batches()).toBe(0);

		// Same race as above, in the partial shape: the unstaged edit survives the accept, so the
		// action seals an output family under a batch before it uploads.
		const fetchMock = vi.mocked(globalThis.fetch);
		const uploadFetch = fetchMock.getMockImplementation();
		if (!uploadFetch) throw new Error("Expected the R2 fetch stub");
		let savedDuringUpload = false;
		fetchMock.mockImplementation(async (url, init) => {
			const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			if (!savedDuringUpload && urlString.startsWith("https://r2.test/upload?key=")) {
				savedDuringUpload = true;
				await save_as_member({ t, seeded, text: "member line" });
			}
			return uploadFetch(url, init);
		});
		const saved = await accept_as_member({ t, seeded, pendingUpdateId: row._id });
		fetchMock.mockImplementation(uploadFetch);
		expect(savedDuringUpload).toBe(true);
		expect(saved._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);

		// The batch is gone with the refusal, with its output states, and the doc still holds its
		// own states.
		expect(await count_active_batches()).toBe(0);
		expect(await count_active_temporary_states()).toBe(0);
		const after = await t.run((ctx) => ctx.db.get("files_pending_updates", row._id));
		expect(after?.content?.stagedStateId).toBe(row.content?.stagedStateId);
		expect(after?.content?.unstagedStateId).toBe(row.content?.unstagedStateId);
		// The one event is the member save during the upload. The refused accept billed nothing.
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(1);
	});
});

describe("overlay reads on a file with collaboration off", () => {
	const committedMarkdown = "# Off overlay\n\ncommitted needle\n";
	// The needle moves from line 3 to line 5 so `grep` tells the two texts apart by line number.
	const proposalMarkdown = normalize_pending_update_markdown("# Off overlay\n\nnew first line\n\nproposal needle");

	async function seed_file_with_proposal(t: ReturnType<typeof test_convex>, path: string) {
		const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path, text: committedMarkdown }));
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: proposalMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected a pending content doc");
		}
		return { seeded, row, readScope: { organizationId: seeded.organizationId, workspaceId: seeded.workspaceId } };
	}

	test("the read doors serve the proposal instead of the committed text", async () => {
		const t = test_convex();
		const path = "/off-overlay-fresh.md";
		const { seeded, row, readScope } = await seed_file_with_proposal(t, path);

		// read_file_content_from_chunks: the door behind bash `cat` and the agent file tools.
		const full = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			...readScope,
			userId: seeded.userId,
			path,
			mode: { kind: "full", maxBytes: 10_000 },
		});
		if (!full) throw new Error("expected a full read");
		expect(full.content).toBe(proposalMarkdown);
		expect(full.pendingUpdateId).toBe(row._id);

		// read_committed_file_chunk_stats: the door behind `wc`. A proposal is not in the
		// committed chunks, so the caller must count the in-memory text instead.
		const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
			...readScope,
			userId: seeded.userId,
			path,
		});
		expect(stats.usable).toBe(false);

		// match_plain_text_file_lines: the door behind `textgrep`.
		const textgrep = await t.query(internal.files_nodes.match_plain_text_file_lines, {
			...readScope,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
			pattern: "needle",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
		});
		if (!textgrep) throw new Error("expected a textgrep result");
		expect(textgrep.lines.map(({ lineNumber }) => lineNumber)).toEqual([5]);

		// match_text_file_lines: the door behind `grep` and `sed`.
		const grep = await t.query(internal.files_nodes.match_text_file_lines, {
			...readScope,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
			pattern: "needle",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
			before: 0,
			after: 0,
		});
		if (!grep) throw new Error("expected a grep result");
		expect(grep.lines.map(({ lineNumber }) => lineNumber)).toEqual([5]);

		// get_file_text_content_db_state_by_path: the door behind the app editor and `edit_file`.
		const state = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			...readScope,
			userId: seeded.userId,
			path,
		});
		if (!state) throw new Error("expected a content state");
		expect(state.content).toBe(proposalMarkdown);
		expect(state.pendingUpdateId).toBe(row._id);

		// Workspace search reads the proposal's pending chunks instead of the committed ones.
		// Pending chunks and committed chunks are two queries, so read every page.
		const search = async (query: string) => {
			const paths: string[] = [];
			let cursor: string | null = null;
			for (let page = 0; page < 10; page++) {
				const result: FunctionReturnType<typeof internal.files_nodes.text_search_files> = await t.query(
					internal.files_nodes.text_search_files,
					{ ...readScope, userId: seeded.userId, hasWorkspaceRead: true, query, numItems: 10, cursor },
				);
				paths.push(...result.items.map((item) => item.path));
				if (result.isDone) break;
				cursor = result.continueCursor;
			}
			return paths;
		};
		expect(await search("proposal")).toContain(path);
		expect(await search("committed")).not.toContain(path);
	});

	test("after a member save the read doors hide the stale proposal and serve the saved text", async () => {
		const t = test_convex();
		const path = "/off-overlay-stale.md";
		const { seeded, row, readScope } = await seed_file_with_proposal(t, path);
		const savedMarkdown = "# Off overlay\n\nsaved needle\n";
		await save_as_member({ t, seeded, text: savedMarkdown });

		const full = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			...readScope,
			userId: seeded.userId,
			path,
			mode: { kind: "full", maxBytes: 10_000 },
		});
		if (!full) throw new Error("expected a full read");
		expect(full.content).toBe(savedMarkdown);

		// read_committed_file_chunk_stats: the door behind `wc`. The stale proposal has no text of
		// its own, so the committed chunks answer with the saved text's counts.
		const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
			...readScope,
			userId: seeded.userId,
			path,
		});
		expect(stats).toMatchObject({ usable: true, nodeId: seeded.nodeId, lineCount: 3 });

		const textgrep = await t.query(internal.files_nodes.match_plain_text_file_lines, {
			...readScope,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
			pattern: "needle",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
		});
		if (!textgrep) throw new Error("expected a textgrep result");
		expect(textgrep.lines.map(({ lineNumber }) => lineNumber)).toEqual([3]);

		const grep = await t.query(internal.files_nodes.match_text_file_lines, {
			...readScope,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
			pattern: "needle",
			ignoreCase: false,
			fixedStrings: true,
			invert: false,
			before: 0,
			after: 0,
		});
		if (!grep) throw new Error("expected a grep result");
		expect(grep.lines.map(({ lineNumber }) => lineNumber)).toEqual([3]);

		// The stale doc stays, and the door still names it, so the agent's next write rebuilds
		// the proposal on it instead of creating a second doc.
		const state = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			...readScope,
			userId: seeded.userId,
			path,
		});
		if (!state) throw new Error("expected a content state");
		expect(state.content).toBe(savedMarkdown);
		expect(state.pendingUpdateId).toBe(row._id);
		expect(state.materializationState).toBeNull();

		// Pending chunks and committed chunks are two queries, so read every page.
		const search = async (query: string) => {
			const paths: string[] = [];
			let cursor: string | null = null;
			for (let page = 0; page < 10; page++) {
				const result: FunctionReturnType<typeof internal.files_nodes.text_search_files> = await t.query(
					internal.files_nodes.text_search_files,
					{ ...readScope, userId: seeded.userId, hasWorkspaceRead: true, query, numItems: 10, cursor },
				);
				paths.push(...result.items.map((item) => item.path));
				if (result.isDone) break;
				cursor = result.continueCursor;
			}
			return paths;
		};
		expect(await search("saved")).toContain(path);
		expect(await search("proposal")).not.toContain(path);
	});

	test("wc counts the committed text behind a move-only doc", async () => {
		const t = test_convex();
		const path = "/off-overlay-move.md";
		const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path, text: committedMarkdown }));
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "off-overlay-moved.md",
		});
		expect(moved._nay).toBeUndefined();

		// A move-only doc has no text, so `wc` must not be sent to the in-memory read path.
		const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path,
		});
		expect(stats).toMatchObject({ usable: true, nodeId: seeded.nodeId, lineCount: 3 });
	});

	test("metadata search reads the proposal's frontmatter until a member save makes it stale", async () => {
		const t = test_convex();
		const path = "/off-overlay-frontmatter.md";
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path, text: "---\ntitle: committed\n---\n\n# Body\n" }),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "---\ntitle: proposal\n---\n\n# Body",
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const search_title = async (value: string) =>
			(
				await test_meta_search(t, {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					plan: { op: "eq", fieldPath: "frontmatter.title", value },
				})
			).items.map((item) => item.path);

		expect(await search_title("proposal")).toContain(path);
		expect(await search_title("committed")).not.toContain(path);

		await save_as_member({ t, seeded, text: "---\ntitle: saved\n---\n\n# Body\n" });
		expect(await search_title("saved")).toContain(path);
		expect(await search_title("proposal")).not.toContain(path);
	});

	test("the sidebar search reads the saved title while the by-path metadata door reads the proposal", async () => {
		const t = test_convex();
		const path = "/off-overlay-frontmatter-doors.md";
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path, text: "---\ntitle: committed\n---\n\n# Body\n" }),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "---\ntitle: proposal\n---\n\n# Body",
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		// The search box is saved-only: it never finds a proposal.
		const search_saved_title = async (value: string) => {
			const found = await asUser.query(api.files_nodes.search_saved, {
				membershipId: seeded.membershipId,
				clause: { kind: "metadata", plan: { op: "eq", fieldPath: "frontmatter.title", value } },
				paginationOpts: { numItems: 50, cursor: null },
			});
			return found.page.map((row) => (row.kind === "problem" ? row.message : row.nodeId));
		};
		const title_by_path = async () => {
			const found = await t.query(internal.files_metadata.get_by_path, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path,
			});
			return found?.values.find((value) => value.fieldPath === "frontmatter.title")?.stringValue;
		};

		expect(await search_saved_title("proposal")).toEqual([]);
		expect(await search_saved_title("committed")).toEqual([seeded.nodeId]);
		expect(await title_by_path()).toBe("proposal");

		await save_as_member({ t, seeded, text: "---\ntitle: saved\n---\n\n# Body\n" });
		expect(await search_saved_title("saved")).toEqual([seeded.nodeId]);
		expect(await search_saved_title("proposal")).toEqual([]);
		expect(await title_by_path()).toBe("saved");
	});
});

describe("files_pending_updates_last_sequence_saved", () => {
	test("upsert_file_pending_update and persist_file_pending_update_rebased_state do not write last saved sequence marker", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-save-marker-non-save-paths",
				name: "pending-edits-save-marker-non-save-paths",
				markdown: "# Save marker base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const pendingUpdateLastSequenceSavedBeforeChanges = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedBeforeChanges).toBeNull();

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const pendingUpdateLastSequenceSavedAfterUpsert = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedAfterUpsert).toBeNull();

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to create unstaged branch while testing save marker non-save paths");
		}

		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}

		const pendingUpdateLastSequenceSavedAfterPersist = await asUser.query(
			api.ai_chat.get_file_pending_update_last_sequence_saved,
			{
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
			},
		);
		expect(pendingUpdateLastSequenceSavedAfterPersist).toBeNull();
	});
});

describe("files_pending_updates_db_mark_content_for_rebase", () => {
	test("keeps every owner's content and expiry while leaving structural and copy proposals alone", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path: "/mark.txt", text: "base\n" }));
		const otherUserId = await t.run(async (ctx) => {
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_mark_other" });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				role: "member",
				now: Date.now(),
			});
			return userId;
		});
		for (const userId of [seeded.userId, otherUserId]) {
			expect(
				(
					await upsert_file_pending_update_internal_for_test({
						t,
						...seeded,
						userId,
						unstagedMarkdown: `markedneedle ${userId}\n`,
					})
				)._nay,
			).toBeUndefined();
		}
		expect((await upsert_file_pending_archive_for_test({ t, ...seeded, userId: otherUserId }))._nay).toBeUndefined();

		const before = await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			const baseContentVersion = await files_nodes_db_get_content_version(ctx, node!);
			if (!baseContentVersion) throw new Error("Missing saved content version");
			for (const [userId, extra] of [
				[
					"move-owner",
					{ pendingMove: { destParent: { kind: "root" }, destName: "renamed.txt", fromPath: "/mark.txt" } },
				],
				[
					"copy-owner",
					{
						copiedFrom: { target: { kind: "saved", id: seeded.nodeId }, path: "/source.txt" },
						pendingReplacement: {
							assetId: seeded.assetId,
							baseAssetId: seeded.assetId,
							baseContentVersion,
							size: 5,
							contentType: "text/plain",
							yjsRootKind: "plain_text" as const,
						},
					},
				],
			] as const) {
				await ctx.db.insert("files_pending_updates", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: await ctx.db.insert("users", { clerkUserId: userId }),
					target: { kind: "saved", id: seeded.nodeId },
					revision: 1,
					size: 0,
					updatedAt: 123,
					expiresAt: 123 + files_DRAFT_IDLE_EXPIRY_MS,
					...extra,
				});
			}
			for (const userId of [seeded.userId, otherUserId])
				await ctx.db.insert("files_pending_updates_last_sequence_saved", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId,
					fileNodeId: seeded.nodeId,
					lastSequenceSaved: 9,
					updatedAt: 123,
				});
			return {
				docs: await ctx.db.query("files_pending_updates").collect(),
				states: await ctx.db.query("files_pending_update_yjs_states").collect(),
				pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
				chunks: await ctx.db.query("files_text_chunks").collect(),
				checks: await ctx.db.query("files_pending_update_expiry_checks").collect(),
			};
		});

		const searchArgs = {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			hasWorkspaceRead: true,
			query: "markedneedle",
			numItems: 10,
			cursor: null,
		};
		expect(
			(await t.query(internal.files_nodes.text_search_files, searchArgs)).items.map((item) => item.path),
		).toContain("/mark.txt");
		await t.run((ctx) => files_pending_updates_db_mark_content_for_rebase(ctx, seeded));
		await t.run((ctx) => files_pending_updates_db_mark_content_for_rebase(ctx, seeded));
		expect((await t.query(internal.files_nodes.text_search_files, searchArgs)).items).toEqual([]);
		const content = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/mark.txt",
			mode: { kind: "full", maxBytes: 1000 },
		});
		expect(content?.content).toBe("base\n");

		await t.run(async (ctx) => {
			for (const doc of before.docs) {
				expect(await ctx.db.get("files_pending_updates", doc._id)).toEqual(
					doc.content ? { ...doc, contentNeedsRebase: true, revision: doc.revision + 1 } : doc,
				);
			}
			expect(await ctx.db.query("files_pending_update_yjs_states").collect()).toEqual(before.states);
			expect(await ctx.db.query("files_pending_update_yjs_state_pages").collect()).toEqual(before.pages);
			expect(await ctx.db.query("files_text_chunks").collect()).toEqual(before.chunks);
			expect(await ctx.db.query("files_pending_update_expiry_checks").collect()).toEqual(before.checks);
			expect(await ctx.db.query("files_pending_updates_last_sequence_saved").collect()).toEqual([]);
		});
	});

	test("removes saved markers even when there is no content proposal", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path: "/mark-empty.txt", text: "base\n" }));
		await t.run(async (ctx) => {
			await ctx.db.insert("files_pending_updates_last_sequence_saved", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				fileNodeId: seeded.nodeId,
				lastSequenceSaved: 9,
				updatedAt: 123,
			});
			await files_pending_updates_db_mark_content_for_rebase(ctx, seeded);
			expect(await ctx.db.query("files_pending_updates_last_sequence_saved").collect()).toEqual([]);
		});
	});
});

describe("files_db_get_pending_update", () => {
	test("keeps saved targets, private targets, and owners separate", async () => {
		const t = test_convex();
		await t.run(async (ctx) => {
			const seeded = await seed_non_collaborative_file({ ctx, path: "/target-lookup.txt", text: "base" });
			const { organizationId, workspaceId, userId } = seeded;
			const otherUserId = await ctx.db.insert("users", { clerkUserId: "other-pending-owner" });
			const privateNodeId = await ctx.db.insert("files_pending_nodes", {
				organizationId,
				workspaceId,
				userId,
				kind: "folder",
				name: "private",
				parent: { kind: "root" },
				creationGeneration: 1,
				structuralRevision: 1,
				state: "active",
				closedAt: null,
			});
			const savedId = await ctx.db.insert("files_pending_updates", {
				organizationId,
				workspaceId,
				userId,
				target: { kind: "saved", id: seeded.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			});
			const privateId = await ctx.db.insert("files_pending_updates", {
				organizationId,
				workspaceId,
				userId,
				target: { kind: "private", id: privateNodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			});
			expect(
				(
					await files_db_get_pending_update(ctx, {
						organizationId,
						workspaceId,
						userId,
						target: { kind: "private", id: privateNodeId },
						pendingUpdateId: savedId,
					})
				)?._id,
			).toBe(privateId);
			expect(
				(
					await files_db_get_pending_update(ctx, {
						organizationId,
						workspaceId,
						userId,
						target: { kind: "saved", id: seeded.nodeId },
						pendingUpdateId: privateId,
					})
				)?._id,
			).toBe(savedId);
			expect(
				await files_db_get_pending_update(ctx, {
					organizationId,
					workspaceId,
					userId: otherUserId,
					target: { kind: "private", id: privateNodeId },
					pendingUpdateId: privateId,
				}),
			).toBeNull();
		});
	});
});

describe("get_file_pending_update", () => {
	test.each(["plain_text", "rich_text"] as const)(
		"returns the current document id with marked and prepared %s content",
		async (rootKind) => {
			const t = test_convex();
			const path = rootKind === "rich_text" ? "/query-current.md" : "/query-current.txt";
			const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path, text: "base\n" }));
			r2Objects.set(`content-snapshot${path}`, "base\n");
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
			expect(
				(
					await upsert_file_pending_update_public_for_test(asUser, {
						...seeded,
						unstagedMarkdown: "proposed\n",
					})
				)._nay,
			).toBeUndefined();
			const original = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
			if (!original) throw new Error("Expected the original proposal");
			const queryArgs = {
				membershipId: seeded.membershipId,
				target: { kind: "saved" as const, id: seeded.nodeId },
				pendingUpdateId: original._id,
			};
			expect(await asUser.query(api.files_pending_updates.get_file_pending_update, queryArgs)).toEqual({
				...original,
				currentYjsLastSequenceId: null,
			});

			for (const collaborative of [true, false]) {
				const toggled = collaborative
					? await asUser.action(api.files_nodes_content.set_file_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
						})
					: await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
							acknowledgeDropCollaborativeHistory: true,
						});
				expect(toggled._nay).toBeUndefined();
				const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
				const currentYjsLastSequenceId = node?.yjsLastSequenceId ?? null;
				if (collaborative) expect(currentYjsLastSequenceId).not.toBeNull();
				else expect(currentYjsLastSequenceId).toBeNull();
				const marked = await t.run((ctx) => ctx.db.get("files_pending_updates", original._id));
				expect(marked?.contentNeedsRebase).toBe(true);
				expect(await asUser.query(api.files_pending_updates.get_file_pending_update, queryArgs)).toEqual({
					...marked,
					currentYjsLastSequenceId,
				});
				const prepared = await asUser.action(
					api.files_pending_updates.prepare_file_pending_update_for_review,
					queryArgs,
				);
				expect(prepared._nay).toBeUndefined();
				expect(prepared._yay?.pendingUpdate?.contentNeedsRebase).toBeUndefined();
				expect(await asUser.query(api.files_pending_updates.get_file_pending_update, queryArgs)).toEqual({
					...prepared._yay?.pendingUpdate,
					currentYjsLastSequenceId,
				});
			}

			const other = await t.run(async (ctx) => {
				const userId = await ctx.db.insert("users", { clerkUserId: "clerk_query_other" });
				const membershipId = await ctx.db.insert("organizations_workspaces_users", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId,
					active: true,
					pendingOrganizationRemoval: false,
					updatedAt: Date.now(),
				});
				await access_control_db_ensure_role_assignment(ctx, {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId,
					role: "member",
					now: Date.now(),
				});
				return { userId, membershipId };
			});
			const asOther = t.withIdentity({ issuer: "https://clerk.test", external_id: other.userId, name: "Other Member" });
			expect(
				await asOther.query(api.files_pending_updates.get_file_pending_update, {
					...queryArgs,
					membershipId: other.membershipId,
				}),
			).toBeNull();
		},
	);
});

describe("pending text after restore and collaborative edits", () => {
	async function seed_proposal(args: {
		rootKind: "plain_text" | "rich_text";
		collaborative: boolean;
		base: string;
		staged: string;
		unstaged: string;
	}) {
		const t = test_convex();
		const path = args.rootKind === "rich_text" ? "/accepted-changes.md" : "/accepted-changes.txt";
		const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path, text: args.base }));
		r2Objects.set(`content-snapshot${path}`, args.base);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		if (args.collaborative) {
			expect(
				(
					await asUser.action(api.files_nodes_content.set_file_collaborative, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
					})
				)._nay,
			).toBeUndefined();
		}
		// Create the branches after enabling collaboration so they share the live history.
		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					stagedMarkdown: args.staged,
					unstagedMarkdown: args.unstaged,
				})
			)._nay,
		).toBeUndefined();
		const original = await read_seeded_pending_row(t, seeded);
		const proposalArgs = {
			membershipId: seeded.membershipId,
			target: { kind: "saved" as const, id: seeded.nodeId },
			pendingUpdateId: original._id,
		};
		return { t, seeded, asUser, original, proposalArgs };
	}

	async function push_live_edit(fixture: Awaited<ReturnType<typeof seed_proposal>>, edit: (doc: YDoc) => void) {
		const { t, seeded, asUser } = fixture;
		const live = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
		const before = files_yjs_doc_create_from_array_buffer_update(live.yjsUpdate);
		const after = files_yjs_doc_clone({ yjsDoc: before });
		try {
			edit(after);
			const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: after, yjsBeforeDoc: before });
			if (!update) throw new Error("Expected a live edit");
			expect(
				(
					await asUser.mutation(api.files_nodes.yjs_push_update, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
						update: files_u8_to_array_buffer(update),
						sessionId: "accepted-changes-live-edit",
					})
				)._nay,
			).toBeUndefined();
		} finally {
			before.destroy();
			after.destroy();
		}
	}

	async function save_staged_then_accept_remaining(
		fixture: Awaited<ReturnType<typeof seed_proposal>>,
		args: { rootKind: "plain_text" | "rich_text"; collaborative: boolean; staged: string; unstaged: string },
	) {
		const { t, seeded, asUser, proposalArgs } = fixture;
		const readCurrent = () =>
			t.run((ctx) =>
				args.collaborative
					? read_file_markdown_from_yjs({ ctx, ...seeded, rootKind: args.rootKind })
					: read_committed_text({ ctx, ...seeded }),
			);
		const reviewed = await read_seeded_pending_row(t, seeded);
		expect(
			(
				await test_save_file_pending_update(asUser, {
					...proposalArgs,
					reviewedRevision: reviewed.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(await readCurrent()).toBe(args.staged);
		const remaining = await read_seeded_pending_row(t, seeded);
		expect(remaining._id).toBe(reviewed._id);
		expect(
			await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: remaining, rootKind: args.rootKind })),
		).toEqual({
			baseMarkdown: args.staged,
			stagedMarkdown: args.staged,
			unstagedMarkdown: args.unstaged,
		});
		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...proposalArgs,
					nodeId: proposalArgs.target.id,
					reviewedRevision: remaining.revision,
					stagedMarkdown: args.unstaged,
					unstagedMarkdown: args.unstaged,
				})
			)._nay,
		).toBeUndefined();
		const accepted = await read_seeded_pending_row(t, seeded);
		expect(
			(
				await test_save_file_pending_update(asUser, {
					...proposalArgs,
					reviewedRevision: accepted.revision,
				})
			)._nay,
		).toBeUndefined();
		expect(await readCurrent()).toBe(args.unstaged);
		expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();
		if (args.collaborative) {
			const live = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
			const doc = files_yjs_doc_create_from_array_buffer_update(live.yjsUpdate);
			expect(doc.store.pendingStructs).toBeNull();
			expect(doc.store.pendingDs).toBeNull();
			doc.destroy();
		}
	}

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((sourceRootKind) =>
			[false, true].map((collaborative) => ({ sourceRootKind, collaborative })),
		),
	)(
		"prepares a $sourceRootKind shape-changing restore and saves both branches (collaboration $collaborative)",
		async ({ sourceRootKind, collaborative }) => {
			const rootKind = sourceRootKind === "plain_text" ? "rich_text" : "plain_text";
			const base = "Budget: 100\n\nOwner: Bob\n\nTail: old\n";
			const staged = base.replace("100", "150");
			const unstaged = base.replace("100", "170");
			const fixture = await seed_proposal({ rootKind: sourceRootKind, collaborative, base, staged, unstaged });
			const { t, seeded, asUser, original, proposalArgs } = fixture;

			const restoredText = base.replace("100", "120").replace("Bob", "Alice");
			const snapshotId = await t.run(async (ctx) => {
				const assetId = await ctx.db.insert("files_r2_assets", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					kind: "content_snapshot",
					r2Bucket: "test-bucket",
					size: files_get_utf8_byte_size(restoredText),
					createdBy: seeded.userId,
					updatedAt: Date.now(),
				});
				const r2Key = `test/accepted-restore-${assetId}`;
				r2Objects.set(r2Key, restoredText);
				await ctx.db.patch("files_r2_assets", assetId, { r2Key });
				return await ctx.db.insert("files_snapshots", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					fileNodeId: seeded.nodeId,
					assetId,
					createdBy: seeded.userId,
					archivedAt: 0,
					contentType: rootKind === "rich_text" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8",
					yjsRootKind: rootKind,
					collaborationEnabled: true,
				});
			});

			expect(
				(
					await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						snapshotId,
						sessionId: "accepted-shape-restore",
					})
				)._nay,
			).toBeUndefined();
			expect(await read_seeded_pending_row(t, seeded)).toEqual({
				...original,
				revision: original.revision + 1,
				contentNeedsRebase: true,
				contentRebaseRootKind: sourceRootKind,
			});

			// Preparation uses the latest saved text, including edits made after the restore.
			const current = restoredText.replace("Tail: old", "Tail: current");
			if (collaborative) {
				await push_live_edit(fixture, (doc) => {
					expect(files_yjs_doc_update_from_text({ mut_yjsDoc: doc, text: current, rootKind })._nay).toBeUndefined();
				});
			} else {
				await save_as_member({ t, seeded, text: current });
			}

			const result = await asUser.action(
				api.files_pending_updates.prepare_file_pending_update_for_review,
				proposalArgs,
			);
			expect(result._nay).toBeUndefined();
			const prepared = result._yay?.pendingUpdate;
			if (!prepared) throw new Error("Expected the prepared proposal");
			expect(prepared.contentNeedsRebase).toBeUndefined();
			expect(prepared.contentRebaseRootKind).toBeUndefined();
			const mergedStaged = current.replace("120", "150");
			const mergedUnstaged = current.replace("120", "170");
			expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: prepared, rootKind }))).toEqual(
				{
					baseMarkdown: current,
					stagedMarkdown: mergedStaged,
					unstagedMarkdown: mergedUnstaged,
				},
			);

			await save_staged_then_accept_remaining(fixture, {
				rootKind,
				collaborative,
				staged: mergedStaged,
				unstaged: mergedUnstaged,
			});
		},
	);

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((rootKind) =>
			[false, true].flatMap((collaborative) =>
				["120", "200"].map((savedBudget) => ({ rootKind, collaborative, savedBudget })),
			),
		),
	)(
		"saves accepted 150 over saved $savedBudget and keeps proposed 170 in $rootKind (collaboration $collaborative)",
		async ({ rootKind, collaborative, savedBudget }) => {
			const base = "Budget: 100\n\nOwner: Bob\n";
			const fixture = await seed_proposal({
				rootKind,
				collaborative,
				base,
				staged: base.replace("100", "150"),
				unstaged: base.replace("100", "170"),
			});
			const { t, seeded, asUser, proposalArgs } = fixture;
			const current = base.replace("100", savedBudget).replace("Bob", "Alice");

			if (collaborative) {
				await push_live_edit(fixture, (doc) => {
					expect(files_yjs_doc_update_from_text({ mut_yjsDoc: doc, text: current, rootKind })._nay).toBeUndefined();
				});
			} else {
				await save_as_member({ t, seeded, text: current });
				const result = await asUser.action(
					api.files_pending_updates.prepare_file_pending_update_for_review,
					proposalArgs,
				);
				expect(result._nay).toBeUndefined();
			}

			// A collaborative Save also merges changes that arrived after the review.
			await save_staged_then_accept_remaining(fixture, {
				rootKind,
				collaborative,
				staged: current.replace(savedBudget, "150"),
				unstaged: current.replace(savedBudget, "170"),
			});
		},
	);

	test.each(
		(["plain_text", "rich_text"] as const).flatMap((rootKind) =>
			(["delete", "move"] as const).flatMap((edit) => [false, true].map((prepare) => ({ rootKind, edit, prepare }))),
		),
	)(
		"keeps a proposed section after a shared-history $edit in $rootKind (prepare $prepare)",
		async ({ rootKind, edit, prepare }) => {
			const base = "First section.\n\nTarget section.\n\nLast section.\n";
			const fixture = await seed_proposal({
				rootKind,
				collaborative: true,
				base,
				staged: base.replace("Target section.", "Target accepted."),
				unstaged: base.replace("Target section.", "Target proposed."),
			});
			const { t, seeded, asUser, original, proposalArgs } = fixture;
			const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }));

			await push_live_edit(fixture, (doc) => {
				if (rootKind === "rich_text") {
					const fragment = doc.getXmlFragment("default");
					const moved = fragment.get(1).clone();
					fragment.delete(1, 1);
					if (edit === "move") fragment.insert(fragment.length, [moved]);
				} else {
					const text = doc.getText("plain_text");
					text.delete(base.indexOf("Target section."), "Target section.\n\n".length);
					if (edit === "move") text.insert(text.length, "\nTarget section.\n");
				}
				const text = files_yjs_doc_get_text({ yjsDoc: doc, rootKind });
				if (text._nay) throw new Error(text._nay.message);
				expect(
					files_yjs_doc_update_from_text({
						mut_yjsDoc: doc,
						rootKind,
						text: text._yay.replace("Last section.", "Last changed."),
					})._nay,
				).toBeUndefined();
			});
			expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }))).toEqual(bytes);
			const current =
				edit === "move" ? "First section.\n\nLast changed.\n\nTarget section.\n" : "First section.\n\nLast changed.\n";
			expect(await t.run((ctx) => read_file_markdown_from_yjs({ ctx, ...seeded, rootKind }))).toBe(current);

			const staged =
				edit === "move"
					? current.replace("Target section.", "Target accepted.")
					: "First section.\n\nTarget accepted.\n\nLast changed.\n";
			const unstaged = staged.replace("Target accepted.", "Target proposed.");

			if (prepare) {
				const result = await asUser.action(
					api.files_pending_updates.prepare_file_pending_update_for_review,
					proposalArgs,
				);
				expect(result._nay).toBeUndefined();
				const pendingUpdate = result._yay?.pendingUpdate;
				if (!pendingUpdate) throw new Error("Expected the prepared proposal");
				expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate, rootKind }))).toEqual({
					baseMarkdown: current,
					stagedMarkdown: staged,
					unstagedMarkdown: unstaged,
				});
			}

			await save_staged_then_accept_remaining(fixture, { rootKind, collaborative: true, staged, unstaged });
		},
	);

	test.each([false, true])("refuses Save from an older accepted pane (collaboration %s)", async (collaborative) => {
		const base = "Budget: 100\n";
		const { t, seeded, asUser, original, proposalArgs } = await seed_proposal({
			rootKind: "plain_text",
			collaborative,
			base,
			staged: "Budget: 150\n",
			unstaged: "Budget: 170\n",
		});

		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...proposalArgs,
					nodeId: proposalArgs.target.id,
					reviewedRevision: original.revision,
					stagedMarkdown: "Budget: 160\n",
					unstagedMarkdown: "Budget: 170\n",
				})
			)._nay,
		).toBeUndefined();
		const newer = await read_seeded_pending_row(t, seeded);
		expect(newer.updatedAt).not.toBe(original.updatedAt);

		const result = await test_save_file_pending_update(asUser, {
			...proposalArgs,
			reviewedRevision: original.revision,
		});

		expect(result._nay).toBeDefined();
		expect(await read_seeded_pending_row(t, seeded)).toEqual(newer);
		expect(
			await t.run((ctx) =>
				collaborative
					? read_file_markdown_from_yjs({ ctx, ...seeded, rootKind: "plain_text" })
					: read_committed_text({ ctx, ...seeded }),
			),
		).toBe(base);
	});
});

describe("prepare_file_pending_update_for_agent upload in flight", () => {
	test("refuses a file whose upload has not landed, then allows it after landing", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const now = Date.now();
		const ids = await t.run(async (ctx) => {
			const assetId = await ctx.db.insert("files_r2_assets", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				kind: "upload",
				r2Bucket: "test-bucket",
				size: 10,
				createdBy: db.userId,
				unfinalizedExpiresAt: now + 60 * 1000,
				updatedAt: now,
			});
			const nodeId = await ctx.db.insert("files_nodes", {
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				parentId: files_ROOT_ID,
				path: "/uploading.txt",
				treePath: "/uploading.txt",
				pathDepth: 1,
				lowercaseExtension: "txt",
				name: "uploading.txt",
				sortName: files_sort_text_key("uploading.txt"),
				kind: "file",
				contentType: "text/plain",
				assetId,
				contentByteSize: null,
				createdBy: db.userId,
				updatedBy: db.userId,
				updatedAt: now,
				textKind: null,
				collaborationEnabled: null,
				yjsSnapshotId: null,
				yjsLastSequenceId: null,
				statsId: null,
				contentTooLargeByteSize: null,
				contentShapeMismatchAt: null,
				contentYjsStateTooLargeByteSize: null,
				contentFrontmatterTooLargeFieldCount: null,
				contentFrontmatterTooLargeIndexDocumentCount: null,
				restrictedScopeNodeId: null,
				isRestrictedScopeRoot: false,
				writePolicy: null,
				archiveOperationId: null,
				newChildWritePolicy: null,
			});
			return { assetId, nodeId };
		});

		const args = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			target: { kind: "saved" as const, id: ids.nodeId },
		};
		const refused = await t.action(internal.files_pending_updates.prepare_file_pending_update_for_agent, args);
		expect(refused._nay).toMatchObject({ name: "upload_in_progress" });

		await t.run(async (ctx) => ctx.db.patch("files_r2_assets", ids.assetId, { r2Key: "landed-key" }));
		const allowed = await t.action(internal.files_pending_updates.prepare_file_pending_update_for_agent, args);
		expect(allowed._nay?.name).not.toBe("upload_in_progress");
	});
});

describe("prepare_file_pending_update_for_review after a member save", () => {
	async function seed_stale_proposal(args: {
		base: string;
		staged: string;
		unstaged: string;
		current: string;
		rootKind?: "plain_text" | "rich_text";
	}) {
		const t = test_convex();
		const rootKind = args.rootKind ?? "plain_text";
		const path = rootKind === "rich_text" ? "/saved-proposal.md" : "/saved-proposal.txt";
		const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path, text: args.base }));
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					stagedMarkdown: args.staged,
					unstagedMarkdown: args.unstaged,
				})
			)._nay,
		).toBeUndefined();
		const original = await read_seeded_pending_row(t, seeded);
		const currentAssetId = await save_as_member({ t, seeded, text: args.current });
		expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
		expect(original.contentNeedsRebase).toBeUndefined();
		const prepareArgs = {
			membershipId: seeded.membershipId,
			target: { kind: "saved" as const, id: seeded.nodeId },
			pendingUpdateId: original._id,
		};
		return { t, seeded, asUser, original, currentAssetId, prepareArgs, rootKind };
	}

	test.each(["plain_text", "rich_text"] as const)(
		"merges saved %s text and keeps accepted and proposed changes separate",
		async (rootKind) => {
			const base = "first\n\nsecond\n\nlast\n";
			const staged = base.replace("first", "FIRST");
			const unstaged = staged.replace("second", "SECOND");
			const current = base.replace("last", "LAST");
			const { t, seeded, asUser, original, currentAssetId, prepareArgs } = await seed_stale_proposal({
				base,
				staged,
				unstaged,
				current,
				rootKind,
			});
			await test_drain_billing_usage_event_outbox(t);
			const savesBefore = file_save_events().length;

			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay).toBeUndefined();
			const prepared = result._yay?.pendingUpdate;
			if (!prepared) throw new Error("Expected the prepared proposal");
			expect(prepared._id).toBe(original._id);
			expect(prepared.content?.base).toEqual({ kind: "asset", assetId: currentAssetId });
			expect(prepared.content?.baseStateId).not.toBe(original.content?.baseStateId);
			expect(prepared.contentNeedsRebase).toBeUndefined();
			expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: prepared, rootKind }))).toEqual(
				{
					baseMarkdown: current,
					stagedMarkdown: staged.replace("last", "LAST"),
					unstagedMarkdown: unstaged.replace("last", "LAST"),
				},
			);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(current);
			await test_drain_billing_usage_event_outbox(t);
			expect(file_save_events()).toHaveLength(savesBefore);

			// A second Review does not replace a family that is already current.
			expect(
				await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs),
			).toEqual(result);

			expect(
				(
					await test_save_file_pending_update(asUser, {
						...prepareArgs,
						...(await reviewed_pending_for_test(t, prepareArgs)),
					})
				)._nay,
			).toBeUndefined();

			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(staged.replace("last", "LAST"));
			const remaining = await read_seeded_pending_row(t, seeded);
			expect(
				(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: remaining, rootKind })))
					.unstagedMarkdown,
			).toBe(unstaged.replace("last", "LAST"));
		},
	);

	test.each(["plain_text", "rich_text"] as const)(
		"keeps accepted and proposed %s text on overlap without publishing it",
		async (rootKind) => {
			const { t, seeded, asUser, original, prepareArgs } = await seed_stale_proposal({
				base: "old\n",
				staged: "accepted\n",
				unstaged: "proposed\n",
				current: "saved\n",
				rootKind,
			});
			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay).toBeUndefined();
			const prepared = result._yay?.pendingUpdate;
			if (!prepared) throw new Error("Expected the prepared proposal");
			expect(prepared._id).toBe(original._id);
			expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: prepared, rootKind }))).toEqual(
				{
					baseMarkdown: "saved\n",
					stagedMarkdown: "accepted\n",
					unstagedMarkdown: "proposed\n",
				},
			);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe("saved\n");
			const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
			expect(batches.every((batch) => batch.expiresAt === 0)).toBe(true);
		},
	);

	test.each(["plain_text", "rich_text"] as const)(
		"settles already saved %s changes without another file save",
		async (rootKind) => {
			const { t, seeded, asUser, original, prepareArgs } = await seed_stale_proposal({
				base: "old\n",
				staged: "saved\n",
				unstaged: "saved\n",
				current: "saved\n",
				rootKind,
			});
			await test_drain_billing_usage_event_outbox(t);
			const savesBefore = file_save_events().length;
			expect(
				await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs),
			).toEqual({ _yay: { pendingUpdate: null } });
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", original._id))).toBeNull();
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe("saved\n");
			await test_drain_billing_usage_event_outbox(t);
			expect(file_save_events()).toHaveLength(savesBefore);
		},
	);

	test.each(["write", "refresh", "settle"] as const)("refuses a stale %s and preserves the proposal", async (phase) => {
		const { t, seeded, original } = await seed_stale_proposal({
			base: "base\n",
			staged: "base\n",
			unstaged: "proposal\n",
			current: "saved\n",
		});
		const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }));

		if (phase === "write") {
			const result = await upsert_file_pending_update_internal_for_test({
				t,
				...seeded,
				pendingUpdateId: original._id,
				unstagedMarkdown: "new proposal\n",
			});
			expect(result._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);
		} else {
			const batch = await t.mutation(
				internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
				{
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					target: { kind: "saved", id: seeded.nodeId },
				},
			);
			if (batch._nay) throw new Error(batch._nay.message);
			const args = {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				operationBatchId: batch._yay.operationBatchId,
				pendingUpdateId: original._id,
				expectedRevision: original.revision,
			};
			const result =
				phase === "refresh"
					? await t.mutation(internal.files_pending_updates.refresh_file_pending_update_in_db, args)
					: await t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, args);
			expect(result._nay?.message).toBe(files_PENDING_UPDATE_STALE_BASE_MESSAGE);
		}

		expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
		expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }))).toEqual(bytes);
		expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe("saved\n");
		const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
		expect(batches.every((batch) => batch.expiresAt === 0)).toBe(true);
	});

	test.each(["changed text", "same text"] as const)(
		"refuses preparation if a second save publishes %s before commit",
		async (secondSave) => {
			const current = "base\n\nsaved\n";
			const { t, seeded, asUser, original, currentAssetId, prepareArgs } = await seed_stale_proposal({
				base: "base\n\nlast\n",
				staged: "BASE\n\nlast\n",
				unstaged: "BASE\n\nlast\n",
				current,
			});
			if (!original.content) throw new Error("Expected content branches");
			const family = await seal_output_family_for_test(t, seeded);
			const nextText = secondSave === "same text" ? current : "base\n\nnewer save\n";
			await save_as_member({ t, seeded, text: nextText });

			const result = await asUser.mutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				pendingUpdateId: prepareArgs.pendingUpdateId,
				operationBatchId: family.operationBatchId,
				expectedRevision: original.revision,
				base: { kind: "asset", expectedAssetId: currentAssetId },
				preparation: {
					sourceBaseStateId: original.content.baseStateId,
					sourceStagedStateId: original.content.stagedStateId,
					sourceUnstagedStateId: original.content.unstagedStateId,
					rootKind: "plain_text",
					hasChanges: true,
				},
				baseStateId: family.base.stateId,
				stagedStateId: family.staged.stateId,
				unstagedStateId: family.unstaged.stateId,
				baseStateDigest: family.base.digest,
				stagedStateDigest: family.staged.digest,
				unstagedStateDigest: family.unstaged.digest,
				unstagedText: "BASE\n\nsaved\n",
			});

			expect(result._nay?.message).toBe(
				"Pending update base is stale and must be rebuilt from the latest live file state",
			);
			expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(nextText);

			// This test calls the final mutation directly. Its owning action retires refused output.
			await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
				operationBatchId: family.operationBatchId,
			});
		},
	);

	test.each(["staged", "unstaged"] as const)(
		"keeps a stale proposal when merged %s text exceeds the limit",
		async (branch) => {
			const base = "first\nlast\n";
			const proposed = `${"a".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\n${base}`;
			const current = `${base}${"z".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\n`;
			const { t, seeded, asUser, original, prepareArgs } = await seed_stale_proposal({
				base,
				staged: branch === "staged" ? proposed : base,
				unstaged: proposed,
				current,
			});
			const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }));
			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay?.message).toBe(`Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit`);
			expect(await read_seeded_pending_row(t, seeded)).toEqual(original);
			expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: original }))).toEqual(bytes);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(current);
			const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
			expect(batches.every((batch) => batch.expiresAt === 0)).toBe(true);
		},
	);
});

describe("prepare_file_pending_update_for_review", () => {
	async function seed_marked_proposal(args: {
		base: string;
		staged: string;
		unstaged: string;
		current?: string;
		rootKind?: "plain_text" | "rich_text";
		target?: "yjs" | "asset";
		ordinaryMember?: boolean;
	}) {
		const t = test_convex();
		const rootKind = args.rootKind ?? "plain_text";
		const path = rootKind === "rich_text" ? "/prepare.md" : "/prepare.txt";
		const file = await t.run((ctx) => seed_non_collaborative_file({ ctx, path, text: args.base }));
		const member = args.ordinaryMember
			? await t.run(async (ctx) => {
					const userId = await ctx.db.insert("users", { clerkUserId: "clerk_preparation_member" });
					await seed_billing_snapshot_for_user(ctx, userId);
					const membershipId = await ctx.db.insert("organizations_workspaces_users", {
						organizationId: file.organizationId,
						workspaceId: file.workspaceId,
						userId,
						active: true,
						pendingOrganizationRemoval: false,
						updatedAt: Date.now(),
					});
					await access_control_db_ensure_role_assignment(ctx, {
						organizationId: file.organizationId,
						workspaceId: file.workspaceId,
						userId,
						role: "member",
						now: Date.now(),
					});
					return { userId, membershipId };
				})
			: null;
		const seeded = member ? { ...file, ...member } : file;
		r2Objects.set(`content-snapshot${path}`, args.base);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		expect(
			(
				await upsert_file_pending_update_public_for_test(asUser, {
					...seeded,
					stagedMarkdown: args.staged,
					unstagedMarkdown: args.unstaged,
				})
			)._nay,
		).toBeUndefined();
		const original = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		if (!original) throw new Error("Expected the original proposal");
		if (args.current !== undefined) await save_as_member({ t, seeded, text: args.current });
		expect(
			(
				await asUser.action(api.files_nodes_content.set_file_collaborative, {
					membershipId: seeded.membershipId,
					nodeId: seeded.nodeId,
				})
			)._nay,
		).toBeUndefined();
		if (args.target === "asset") {
			expect(
				(
					await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						acknowledgeDropCollaborativeHistory: true,
					})
				)._nay,
			).toBeUndefined();
		}
		const marked = await t.run((ctx) => ctx.db.get("files_pending_updates", original._id));
		if (!marked) throw new Error("Expected the proposal after the toggle");
		expect(marked.contentNeedsRebase).toBe(true);
		const prepareArgs = {
			membershipId: seeded.membershipId,
			target: { kind: "saved" as const, id: seeded.nodeId },
			pendingUpdateId: original._id,
		};
		return { t, seeded, asUser, original, marked, prepareArgs, rootKind, ownerUserId: file.userId };
	}

	test.each(["staged", "unstaged"] as const)("keeps the proposal when merged %s text exceeds a cap", async (branch) => {
		const fields = (prefix: string) =>
			Array.from(
				{ length: Math.floor(files_metadata_MAX_FRONTMATTER_FIELDS / 2) },
				(_, index) => `${prefix}${index}: value\n`,
			).join("");
		const markdownBase = "---\nfirst: base\nmiddle: base\nlast: base\n---\n\nbody\n";

		for (const fixture of [
			{
				rootKind: "plain_text" as const,
				base: "first\nlast\n",
				proposed: `${"a".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\nfirst\nlast\n`,
				current: `first\nlast\n${"z".repeat(files_MAX_TEXT_CONTENT_BYTES / 2)}\n`,
				message: `Text content exceeds ${files_MAX_TEXT_CONTENT_BYTES}-byte limit`,
			},
			{
				rootKind: "rich_text" as const,
				base: markdownBase,
				proposed: markdownBase.replace("first: base\n", `first: base\n${fields("proposed")}`),
				current: markdownBase.replace("last: base\n", `last: base\n${fields("current")}`),
				message: "Too many frontmatter fields",
			},
		]) {
			const { t, seeded, asUser, marked, prepareArgs } = await seed_marked_proposal({
				...fixture,
				staged: branch === "staged" ? fixture.proposed : fixture.base,
				unstaged: fixture.proposed,
				target: "asset",
			});
			const bytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: marked }));
			await test_drain_billing_usage_event_outbox(t);
			const eventsBefore = file_save_events().length;

			const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
			expect(result._nay?.message).toBe(fixture.message);

			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(marked);
			expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: marked }))).toEqual(bytes);
			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(fixture.current);
			await test_drain_billing_usage_event_outbox(t);
			expect(file_save_events()).toHaveLength(eventsBefore);
			const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
			expect(batches).toHaveLength(1);
			expect(batches[0]?.expiresAt).toBe(0);
		}
	});

	test.each(["plain_text", "rich_text"] as const)(
		"keeps exact %s text across partial save, live edit, and second save",
		async (rootKind) => {
			const base = "title\n\nfirst\n\nsecond\n\nlast\n";
			const staged = base.replace("first", "FIRST");
			const unstaged = staged.replace("second", "SECOND");
			const { t, seeded, asUser, prepareArgs } = await seed_marked_proposal({ base, staged, unstaged, rootKind });

			const prepared = await asUser.action(
				api.files_pending_updates.prepare_file_pending_update_for_review,
				prepareArgs,
			);
			expect(prepared._nay).toBeUndefined();
			const pendingUpdate = prepared._yay?.pendingUpdate;
			if (!pendingUpdate) throw new Error("Expected the prepared proposal");
			expect(pendingUpdate.content?.base).toMatchObject({ kind: "yjs", sequence: 0 });
			expect(pendingUpdate.contentNeedsRebase).toBeUndefined();
			expect(await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate, rootKind }))).toEqual({
				baseMarkdown: base,
				stagedMarkdown: staged,
				unstagedMarkdown: unstaged,
			});

			expect(
				(
					await test_save_file_pending_update(asUser, {
						...prepareArgs,
						...(await reviewed_pending_for_test(t, prepareArgs)),
					})
				)._nay,
			).toBeUndefined();
			expect(await t.run((ctx) => read_file_markdown_from_yjs({ ctx, ...seeded, rootKind }))).toBe(staged);

			const live = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
			const beforeDoc = files_yjs_doc_create_from_array_buffer_update(live.yjsUpdate);
			const editedDoc = files_yjs_doc_clone({ yjsDoc: beforeDoc });
			expect(
				files_yjs_doc_update_from_text({ mut_yjsDoc: editedDoc, text: staged.replace("last", "LAST"), rootKind })._nay,
			).toBeUndefined();
			const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: editedDoc, yjsBeforeDoc: beforeDoc });
			if (!update) throw new Error("Expected the live edit update");
			expect(
				(
					await asUser.mutation(api.files_nodes.yjs_push_update, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
						update: files_u8_to_array_buffer(update),
						sessionId: "preparation-intervening-edit",
					})
				)._nay,
			).toBeUndefined();
			beforeDoc.destroy();
			editedDoc.destroy();

			const remaining = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
			if (!remaining) throw new Error("Expected the unaccepted second change");
			expect(
				(
					await upsert_file_pending_update_public_for_test(asUser, {
						...prepareArgs,
						nodeId: prepareArgs.target.id,
						reviewedRevision: remaining.revision,
						stagedMarkdown: unstaged,
						unstagedMarkdown: unstaged,
					})
				)._nay,
			).toBeUndefined();

			expect(
				(
					await test_save_file_pending_update(asUser, {
						...prepareArgs,
						...(await reviewed_pending_for_test(t, prepareArgs)),
					})
				)._nay,
			).toBeUndefined();

			expect(await t.run((ctx) => read_file_markdown_from_yjs({ ctx, ...seeded, rootKind }))).toBe(
				unstaged.replace("last", "LAST"),
			);
			expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();
		},
	);

	test.each([
		{
			name: "disjoint edits",
			base: "a\nb\nc\n",
			staged: "A\nb\nc\n",
			unstaged: "A\nb\nC\n",
			current: "a\nB\nc\n",
			mergedStaged: "A\nB\nc\n",
			mergedUnstaged: "A\nB\nC\n",
		},
		{
			name: "identical overlaps",
			base: "a\nb\n",
			staged: "A\nb\n",
			unstaged: "A\nB\n",
			current: "A\nb\n",
			mergedStaged: "A\nb\n",
			mergedUnstaged: "A\nB\n",
		},
		{
			name: "overlapping Unicode lines with the accepted line kept",
			base: "😀 old\nlast\n",
			staged: "😃 old\nlast\n",
			unstaged: "😃 old\nlast!\n",
			current: "😀 new\nlast\n",
			mergedStaged: "😃 old\nlast\n",
			mergedUnstaged: "😃 old\nlast!\n",
		},
	])("merges $name without publishing text", async (fixture) => {
		const { t, asUser, seeded, prepareArgs } = await seed_marked_proposal({ ...fixture, target: "asset" });
		await test_drain_billing_usage_event_outbox(t);
		const eventsBefore = file_save_events().length;

		const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(result._nay).toBeUndefined();
		const pendingUpdate = result._yay?.pendingUpdate;
		if (!pendingUpdate) throw new Error("Expected the merged proposal");

		expect(
			await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate, rootKind: "plain_text" })),
		).toEqual({
			baseMarkdown: fixture.current,
			stagedMarkdown: fixture.mergedStaged,
			unstagedMarkdown: fixture.mergedUnstaged,
		});
		expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(fixture.current);
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(eventsBefore);
	});

	test.each([
		{ base: "old\n", staged: "proposal\n", unstaged: "proposal\n", current: "other\n" },
		{ base: "start end\n", staged: "start Aend\n", unstaged: "start Aend\n", current: "start Bend\n" },
	])("keeps the proposed line on an overlap ($base)", async (fixture) => {
		const { t, seeded, asUser, prepareArgs } = await seed_marked_proposal({ ...fixture, target: "asset" });
		await test_drain_billing_usage_event_outbox(t);
		const eventsBefore = file_save_events().length;
		const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(result._nay).toBeUndefined();
		const pendingUpdate = result._yay?.pendingUpdate;
		if (!pendingUpdate) throw new Error("Expected the prepared proposal");
		expect(
			await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate, rootKind: "plain_text" })),
		).toEqual({
			baseMarkdown: fixture.current,
			stagedMarkdown: fixture.staged,
			unstagedMarkdown: fixture.unstaged,
		});
		expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(fixture.current);
		const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
		expect(batches).toHaveLength(0);
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(eventsBefore);
	});

	test("settles an identical proposal without a file save", async () => {
		const { t, asUser, prepareArgs } = await seed_marked_proposal({
			base: "old\n",
			staged: "new\n",
			unstaged: "new\n",
			current: "new\n",
		});
		await test_drain_billing_usage_event_outbox(t);
		const eventsBefore = file_save_events().length;
		const result = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(result).toEqual({ _yay: { pendingUpdate: null } });
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", prepareArgs.pendingUpdateId))).toBeNull();
		await test_drain_billing_usage_event_outbox(t);
		expect(file_save_events()).toHaveLength(eventsBefore);
	});

	test("refuses direct writes before preparation and from an old pane after preparation", async () => {
		const { t, asUser, marked, prepareArgs } = await seed_marked_proposal({
			base: "base\n",
			staged: "base\n",
			unstaged: "proposed\n",
		});
		const oldWrite = {
			...prepareArgs,
			nodeId: prepareArgs.target.id,
			reviewedRevision: marked.revision,
			stagedMarkdown: "proposed\n",
			unstagedMarkdown: "proposed\n",
		};
		expect((await upsert_file_pending_update_public_for_test(asUser, oldWrite))._nay?.message).toContain(
			"Update the proposal",
		);
		expect(
			(
				await test_save_file_pending_update(asUser, {
					...prepareArgs,
					...(await reviewed_pending_for_test(t, prepareArgs)),
				})
			)._nay?.message,
		).toContain("Update the proposal");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(marked);
		const prepared = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		expect(prepared._nay).toBeUndefined();
		expect((await upsert_file_pending_update_public_for_test(asUser, oldWrite))._nay).toBeDefined();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(prepared._yay?.pendingUpdate);
	});

	test.each([
		"live edit",
		"no-change live edit",
		"mode cycle",
		"discard",
		"replacement proposal",
		"lock",
		"membership loss",
		"write access loss",
	] as const)("refuses a %s while preparation is in flight", async (race) => {
		const noChange = race === "no-change live edit";
		const { t, asUser, seeded, marked, prepareArgs, ownerUserId } = await seed_marked_proposal({
			base: "base\n",
			staged: "proposal\n",
			unstaged: "proposal\n",
			current: noChange ? "proposal\n" : undefined,
			ordinaryMember: race === "write access loss",
		});

		const normalFetch = globalThis.fetch;
		let release: (() => void) | undefined;
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		let announce: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announce?.();
					await paused;
				}
				return await normalFetch(input, init);
			}),
		);

		const preparing = asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, prepareArgs);
		await started;

		let replacementId: Id<"files_pending_updates"> | undefined;
		try {
			if (race === "mode cycle") {
				const beforePointers = await test_get_file_yjs_pointers(t, seeded.nodeId);
				expect(
					(
						await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
							acknowledgeDropCollaborativeHistory: true,
						})
					)._nay,
				).toBeUndefined();
				expect(
					(
						await asUser.action(api.files_nodes_content.set_file_collaborative, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
						})
					)._nay,
				).toBeUndefined();
				expect((await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId).not.toBe(
					beforePointers.yjsLastSequenceId,
				);
			} else if (race === "discard" || race === "replacement proposal") {
				expect(
					(
						await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
							...prepareArgs,
							...(await reviewed_pending_for_test(t, prepareArgs)),
						})
					)._nay,
				).toBeUndefined();
				if (race === "replacement proposal") {
					// A stalled preparation can lose its batch to the existing idle takeover.
					vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 1000 + 1);
					expect(
						(
							await upsert_file_pending_update_public_for_test(asUser, {
								membershipId: seeded.membershipId,
								nodeId: seeded.nodeId,
								unstagedMarkdown: "replacement\n",
							})
						)._nay,
					).toBeUndefined();
					replacementId = (await t.run((ctx) => read_pending_update_row({ ctx, ...seeded })))?._id;
					expect(replacementId).not.toBe(marked._id);
				}
			} else if (race === "lock") {
				await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
			} else if (race === "membership loss") {
				await t.run((ctx) => ctx.db.delete("organizations_workspaces_users", seeded.membershipId));
			} else if (race === "write access loss") {
				const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: ownerUserId, name: "Owner" });
				expect(
					(
						await asOwner.mutation(api.access_control.set_user_role, {
							organizationId: seeded.organizationId,
							workspaceId: seeded.workspaceId,
							userId: seeded.userId,
							role: "viewer",
						})
					)._nay,
				).toBeUndefined();
			} else {
				const state = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
				const before = files_yjs_doc_create_from_array_buffer_update(state.yjsUpdate);
				const after = files_yjs_doc_clone({ yjsDoc: before });
				expect(
					files_yjs_doc_update_from_text({ mut_yjsDoc: after, rootKind: "plain_text", text: "newer live text\n" })._nay,
				).toBeUndefined();
				const update = files_yjs_compute_diff_update_from_yjs_doc({ yjsDoc: after, yjsBeforeDoc: before });
				if (!update) throw new Error("Expected the intervening live edit");
				expect(
					(
						await asUser.mutation(api.files_nodes.yjs_push_update, {
							membershipId: seeded.membershipId,
							nodeId: seeded.nodeId,
							expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
							update: files_u8_to_array_buffer(update),
							sessionId: "preparation-race",
						})
					)._nay,
				).toBeUndefined();
				before.destroy();
				after.destroy();
			}
		} finally {
			release?.();
		}

		const result = await preparing;
		expect(result._nay).toBeDefined();
		if (race === "lock") expect(result._nay?.name).toBe("read_only");
		if (race === "membership loss") expect(result._nay?.message).toBe("Unauthorized");
		if (race === "write access loss") expect(result._nay?.message).toBe("Permission denied");
		if (race === "discard" || race === "replacement proposal") {
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toBeNull();
			if (replacementId)
				expect(
					(await t.run((ctx) => ctx.db.get("files_pending_updates", replacementId)))?.contentNeedsRebase,
				).toBeUndefined();
		} else expect(await t.run((ctx) => ctx.db.get("files_pending_updates", marked._id))).toEqual(marked);

		const batches = await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect());
		expect(batches).toHaveLength(1);
		expect(batches[0]?.expiresAt).toBe(0);
	});

	test.each(["plain_text", "rich_text"] as const)(
		"keeps and prepares a %s proposal after turning collaboration off",
		async (rootKind) => {
			const t = test_convex();
			const seeded = await t.run(async (ctx) => {
				const file = await seed_signed_in_file_with_markdown({
					ctx,
					path: "/prepare-off",
					name: "prepare-off",
					markdown: "base\n",
					rootKind,
				});
				await seed_committed_chunks_for_file({ ctx, ...file, path: "/prepare-off", markdown: file.baseMarkdown });
				return file;
			});
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });

			const proposed = "base\n\nproposed\n";
			expect(
				(
					await upsert_file_pending_update_public_for_test(asUser, {
						...seeded,
						stagedMarkdown: proposed,
						unstagedMarkdown: proposed,
					})
				)._nay,
			).toBeUndefined();

			const before = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
			if (!before) throw new Error("Expected the proposal before turning collaboration off");
			const beforeBytes = await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: before }));

			expect(
				(
					await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
						membershipId: seeded.membershipId,
						nodeId: seeded.nodeId,
						acknowledgeDropCollaborativeHistory: true,
					})
				)._nay,
			).toBeUndefined();
			const marked = await t.run((ctx) => ctx.db.get("files_pending_updates", before._id));
			expect(marked).toMatchObject({ ...before, revision: before.revision + 1, contentNeedsRebase: true });
			if (!marked) throw new Error("Expected the proposal to survive the toggle");
			expect(await t.run((ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: marked }))).toEqual(beforeBytes);

			const prepared = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: before._id,
			});
			expect(prepared._nay).toBeUndefined();
			expect(prepared._yay?.pendingUpdate).toMatchObject({ _id: before._id });
			expect(prepared._yay?.pendingUpdate?.contentNeedsRebase).toBeUndefined();
			expect(prepared._yay?.pendingUpdate?.content?.base).toEqual({ kind: "asset", assetId: expect.any(String) });

			expect(
				(
					await test_save_file_pending_update(asUser, {
						membershipId: seeded.membershipId,
						target: { kind: "saved", id: seeded.nodeId },
						...(await reviewed_pending_for_test(t, {
							membershipId: seeded.membershipId,
							target: { kind: "saved", id: seeded.nodeId },
							pendingUpdateId: before._id,
						})),
						pendingUpdateId: before._id,
					})
				)._nay,
			).toBeUndefined();

			expect(await t.run((ctx) => read_committed_text({ ctx, ...seeded }))).toBe(proposed);
			expect(await t.run((ctx) => ctx.db.get("files_pending_updates", before._id))).toBeNull();
		},
	);
});

describe("persist_file_pending_update_rebased_state", () => {
	test("persist_file_pending_update_rebased_state stores the rebased doc as the new authoritative pending state", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-rebased",
				name: "pending-edits-persist-rebased",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const remoteMarkdown = `${seeded.baseMarkdown}\n\nRemote drift`;
		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: remoteMarkdown,
			}),
		);

		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);

		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${remoteMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to create unstaged rebased branch while testing pending update persistence");
		}

		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}
		if (!persistResult._yay || !("pendingUpdate" in persistResult._yay)) {
			throw new Error("Pending update rebase persistence did not return a pending update row");
		}
		expect(persistResult._yay.pendingUpdate).not.toBeNull();
		expect(persistResult._yay.pendingUpdate!.content?.base).toMatchObject({ kind: "yjs", sequence: 1 });

		const pendingAfterPersist = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterPersist).not.toBeNull();

		const pendingAfterPersistMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: pendingAfterPersist! }),
		);
		expect(pendingAfterPersistMarkdownState.baseMarkdown).toContain("Remote drift");
		expect(pendingAfterPersistMarkdownState.stagedMarkdown).toBe(pendingAfterPersistMarkdownState.baseMarkdown);
		expect(pendingAfterPersistMarkdownState.unstagedMarkdown).toContain("Remote drift");
		expect(pendingAfterPersistMarkdownState.unstagedMarkdown).toContain("Unresolved only");
	});

	test("persist_file_pending_update_rebased_state rejects a mismatched pendingUpdateId from another file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) => {
			const fileA = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-mismatch-a",
				name: "pending-edits-persist-mismatch-a",
				markdown: "# File A",
			});
			const fileB = await seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-mismatch-b",
				name: "pending-edits-persist-mismatch-b",
				markdown: "# File B",
				membership: fileA,
			});

			return {
				membershipId: fileA.membershipId,
				organizationId: fileA.organizationId,
				workspaceId: fileA.workspaceId,
				userId: fileA.userId,
				fileAId: fileA.nodeId,
				fileABaseMarkdown: fileA.baseMarkdown,
				fileBId: fileB.nodeId,
				fileBBaseMarkdown: fileB.baseMarkdown,
			};
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.fileAId,
			stagedMarkdown: seeded.fileABaseMarkdown,
			unstagedMarkdown: `${seeded.fileABaseMarkdown}\n\nFile A current`,
		});
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.fileBId,
			stagedMarkdown: seeded.fileBBaseMarkdown,
			unstagedMarkdown: `${seeded.fileBBaseMarkdown}\n\nFile B current`,
		});

		const [fileAPendingRow, fileBPendingRow] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileAId),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileBId),
					)
					.first(),
			]),
		);
		if (!fileAPendingRow || !fileBPendingRow) {
			throw new Error("Missing pending docs while testing mismatched rebase pendingUpdateId");
		}

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.fileAId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.fileABaseMarkdown}\n\nFile A rebased`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build rebased branch while testing mismatched pendingUpdateId");
		}

		// The synced id must match the row the mutation resolves: a foreign id means the
		// client's view is stale, so the persist refuses instead of patching either row.
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.fileAId,
			pendingUpdateId: fileBPendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

		const [fileAPendingRowAfterPersist, fileBPendingRowAfterPersist] = await t.run(async (ctx) =>
			Promise.all([
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileAId),
					)
					.first(),
				ctx.db
					.query("files_pending_updates")
					.withIndex("by_organization_workspace_user_target", (q) =>
						q
							.eq("organizationId", seeded.organizationId)
							.eq("workspaceId", seeded.workspaceId)
							.eq("userId", seeded.userId)
							.eq("target.kind", "saved")
							.eq("target.id", seeded.fileBId),
					)
					.first(),
			]),
		);
		expect(fileAPendingRowAfterPersist).not.toBeNull();
		expect(fileAPendingRowAfterPersist!._id).toBe(fileAPendingRow._id);
		expect(fileBPendingRowAfterPersist).not.toBeNull();

		const fileAPendingRowAfterPersistMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: fileAPendingRowAfterPersist! }),
		);
		expect(fileAPendingRowAfterPersistMarkdownState.unstagedMarkdown).toContain("File A current");

		const fileBPendingRowAfterPersistMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: fileBPendingRowAfterPersist! }),
		);
		expect(fileBPendingRowAfterPersistMarkdownState.unstagedMarkdown).toContain("File B current");
	});

	test("persist_file_pending_update_rebased_state clears the pending doc when the rebased branches match the live base", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-clear",
				name: "pending-edits-persist-clear",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		const clearResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: latestFileState.yjsUpdate,
		});
		if (clearResult._nay) {
			throw new Error(clearResult._nay.message);
		}
		if (!clearResult._yay || !("pendingUpdate" in clearResult._yay)) {
			throw new Error("Pending update rebase persistence did not return a pending update result");
		}
		expect(clearResult._yay.pendingUpdate).toBeNull();

		const pendingAfterClear = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterClear).toBeNull();
	});

	test("persist_file_pending_update_rebased_state rejects stale live bases", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-stale",
				name: "pending-edits-persist-stale",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const staleFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: seeded.nodeId,
				markdown: `${seeded.baseMarkdown}\n\nRemote drift`,
			}),
		);

		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const stalePersistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: staleFileState.yjsSequence,
			baseYjsUpdate: staleFileState.yjsUpdate,
			stagedBranchYjsUpdate: staleFileState.yjsUpdate,
			unstagedBranchYjsUpdate: staleFileState.yjsUpdate,
		});
		expect(stalePersistResult._nay?.message).toBe(
			"Pending update base is stale and must be rebuilt from the latest live file state",
		);
	});

	test("persist_file_pending_update_rebased_state does not recreate a discarded row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-discarded",
				name: "pending-edits-persist-discarded",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row before the in-flight sync");
		}

		// Another tab discards the proposal while this tab's sync is in flight.
		await t.run(async (ctx) => {
			const [textChunks, plainTextChunks] = await Promise.all([
				list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: pendingRow._id }),
			]);
			await Promise.all([
				...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", pendingRow._id),
			]);
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build stale sync branch while testing the discarded row");
		}

		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The discarded proposal must stay dead: no row and no pending chunks reappear.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
			const textChunks = await ctx.db
				.query("files_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(textChunks.filter((chunk) => chunk.sourceKind === "pending")).toHaveLength(0);
		});
	});

	test("persist_file_pending_update_rebased_state does not patch a newer proposal on the same file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-replaced",
				name: "pending-edits-persist-replaced",
				markdown: "# Sync base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing first pending row before the in-flight sync");
		}

		// Another tab discards the first proposal, then the agent creates a NEW proposal on
		// the same file while this tab's sync is still in flight.
		await t.run(async (ctx) => {
			const [textChunks, plainTextChunks] = await Promise.all([
				list_pending_update_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
				list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: firstRow._id }),
			]);
			await Promise.all([
				...textChunks.map((chunk) => ctx.db.delete("files_text_chunks", chunk._id)),
				...plainTextChunks.map((chunk) => ctx.db.delete("files_plain_text_chunks", chunk._id)),
				ctx.db.delete("files_pending_updates", firstRow._id),
			]);
		});
		const secondUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent proposal two`,
		});
		if (secondUpserted._nay) {
			throw new Error(secondUpserted._nay.message);
		}
		const secondRowBefore = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondRowBefore || !files_pending_update_has_yjs_content(secondRowBefore)) {
			throw new Error("Missing second pending row before the stale sync lands");
		}
		const secondRowUnstagedBytes = (
			await t.run(async (ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: secondRowBefore }))
		).unstagedBytes;

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build stale sync branch while testing the replaced row");
		}

		// The stale sync still carries the FIRST row's id and branches.
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: firstRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		expect(persistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The new proposal must be untouched: same row id, same unstaged branch bytes.
			const secondRowAfter = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!secondRowAfter || !files_pending_update_has_yjs_content(secondRowAfter)) {
				throw new Error("Missing second pending row after the stale sync");
			}
			expect(secondRowAfter._id).toBe(secondRowBefore._id);
			const secondRowAfterBytes = await read_pending_row_state_bytes({ ctx, pendingUpdate: secondRowAfter });
			expect(new Uint8Array(secondRowAfterBytes.unstagedBytes)).toEqual(new Uint8Array(secondRowUnstagedBytes));
		});
	});

	test("commit_file_pending_update_rebase_in_db rejects a stale base after a save advanced the row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-stale-base",
				name: "pending-edits-persist-stale-base",
				markdown: "# Persist stale base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const stagedMarkdown = `${seeded.baseMarkdown}\n\nAccepted chunk`;
		const unstagedMarkdown = `${stagedMarkdown}\n\nUnresolved chunk`;
		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row before the in-flight sync");
		}

		// Tab A's sync action reads this live base before tab B's save lands.
		const originalFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);

		// Tab B's partial save rebases the row to the new sequence with fresh unresolved content.
		const saveResult = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saveResult._nay) {
			throw new Error(saveResult._nay.message);
		}
		if (!saveResult._yay) {
			throw new Error("Missing save result _yay while testing the stale persist base");
		}
		expect(saveResult._yay.newSequence).toBe(1);

		const rowAfterSave = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!rowAfterSave || !files_pending_update_has_yjs_content(rowAfterSave)) {
			throw new Error("Missing rebased pending row after the save");
		}
		expect(rowAfterSave.content.base).toMatchObject({ kind: "yjs", sequence: 1 });
		const rowAfterSaveBytes = await t.run(async (ctx) =>
			read_pending_row_state_bytes({ ctx, pendingUpdate: rowAfterSave }),
		);

		// Tab A's delayed commit still carries branches rebased onto the OLD captured base.
		const staleBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(originalFileState.yjsUpdate);
		const staleUnstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: staleBaseYjsDoc,
		});
		const staleUnstagedProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: staleUnstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nStale sync content`,
		});
		if (staleUnstagedProjection._nay) {
			throw new Error("Failed to build the stale sync branch while testing the stale persist base");
		}

		const staleFamily = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: originalFileState.yjsUpdate,
			stagedBranchYjsUpdate: originalFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(staleUnstagedBranchYjsDoc)),
		});
		const stalePersistResult = await asUser.mutation(
			internal.files_pending_updates.commit_file_pending_update_rebase_in_db,
			{
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				pendingUpdateId: pendingRow._id,
				operationBatchId: staleFamily.operationBatchId,
				expectedRevision: rowAfterSave.revision,
				base: {
					kind: "yjs",
					baseYjsSequence: originalFileState.yjsSequence,
					baseLineageGeneration: 0,
					expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
				},
				baseStateId: staleFamily.base.stateId,
				stagedStateId: staleFamily.staged.stateId,
				unstagedStateId: staleFamily.unstaged.stateId,
				baseStateDigest: staleFamily.base.digest,
				stagedStateDigest: staleFamily.staged.digest,
				unstagedStateDigest: staleFamily.unstaged.digest,
				unstagedText: `${seeded.baseMarkdown}\n\nStale sync content`,
			},
		);
		expect(stalePersistResult._nay?.message).toBe("Stale save");

		await t.run(async (ctx) => {
			// The post-save row must be untouched: same base sequence and branch bytes.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row || !files_pending_update_has_yjs_content(row)) {
				throw new Error("Missing pending row after the stale persist");
			}
			expect(row.content.base).toMatchObject({ kind: "yjs", sequence: 1 });
			const rowBytes = await read_pending_row_state_bytes({ ctx, pendingUpdate: row });
			expect(new Uint8Array(rowBytes.baseBytes)).toEqual(new Uint8Array(rowAfterSaveBytes.baseBytes));
			expect(new Uint8Array(rowBytes.stagedBytes)).toEqual(new Uint8Array(rowAfterSaveBytes.stagedBytes));
			expect(new Uint8Array(rowBytes.unstagedBytes)).toEqual(new Uint8Array(rowAfterSaveBytes.unstagedBytes));
		});
	});

	test("commit_file_pending_update_rebase_in_db does not resurrect content on a row degraded to a pure move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-degraded.md",
				name: "pending-edits-persist-degraded.md",
				markdown: "# Persist degraded base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nMixed content`,
		});
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-edits-persist-degraded-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const mixedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!mixedRow || !files_pending_update_has_yjs_content(mixedRow)) {
			throw new Error("Missing mixed pending row before the revert");
		}
		const capturedBaseYjsSequence = mixedRow.content.base.sequence;
		const capturedBytes = await t.run(async (ctx) => read_pending_row_state_bytes({ ctx, pendingUpdate: mixedRow }));

		// Another tab reverts the content: the row degrades to a pure move with no yjs fields.
		const reverted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (reverted._nay) {
			throw new Error(reverted._nay.message);
		}
		const degradedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(degradedRow?._id).toBe(mixedRow._id);
		expect(degradedRow?.content).toBeUndefined();

		// The in-flight sync still carries the reverted content branches with the old captured base.
		const staleFamily = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: capturedBytes.baseBytes,
			stagedBranchYjsUpdate: capturedBytes.stagedBytes,
			unstagedBranchYjsUpdate: capturedBytes.unstagedBytes,
		});
		const stalePersistResult = await asUser.mutation(
			internal.files_pending_updates.commit_file_pending_update_rebase_in_db,
			{
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				pendingUpdateId: mixedRow._id,
				operationBatchId: staleFamily.operationBatchId,
				expectedRevision: mixedRow.revision,
				base: {
					kind: "yjs",
					baseYjsSequence: capturedBaseYjsSequence,
					baseLineageGeneration: 0,
					expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
				},
				baseStateId: staleFamily.base.stateId,
				stagedStateId: staleFamily.staged.stateId,
				unstagedStateId: staleFamily.unstaged.stateId,
				baseStateDigest: staleFamily.base.digest,
				stagedStateDigest: staleFamily.staged.digest,
				unstagedStateDigest: staleFamily.unstaged.digest,
				unstagedText: `${seeded.baseMarkdown}\n\nMixed content`,
			},
		);
		expect(stalePersistResult._nay?.message).toBe("Not found");

		await t.run(async (ctx) => {
			// The pure-move row must stay content-free: resurrecting the branches would revive
			// a proposal the user already reverted.
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?._id).toBe(mixedRow._id);
			expect(row?.pendingMove?.destName).toBe("pending-edits-persist-degraded-dest.md");
			expect(row?.content).toBeUndefined();
		});
	});

	test("an identical persist refreshes the pending update lifetime", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-identical-ttl",
				name: "pending-edits-persist-identical-ttl",
				markdown: "# Persist identical TTL base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${seeded.baseMarkdown}\n\nUnresolved only`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build the unstaged branch while testing identical persist TTL refresh");
		}
		const persistArgs = {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		};

		const firstPersistResult = await persist_file_pending_update_rebased_state_for_test(asUser, persistArgs);
		if (firstPersistResult._nay) {
			throw new Error(firstPersistResult._nay.message);
		}
		const firstRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!firstRow) {
			throw new Error("Missing pending row after the first persist");
		}
		expect(firstRow.expiresAt).toBe(firstRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);

		await new Promise((resolve) => setTimeout(resolve, 2));

		// A retried sync persists the exact same bytes: the row content does not change, but
		// the 4h lifetime must still restart or the old expiry removes the proposal.
		const secondPersistResult = await persist_file_pending_update_rebased_state_for_test(asUser, persistArgs);
		if (secondPersistResult._nay) {
			throw new Error(secondPersistResult._nay.message);
		}
		if (!secondPersistResult._yay || !("pendingUpdate" in secondPersistResult._yay)) {
			throw new Error("Pending update rebase persistence did not return a pending update row");
		}
		expect(secondPersistResult._yay.pendingUpdate).not.toBeNull();

		const secondRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!secondRow) {
			throw new Error("Missing pending row after the identical persist");
		}
		expect(secondRow._id).toBe(firstRow._id);
		expect(secondRow.updatedAt).toBeGreaterThan(firstRow.updatedAt);

		expect(secondRow.expiresAt).toBe(secondRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(secondRow.expiresAt).toBeGreaterThan(firstRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
	});

	test("persist_file_pending_update_rebased_state returns a message-only nay when branch comparison fails", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-edits-persist-poisoned-branch",
				name: "pending-edits-persist-poisoned-branch",
				markdown: "# Persist poisoned branch",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upserted = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nPending chunk`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow || !files_pending_update_has_yjs_content(pendingRow)) {
			throw new Error("Missing pending row content before the failing persist");
		}
		const pendingRowBytes = await t.run(async (ctx) =>
			read_pending_row_state_bytes({ ctx, pendingUpdate: pendingRow }),
		);

		// Stage and seal valid inputs first: the seal reads markdown too, and the mock below must
		// fail the ACTION's first comparison read instead.
		const family = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: pendingRowBytes.baseBytes,
			stagedBranchYjsUpdate: pendingRowBytes.stagedBytes,
			unstagedBranchYjsUpdate: pendingRowBytes.unstagedBytes,
		});

		// Fail the action's first markdown read with the real producer's cause-carrying shape.
		filesYjsDocGetMarkdownMock.mockReturnValueOnce({
			_nay: {
				name: "nay",
				message: "Error while extracting markdown from Y.Doc",
				cause: new Error("serializer exploded"),
			},
		});

		const persisted = await asUser.action(api.ai_chat.persist_file_pending_update_rebased_state, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			operationBatchId: family.operationBatchId,
			baseYjsSequence: pendingRow.content.base.sequence,
		});

		// The `_nay` must stay message-only: an extra `cause` field would fail the action's
		// strict `v_result` returns validator in a real deployment.
		expect(persisted).toEqual({
			_nay: { message: "Failed to compare rebased pending update branches with base" },
		});
	});
});

describe("expire_file_pending_updates saved drafts", () => {
	test("a check at the old expiry keeps a draft that a newer edit moved later", async () => {
		vi.useFakeTimers();
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-cleanup-stale",
				name: "pending-edits-cleanup-stale",
				markdown: "# Cleanup stale base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const firstMarkdown = `${seeded.baseMarkdown}\n\nCleanup pending first`;
		const firstUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: firstMarkdown,
		});
		if (firstUpsertResult._nay) {
			throw new Error(firstUpsertResult._nay.message);
		}

		const firstPendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!firstPendingRow?.expiresAt) {
			throw new Error("Missing first pending doc while testing stale expiry");
		}

		vi.setSystemTime(Date.now() + 60_000);

		const secondMarkdown = `${seeded.baseMarkdown}\n\nCleanup pending second`;
		const secondUpsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: secondMarkdown,
			unstagedMarkdown: secondMarkdown,
		});
		if (secondUpsertResult._nay) {
			throw new Error(secondUpsertResult._nay.message);
		}

		// The check was scheduled for the first expiry. The newer edit moved the draft's expiry later,
		// so this run keeps the draft and waits for the new expiry.
		vi.setSystemTime(firstPendingRow.expiresAt);
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
		});

		const pendingAfterStaleCleanup = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterStaleCleanup?._id).toBe(firstPendingRow._id);
		expect(pendingAfterStaleCleanup?.expiresAt).toBe(pendingAfterStaleCleanup!.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		expect(pendingAfterStaleCleanup?.expiresAt).toBeGreaterThan(firstPendingRow.expiresAt);
		const check = await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }));
		expect(check?.nextCheckAt).toBe(pendingAfterStaleCleanup?.expiresAt);
	});

	test("expire_file_pending_updates deletes due saved drafts and then its check", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-cleanup-expired",
				name: "pending-edits-cleanup-expired",
				markdown: "# Cleanup expired base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const changedMarkdown = `${seeded.baseMarkdown}\n\nCleanup expired`;
		const upsertResult = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upsertResult._nay) {
			throw new Error(upsertResult._nay.message);
		}

		const pendingRow = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		if (!pendingRow) {
			throw new Error("Missing pending doc while testing expired cleanup");
		}

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		const pendingAfterCleanup = await t.run(async (ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_organization_workspace_user_target", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("target.kind", "saved")
						.eq("target.id", seeded.nodeId),
				)
				.first(),
		);
		expect(pendingAfterCleanup).toBeNull();
		expect(await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }))).toBeNull();
	});
});

describe("membership scoped pending updates", () => {
	test("pending update APIs reject cross-user membership ids", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-edits-membership-unauthorized",
				name: "pending-edits-membership-unauthorized",
				markdown: "# Base",
			}),
		);

		const otherUserId = await t.run(async (ctx) =>
			ctx.db.insert("users", {
				clerkUserId: null,
			}),
		);
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: otherUserId,
			name: "Other User",
		});

		const unauthorizedUpsert = await upsert_file_pending_update_public_for_test(asOtherUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nUnauthorized`,
		});
		if (!unauthorizedUpsert._nay) {
			throw new Error("Expected upsert_file_pending_update to reject cross-user membership");
		}
		expect(unauthorizedUpsert._nay.message).toBe("Unauthorized");

		const unauthorizedPending = await asOtherUser.query(api.ai_chat.get_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(unauthorizedPending).toBeNull();

		const unauthorizedLastSaved = await asOtherUser.query(api.ai_chat.get_file_pending_update_last_sequence_saved, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
		});
		expect(unauthorizedLastSaved).toBeNull();

		const proposalId = await t.run((ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);
		const unauthorizedSave = await test_save_file_pending_update(asOtherUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			pendingUpdateId: proposalId,
			reviewedRevision: 1,
		});
		if (!unauthorizedSave._nay) {
			throw new Error("Expected save_file_pending_update to reject cross-user membership");
		}
		expect(unauthorizedSave._nay.message).toBe("Unauthorized");

		const unauthorizedPersist = await persist_file_pending_update_rebased_state_for_test(asOtherUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: 0,
			baseYjsUpdate: new ArrayBuffer(0),
			stagedBranchYjsUpdate: new ArrayBuffer(0),
			unstagedBranchYjsUpdate: new ArrayBuffer(0),
		});
		if (!unauthorizedPersist._nay) {
			throw new Error("Expected persist_file_pending_update_rebased_state to reject cross-user membership");
		}
		expect(unauthorizedPersist._nay.message).toBe("Unauthorized");
	});
});

describe("upsert_file_pending_move_in_db", () => {
	test("creates a pure-move row and replaces the proposal on a second mv", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-upsert-src.md",
				name: "move-upsert-src.md",
				markdown: "# Move upsert base",
			}),
		);
		const destFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-upsert-dest",
				name: "move-upsert-dest",
			}),
		);

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "moved.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		expect(created._yay).toEqual({
			fromPath: "/move-upsert-src.md",
			destPath: "/move-upsert-dest/moved.md",
			replacesExistingOccupant: false,
			cancelledExistingMove: false,
			appliedImmediately: false,
		});

		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row after move upsert");
		}
		expect(pendingRow.pendingMove).toEqual({
			destParent: { kind: "saved", id: destFolderId },
			destName: "moved.md",
			fromPath: "/move-upsert-src.md",
		});
		expect(files_pending_update_has_yjs_content(pendingRow)).toBe(false);
		expect(pendingRow.size).toBe(0);

		expect(pendingRow.expiresAt).toBe(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		const expiryCheck = await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }));
		expect(expiryCheck?.nextCheckAt).toBeLessThanOrEqual(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);

		const replaced = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "renamed.md",
		});
		if (replaced._nay) {
			throw new Error(replaced._nay.message);
		}

		const replacedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(replacedRow?._id).toBe(pendingRow._id);
		expect(replacedRow?.pendingMove?.destName).toBe("renamed.md");
	});

	test("a rename may change the extension because the stored type stays", async () => {
		const t = test_convex();

		// Direct mutation calls stand in for any future caller that skips the bash command's own
		// checks: the proposal mutation itself must not judge the name against the type.
		const markdownSeeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/typed-rich.md",
				name: "typed-rich.md",
				markdown: "# Typed rich",
			}),
		);
		const renamedToJson = await upsert_file_pending_move_for_test({
			t,
			organizationId: markdownSeeded.organizationId,
			workspaceId: markdownSeeded.workspaceId,
			userId: markdownSeeded.userId,
			nodeId: markdownSeeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "typed-rich.json",
		});
		expect(renamedToJson._nay).toBeUndefined();

		// A stored file follows the same rule: the name is free, the type stays.
		const uploadNodeId = await t.run(async (ctx) =>
			ctx.db.insert("files_nodes", {
				organizationId: markdownSeeded.organizationId,
				workspaceId: markdownSeeded.workspaceId,
				path: "/typed-photo.png",
				treePath: "/typed-photo.png",
				pathDepth: 1,
				name: "typed-photo.png",
				sortName: files_sort_text_key("typed-photo.png"),
				kind: "file",
				lowercaseExtension: "png",
				contentType: "image/png",
				parentId: files_ROOT_ID,
				createdBy: markdownSeeded.userId,
				updatedBy: markdownSeeded.userId,
				updatedAt: Date.now(),
				assetId: null,
				contentByteSize: null,
				textKind: null,
				collaborationEnabled: null,
				yjsSnapshotId: null,
				yjsLastSequenceId: null,
				statsId: null,
				contentTooLargeByteSize: null,
				contentShapeMismatchAt: null,
				contentYjsStateTooLargeByteSize: null,
				contentFrontmatterTooLargeFieldCount: null,
				contentFrontmatterTooLargeIndexDocumentCount: null,
				restrictedScopeNodeId: null,
				isRestrictedScopeRoot: false,
				writePolicy: null,

				archiveOperationId: null,
				newChildWritePolicy: null,
			}),
		);
		const relabeled = await upsert_file_pending_move_for_test({
			t,
			organizationId: markdownSeeded.organizationId,
			workspaceId: markdownSeeded.workspaceId,
			userId: markdownSeeded.userId,
			nodeId: uploadNodeId,
			destParentId: files_ROOT_ID,
			destName: "typed-movie.mp4",
		});
		expect(relabeled._nay).toBeUndefined();
	});

	test("makes a mixed row when mv follows a pending content edit", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-mixed-src.md",
				name: "move-mixed-src.md",
				markdown: "# Mixed base",
			}),
		);

		const changedMarkdown = `${seeded.baseMarkdown}\n\nMixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-mixed-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const mixedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!mixedRow) {
			throw new Error("Missing mixed pending row");
		}
		expect(mixedRow.pendingMove?.destName).toBe("move-mixed-renamed.md");
		expect(files_pending_update_has_yjs_content(mixedRow)).toBe(true);
		const mixedRowMarkdownState = await t.run(async (ctx) =>
			read_pending_row_markdown_state({ ctx, pendingUpdate: mixedRow }),
		);
		expect(mixedRowMarkdownState.unstagedMarkdown).toContain("Mixed change");
		const pendingChunks = await t.run((ctx) => list_pending_update_text_chunks({ ctx, pendingUpdateId: mixedRow._id }));
		expect(pendingChunks.length).toBeGreaterThan(0);
	});

	test("rejects invalid move targets with short literal errors", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-validate-src.md",
				name: "move-validate-src.md",
				markdown: "# Validate base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const sibling = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-validate-sibling.md",
				name: "move-validate-sibling.md",
				markdown: "# Sibling base",
				membership,
			}),
		);

		// Destination parent must be an active folder or root.
		const destParentIsFile = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: sibling.nodeId,
			destName: "moved.md",
		});
		expect(destParentIsFile._nay?.message).toBe("Destination folder is missing");

		// Same source and destination path.
		const samePath = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-validate-src.md",
		});
		expect(samePath._nay?.message).toBe("Source and destination are the same");

		// Active sibling already owns the destination name.
		const siblingConflict = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-validate-sibling.md",
		});
		expect(siblingConflict._nay?.message).toBe("Path already exists");

		// Folder cannot move into its own subtree.
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-validate-folder",
				name: "move-validate-folder",
			}),
		);
		const subFolderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				parentId: folderId,
				path: "/move-validate-folder/sub",
				name: "sub",
			}),
		);
		const folderIntoItself = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
			destParentId: subFolderId,
			destName: "move-validate-folder",
		});
		expect(folderIntoItself._nay?.message).toBe("Cannot move a folder into itself");

		// Archived source nodes are not movable.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: "archive-op-validate" });
		});
		const archivedSource = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "moved.md",
		});
		expect(archivedSource._nay?.message).toBe("Not found");
	});

	test("records the replace target only with the replace opt-in", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-replace-src.md",
				name: "move-replace-src.md",
				markdown: "# Replace source base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-replace-dest.md",
				name: "move-replace-dest.md",
				markdown: "# Replace dest base",
				membership,
			}),
		);

		// Without the opt-in the occupied destination stays a conflict.
		const withoutReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-dest.md",
		});
		expect(withoutReplace._nay?.message).toBe("Path already exists");

		const withReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-dest.md",
			replace: true,
		});
		if (withReplace._nay) {
			throw new Error(withReplace._nay.message);
		}
		expect(withReplace._yay).toEqual({
			fromPath: "/move-replace-src.md",
			destPath: "/move-replace-dest.md",
			replacesExistingOccupant: true,
			cancelledExistingMove: false,
			appliedImmediately: false,
		});

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove).toMatchObject({
			destParent: { kind: "root" },
			destName: "move-replace-dest.md",
			fromPath: "/move-replace-src.md",
			replacesTarget: { kind: "saved", id: occupant.nodeId },
		});

		// A file never replaces a folder occupant, even with the opt-in.
		await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/move-replace-folder",
				name: "move-replace-folder",
			}),
		);
		const folderConflict = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "move-replace-folder",
			replace: true,
		});
		expect(folderConflict._nay?.message).toBe("Path already exists");
	});

	test("accepts a destination vacated by the proposer's own pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/vacated-src.md",
				name: "vacated-src.md",
				markdown: "# Vacated base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/vacated-other.md",
				name: "vacated-other.md",
				markdown: "# Vacated other base",
				membership,
			}),
		);

		// The first proposal vacates /vacated-src.md in the proposer's visible tree.
		const firstMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "vacated-dest.md",
		});
		if (firstMove._nay) {
			throw new Error(firstMove._nay.message);
		}

		// The committed sibling moved away for this user, so its path is free to claim.
		const reuseMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "vacated-src.md",
		});
		if (reuseMove._nay) {
			throw new Error(reuseMove._nay.message);
		}
		expect(reuseMove._yay.destPath).toBe("/vacated-src.md");
		expect(reuseMove._yay.replacesExistingOccupant).toBe(false);
	});

	test("rejects a destination already claimed by another pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/claim-a.md",
				name: "claim-a.md",
				markdown: "# Claim a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/claim-b.md",
				name: "claim-b.md",
				markdown: "# Claim b base",
				membership,
			}),
		);

		const firstMove = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
		});
		if (firstMove._nay) {
			throw new Error(firstMove._nay.message);
		}

		// One visible path, one proposal: the second claim is rejected, replace or not.
		const doubleBooked = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
		});
		expect(doubleBooked._nay?.message).toBe("Path already exists");
		const doubleBookedReplace = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "claim-dest.md",
			replace: true,
		});
		expect(doubleBookedReplace._nay?.message).toBe("Path already exists");
	});

	test("rejects a folder parent cycle across two pending moves", async () => {
		const t = test_convex();

		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const folderAId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-a",
				name: "parent-cycle-a",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-b",
				name: "parent-cycle-b",
			}),
		);
		const folderCId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/parent-cycle-c",
				name: "parent-cycle-c",
			}),
		);

		// Folder A moves into folder B: A shows at /parent-cycle-b/x.
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderAId,
			destParentId: folderBId,
			destName: "x",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}

		// Folder B into the moved folder A: the visible destination sits inside B itself, a
		// parent cycle across two rows that would drop both rows from the overlay.
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderBId,
			destParentId: folderAId,
			destName: "inside",
		});
		expect(moveB._nay?.message).toBe("Cannot move a folder into itself");

		// A legitimate move of an unrelated folder into the moved folder A still passes.
		const moveC = await upsert_file_pending_move_for_test({
			t,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId: db.userId,
			nodeId: folderCId,
			destParentId: folderAId,
			destName: "c",
		});
		if (moveC._nay) {
			throw new Error(moveC._nay.message);
		}
		expect(moveC._yay.destPath).toBe("/parent-cycle-a/c");
	});

	test("rejects a folder replace proposal onto a non-empty folder", async () => {
		const t = test_convex();

		const occupantChild = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-full/keep.md",
				name: "keep.md",
				markdown: "# Edr proposal keep base",
			}),
		);
		const { folderId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-p-src",
				name: "edr-p-src",
			});
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-p-full",
				name: "edr-p-full",
			});
			await ctx.db.patch("files_nodes", occupantChild.nodeId, { parentId: occupantId });
			return { folderId };
		});

		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: occupantChild.organizationId,
			workspaceId: occupantChild.workspaceId,
			userId: occupantChild.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-full",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Directory not empty");
	});

	test("rejects replacing an empty folder occupant that a pending move targets into", async () => {
		const t = test_convex();

		const seededFile = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-into-file.md",
				name: "edr-p-into-file.md",
				markdown: "# Edr into base",
			}),
		);
		const { folderId, emptyFolderId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-into-src",
				name: "edr-p-into-src",
			});
			const emptyFolderId = await seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-into",
				name: "edr-p-into",
			});
			return { folderId, emptyFolderId };
		});

		// The user proposes moving a file INTO the empty folder: replacing the folder would
		// break that proposal's destination, so the folder no longer counts as empty.
		const movedIn = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: seededFile.nodeId,
			destParentId: emptyFolderId,
			destName: "moved.md",
		});
		if (movedIn._nay) {
			throw new Error(movedIn._nay.message);
		}
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-into",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Directory not empty");
	});

	test("keeps a file replace proposal onto an empty folder rejected", async () => {
		const t = test_convex();

		const seededFile = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-p-file-src.md",
				name: "edr-p-file-src.md",
				markdown: "# Edr file src base",
			}),
		);
		await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seededFile.organizationId,
				workspaceId: seededFile.workspaceId,
				userId: seededFile.userId,
				path: "/edr-p-dstdir",
				name: "edr-p-dstdir",
			}),
		);

		// rename() fails EISDIR here: a file never replaces a folder, empty or not.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: seededFile.organizationId,
			workspaceId: seededFile.workspaceId,
			userId: seededFile.userId,
			nodeId: seededFile.nodeId,
			destParentId: files_ROOT_ID,
			destName: "edr-p-dstdir",
			replace: true,
		});
		expect(proposed._nay?.message).toBe("Path already exists");
	});

	test("mv back to the original path cancels a pure pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/cancel-move-src.md",
				name: "cancel-move-src.md",
				markdown: "# Cancel move base",
			}),
		);

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before cancel");
		}

		// mv back to the source path cancels the proposal instead of failing validation.
		const cancelled = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-src.md",
		});
		if (cancelled._nay) {
			throw new Error(cancelled._nay.message);
		}
		expect(cancelled._yay).toEqual({
			fromPath: "/cancel-move-src.md",
			destPath: "/cancel-move-src.md",
			replacesExistingOccupant: false,
			cancelledExistingMove: true,
			appliedImmediately: false,
		});

		await t.run(async (ctx) => {
			const row = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(row).toBeNull();
		});

		// Without a pending move the same-path mv keeps the current rejection.
		const samePathWithoutRow = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-move-src.md",
		});
		expect(samePathWithoutRow._nay?.message).toBe("Source and destination are the same");
	});

	test("mv back to the original path keeps the content of a mixed row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/cancel-mixed-src.md",
				name: "cancel-mixed-src.md",
				markdown: "# Cancel mixed base",
			}),
		);

		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nCancel mixed change`,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const cancelled = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "cancel-mixed-src.md",
		});
		if (cancelled._nay) {
			throw new Error(cancelled._nay.message);
		}
		expect(cancelled._yay.cancelledExistingMove).toBe(true);

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected the content proposal to survive the cancelled move");
		}
		expect(row.pendingMove).toBeUndefined();
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
		const rowMarkdownState = await t.run(async (ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: row }));
		expect(rowMarkdownState.unstagedMarkdown).toContain("Cancel mixed change");
	});
});

describe("apply_file_pending_move", () => {
	test("applies a pure file move and patches denormalized paths", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-src.md",
				name: "apply-src.md",
				markdown: "# Apply base",
			}),
		);
		const destFolderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-dest",
				name: "apply-dest",
			}),
		);
		const { plainTextChunkId } = await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/apply-src.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const metadataDocId = await t.run((ctx) =>
			ctx.db.insert("files_metadata_docs", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				fileNodeId: seeded.nodeId,
				sourceKind: "committed",
				path: "/apply-src.md",
				treePath: "/apply-src.md",
				fieldPath: "meta.topic",
				docKind: "field",
			}),
		);

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "renamed.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before apply");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.parentId).toBe(destFolderId);
			expect(node?.name).toBe("renamed.md");
			expect(node?.path).toBe("/apply-dest/renamed.md");
			expect(node?.treePath).toBe("/apply-dest/renamed.md");

			expect(await ctx.db.get("files_plain_text_chunks", plainTextChunkId)).toBeNull();
			const plainTextChunk = await ctx.db.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", q => q.eq("organizationId", seeded.organizationId)
					.eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId)
					.eq("moveView.cohortId", undefined).eq("moveView.view", undefined)).first();
			expect(plainTextChunk?.path).toBe("/apply-dest/renamed.md");

			expect(await ctx.db.get("files_metadata_docs", metadataDocId)).toBeNull();
			const metadataDoc = await ctx.db.query("files_metadata_docs")
				.withIndex("by_organization_workspace_fileNode_fieldPath", q => q.eq("organizationId", seeded.organizationId)
					.eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId)
					.eq("moveView.cohortId", undefined).eq("moveView.view", undefined).eq("fieldPath", "meta.topic")).first();
			expect(metadataDoc?.path).toBe("/apply-dest/renamed.md");
			expect(metadataDoc?.treePath).toBe("/apply-dest/renamed.md");

			const rowAfterApply = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(rowAfterApply).toBeNull();
		});
	});

	test("accepting a rename keeps the stored type", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/subtype-src.json",
				name: "subtype-src.json",
				markdown: '{"a": 1}\n',
				rootKind: "plain_text",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "subtype-renamed.yaml",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._nay).toBeUndefined();

		// json→yaml readback: the name and the extension index move, the stored type does not.
		const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
		expect(node?.name).toBe("subtype-renamed.yaml");
		expect(node?.path).toBe("/subtype-renamed.yaml");
		expect(node?.lowercaseExtension).toBe("yaml");
		expect(node?.contentType).toBe("text/plain;charset=utf-8");
		expect(node?.textKind).toBe("plain_text");
	});

	test("applies a folder move and cascades descendant paths", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-folder/child.md",
				name: "child.md",
				markdown: "# Folder child base",
			}),
		);
		const { folderId, destFolderId, childChunkIds } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-folder",
				name: "apply-folder",
			});
			await ctx.db.patch("files_nodes", seeded.nodeId, { parentId: folderId });
			const destFolderId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-folder-dest",
				name: "apply-folder-dest",
			});
			const childChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/apply-folder/child.md",
				markdown: seeded.baseMarkdown,
			});
			return { folderId, destFolderId, childChunkIds };
		});

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
			destParentId: destFolderId,
			destName: "apply-folder",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const folder = await ctx.db.get("files_nodes", folderId);
			expect(folder?.path).toBe("/apply-folder-dest/apply-folder");
			expect(folder?.treePath).toBe("/apply-folder-dest/apply-folder/");
			expect(folder?.parentId).toBe(destFolderId);

			const child = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(child?.path).toBe("/apply-folder-dest/apply-folder/child.md");

			expect(await ctx.db.get("files_plain_text_chunks", childChunkIds.plainTextChunkId)).toBeNull();
			const childChunk = await ctx.db.query("files_plain_text_chunks")
				.withIndex("by_organization_workspace_fileNode_chunkIndex", q => q.eq("organizationId", seeded.organizationId)
					.eq("workspaceId", seeded.workspaceId).eq("fileNodeId", seeded.nodeId)
					.eq("moveView.cohortId", undefined).eq("moveView.view", undefined)).first();
			expect(childChunk?.path).toBe("/apply-folder-dest/apply-folder/child.md");
		});
	});

	test("one review publishes a move and collaborative content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-mixed-src.md",
				name: "apply-mixed-src.md",
				markdown: "# Apply mixed base",
			}),
		);

		const changedMarkdown = `${seeded.baseMarkdown}\n\nApply mixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-mixed-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const accepted = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(accepted._nay).toBeUndefined();
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/apply-mixed-renamed.md");
			expect(await read_file_markdown_from_yjs({ ctx, ...seeded })).toBe(
				normalize_pending_update_markdown(changedMarkdown),
			);
			expect(await read_pending_update_row({ ctx, ...seeded })).toBeNull();
		});
	});

	test.each(["none", "content", "another user's Move"] as const)(
		"refuses a newcomer file that was not reviewed (proposal: %s)",
		async (proposalKind) => {
			const t = test_convex();
			const seeded = await t.run((ctx) =>
				seed_file_with_markdown({
					ctx,
					path: "/apply-conflict-src.md",
					name: "apply-conflict-src.md",
					markdown: "# Apply conflict base",
				}),
			);
			const created = await upsert_file_pending_move_for_test({
				t,
				...seeded,
				destParentId: files_ROOT_ID,
				destName: "apply-conflict-dest.md",
			});
			if (created._nay) throw new Error(created._nay.message);

			// A new occupant needs a fresh review.
			const occupant = await t.run((ctx) =>
				seed_file_with_markdown({
					ctx,
					membership: seeded,
					path: "/apply-conflict-dest.md",
					name: "apply-conflict-dest.md",
					markdown: "# Occupant",
				}),
			);
			if (proposalKind === "content") {
				const content = await upsert_file_pending_update_internal_for_test({
					t,
					...occupant,
					unstagedMarkdown: "# Occupant draft",
				});
				if (content._nay) throw new Error(content._nay.message);
			} else if (proposalKind === "another user's Move") {
				const userId = await t.run(async (ctx) => {
					const userId = await ctx.db.insert("users", { clerkUserId: "clerk_unreviewed_occupant" });
					await seed_billing_snapshot_for_user(ctx, userId);
					await ctx.db.insert("organizations_workspaces_users", {
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						userId,
						active: true,
						pendingOrganizationRemoval: false,
						updatedAt: Date.now(),
					});
					await access_control_db_ensure_role_assignment(ctx, {
						organizationId: seeded.organizationId,
						workspaceId: seeded.workspaceId,
						userId,
						role: "member",
						now: Date.now(),
					});
					return userId;
				});
				const move = await upsert_file_pending_move_for_test({
					t,
					...occupant,
					userId,
					destParentId: files_ROOT_ID,
					destName: "other-user-destination.md",
				});
				if (move._nay) throw new Error(move._nay.message);
			}
			const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId });
			const beforeReview = await read_pending_review_state_for_test(t);
			const refused = await test_apply_file_pending_move(asUser, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				...(await reviewed_pending_for_test(t, {
					membershipId: seeded.membershipId,
					target: { kind: "saved", id: seeded.nodeId },
				})),
			});
			expect(refused._nay?.name).toBe("destination_changed");
			expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
			const run = await t.run((ctx) =>
				ctx.db
					.query("files_pending_update_runs")
					.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
					.unique(),
			);
			if (!run) throw new Error("Expected the review run");
			const review = await asUser.query(api.files_pending_update_runs.get, {
				membershipId: seeded.membershipId,
				runId: run._id,
			});
			expect(review?.run.needsReviewIds, "a plain occupant does not reveal other proposals").toEqual([]);
		},
	);

	test("archives the replaced file when applying a replace move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-src.md",
				name: "apply-replace-src.md",
				markdown: "# Apply replace base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-dest.md",
				name: "apply-replace-dest.md",
				markdown: "# Apply replace dest base",
				membership,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-dest.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			// The replaced file is archived (recoverable), never hard-deleted.
			const replacedNode = await ctx.db.get("files_nodes", occupant.nodeId);
			expect(replacedNode?.archiveOperationId).toBeDefined();

			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-replace-dest.md");
			expect(node?.archiveOperationId).toBeNull();

			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("requires review of a destination's pending content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-saved-src.md",
				name: "apply-replace-saved-src.md",
				markdown: "# Replace saved source",
			}),
		);
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-saved-dst.md",
				name: "apply-replace-saved-dst.md",
				markdown: "# Replace saved dest",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			}),
		);
		// The destination has this user's pending content.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: occupant.organizationId,
			workspaceId: occupant.workspaceId,
			userId: occupant.userId,
			nodeId: occupant.nodeId,
			unstagedMarkdown: `${occupant.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const occupantRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: occupant.organizationId,
				workspaceId: occupant.workspaceId,
				userId: occupant.userId,
				nodeId: occupant.nodeId,
			}),
		);
		if (!occupantRow) {
			throw new Error("Missing the occupant's saved row");
		}

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-saved-dst.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		expect(created._yay.replacesExistingOccupant).toBe(true);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires review of a destination's shared pending work", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-shared-src.md",
				name: "apply-replace-shared-src.md",
				markdown: "# Replace shared source",
			}),
		);
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-shared-dst.md",
				name: "apply-replace-shared-dst.md",
				markdown: "# Replace shared dest",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: occupant.organizationId,
			workspaceId: occupant.workspaceId,
			userId: occupant.userId,
			nodeId: occupant.nodeId,
			unstagedMarkdown: `${occupant.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// The replacement must also protect another member's pending content.
		await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: occupant.organizationId,
				workspaceId: occupant.workspaceId,
				userId: await ctx.db.insert("users", { clerkUserId: "other_user_apply_saved_guard" }),
				target: { kind: "saved", id: occupant.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);

		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-shared-dst.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("refuses an unreviewed folder at the destination", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-conflict-src.md",
				name: "apply-replace-conflict-src.md",
				markdown: "# Replace conflict base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-replace-conflict-dest.md",
				name: "apply-replace-conflict-dest.md",
				markdown: "# Replace conflict dest base",
				membership,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-replace-conflict-dest.md",
			replace: true,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// A different occupant needs a fresh review.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", occupant.nodeId, { archiveOperationId: "archive-op-replaced-away" });
			await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-replace-conflict-dest.md",
				name: "apply-replace-conflict-dest.md",
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires review when the source was archived after the proposal", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archived-src.md",
				name: "apply-archived-src.md",
				markdown: "# Apply archived base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-archived-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: "archive-op-apply" });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._nay?.message).toBe("A reviewed source changed. Review it again.");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove?.destName).toBe("apply-archived-dest.md");
	});

	test("requires one review for connected moves", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-a.md",
				name: "chain-a.md",
				markdown: "# Chain a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-b.md",
				name: "chain-b.md",
				markdown: "# Chain b base",
				membership,
			}),
		);

		// Move B vacates /chain-b.md in the proposer's visible tree, so move A may claim it.
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-c.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-b.md",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}
		const pendingRowA = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRowA) {
			throw new Error("Missing pending move row for move A before apply");
		}

		// Accepting A first must not archive B: B still sits at /chain-b.md only because its own
		// pending move is not accepted yet, so accept must ask for B's move first.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("accepts chained moves in dependency order", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-order-a.md",
				name: "chain-order-a.md",
				markdown: "# Chain order a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/chain-order-b.md",
				name: "chain-order-b.md",
				markdown: "# Chain order b base",
				membership,
			}),
		);

		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-order-c.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveA = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "chain-order-b.md",
		});
		if (moveA._nay) {
			throw new Error(moveA._nay.message);
		}

		// Accepting B first frees /chain-order-b.md, so accepting A afterwards is a plain move.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const appliedB = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: other.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: other.nodeId },
			})),
		});
		if (appliedB._nay) {
			throw new Error(appliedB._nay.message);
		}
		const appliedA = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (appliedA._nay) {
			throw new Error(appliedA._nay.message);
		}

		await t.run(async (ctx) => {
			const nodeB = await ctx.db.get("files_nodes", other.nodeId);
			expect(nodeB?.path).toBe("/chain-order-c.md");
			expect(nodeB?.archiveOperationId).toBeNull();

			const nodeA = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(nodeA?.path).toBe("/chain-order-b.md");
			expect(nodeA?.archiveOperationId).toBeNull();
		});
	});

	test("requires one review for a two-file swap", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-a.md",
				name: "swap-a.md",
				markdown: "# Swap a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-b.md",
				name: "swap-b.md",
				markdown: "# Swap b base",
				membership,
			}),
		);

		// mv a→tmp, mv b→a, mv tmp→b: the third mv replaces A's row, so the two rows
		// left form a cycle (A: a→b, B: b→a) that no single accept order can resolve.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-b.md",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Saving one proposal must ask to review the other proposal first.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
		const unselected = await t.run((ctx) => read_pending_update_row({ ctx, ...other }));
		if (!unselected) throw new Error("Expected the unselected Move");
		const run = await t.run((ctx) =>
			ctx.db
				.query("files_pending_update_runs")
				.withIndex("by_user", (q) => q.eq("userId", seeded.userId))
				.unique(),
		);
		if (!run) throw new Error("Expected the review run");
		const review = await asUser.query(api.files_pending_update_runs.get, {
			membershipId: seeded.membershipId,
			runId: run._id,
		});
		expect(review?.run.needsReviewIds, "the review names only the unselected swap partner").toEqual([unselected._id]);
	});

	test.each([
		{ selected: false, withContent: false },
		{ selected: true, withContent: false },
		{ selected: true, withContent: true },
	])("requires a destination delete in the review (selected: $selected, content: $withContent)", async ({ selected, withContent }) => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/move-before-delete.md",
				name: "move-before-delete.md",
				markdown: "# Move",
			}),
		);
		const occupant = await t.run((ctx) =>
			seed_file_with_markdown({
				ctx,
				membership: seeded,
				path: "/delete-before-move.md",
				name: "delete-before-move.md",
				markdown: "# Delete",
			}),
		);
		const committedBefore = await t.run((ctx) => read_committed_text({ ctx, ...occupant }));
		if (withContent) {
			const edited = await upsert_file_pending_update_internal_for_test({
				t,
				...occupant,
				stagedMarkdown: "# Draft delete\n",
				unstagedMarkdown: "# Draft delete\n",
			});
			if (edited._nay) throw new Error(edited._nay.message);
		}
		const deleted = await upsert_file_pending_archive_for_test({ t, ...occupant });
		if (deleted._nay) throw new Error(deleted._nay.message);
		const moved = await upsert_file_pending_move_for_test({
			t,
			...seeded,
			destParentId: files_ROOT_ID,
			destName: "delete-before-move.md",
		});
		if (moved._nay) throw new Error(moved._nay.message);
		const moveProposal = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		const deleteProposal = await t.run((ctx) => read_pending_update_row({ ctx, ...occupant }));
		if (!moveProposal || !deleteProposal) throw new Error("Expected the Move and Delete proposals");
		if (withContent) expect(deleteProposal.content, "the selected Delete keeps its draft until review").toBeDefined();
		const originalDeleteContent = deleteProposal.content;
		const beforeReview = await read_pending_review_state_for_test(t);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId });
		const review = await save_pending_review_for_test(
			{ t, asUser, membershipId: seeded.membershipId },
			selected ? [moveProposal, deleteProposal] : [moveProposal],
		);
		if (selected) {
			expect(review?.activity, "the selected delete frees the Move destination").toMatchObject({
				status: "succeeded",
				progress: { completed: 2, blocked: 0 },
			});
			expect(review?.run.unitCount, "the Move and destination delete publish together").toBe(1);
			expect((await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId)))?.path).toBe("/delete-before-move.md");
			expect((await t.run((ctx) => ctx.db.get("files_nodes", occupant.nodeId)))?.archiveOperationId).not.toBeNull();
			expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();
			expect(
				await t.run((ctx) => read_pending_update_row({ ctx, ...occupant })),
				"the selected Delete removes its pending content proposal",
			).toBeNull();
			expect(await t.run((ctx) => read_committed_text({ ctx, ...occupant })), "Delete does not save its draft text").toBe(
				committedBefore,
			);
			if (withContent)
				await expect_consumed_pending_content_cleanup_for_test(
					t,
					originalDeleteContent!,
					"The selected Delete retires its original draft states",
				);
		} else {
			expect(review?.activity).toMatchObject({ status: "failed", progress: { completed: 0, blocked: 1 } });
			expect(review?.run.needsReviewIds, "the review names only the unselected destination delete").toEqual([
				deleteProposal._id,
			]);
			expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
		}
	});

	test("keeps a restricted swap partner unchanged before review", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/cyc-a.md", name: "cyc-a.md", markdown: "# Cycle a" }),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/cyc-b.md", name: "cyc-b.md", markdown: "# Cycle b", membership }),
		);

		// The seeded user owns the organization and bypasses every check, so the accept has to be made
		// by somebody else. This one holds ordinary workspace write and nothing on the restricted file.
		const mover = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_cycle_perm" });
			await seed_billing_snapshot_for_user(ctx, userId);
			const membershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				role: "member",
				now,
			});
			return { userId, membershipId };
		});

		// mv a→tmp, mv b→a, mv a→b leaves the two rows that form the cycle.
		for (const move of [
			{ nodeId: seeded.nodeId, destName: "cyc-tmp.md" },
			{ nodeId: other.nodeId, destName: "cyc-a.md" },
			{ nodeId: seeded.nodeId, destName: "cyc-b.md" },
		]) {
			const proposed = await upsert_file_pending_move_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: mover.userId,
				nodeId: move.nodeId,
				destParentId: files_ROOT_ID,
				destName: move.destName,
			});
			if (proposed._nay) {
				throw new Error(proposed._nay.message);
			}
		}

		// Only now is the swap partner closed off. The proposal outlived the access that made it.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", other.nodeId, { restrictedScopeNodeId: other.nodeId });
		});

		const asMover = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: mover.userId,
			name: "Mover",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asMover, {
			membershipId: mover.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: mover.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for content within a swap", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-mixed-a.md",
				name: "swap-mixed-a.md",
				markdown: "# Swap mixed a base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const other = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/swap-mixed-b.md",
				name: "swap-mixed-b.md",
				markdown: "# Swap mixed b base",
				membership,
			}),
		);

		// B carries a content edit, so its row stays mixed through the swap.
		const edited = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			stagedMarkdown: other.baseMarkdown,
			unstagedMarkdown: `${other.baseMarkdown}\n\nSwap mixed change`,
		});
		if (edited._nay) {
			throw new Error(edited._nay.message);
		}

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: other.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "swap-mixed-b.md",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the mixed row's side: the cycle still applies both moves.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: other.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: other.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a long file rotation", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/rotate-1.md",
				name: "rotate-1.md",
				markdown: "# Rotate 1 base",
			}),
		);
		const membership = {
			userId: seeded.userId,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			membershipId: seeded.membershipId,
		};
		const fileCount = 14;
		const rotated = [seeded];
		for (let index = 2; index <= fileCount; index++) {
			const file = await t.run(async (ctx) =>
				seed_file_with_markdown({
					ctx,
					path: `/rotate-${index}.md`,
					name: `rotate-${index}.md`,
					markdown: `# Rotate ${index} base`,
					membership,
				}),
			);
			rotated.push(file);
		}

		// mv f1→tmp frees /rotate-1.md, each next mv shifts a file down one slot, and the final
		// mv replaces f1's tmp proposal: the rows form one rotation cycle of 14 files.
		const movedToTmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "rotate-tmp.md",
		});
		if (movedToTmp._nay) {
			throw new Error(movedToTmp._nay.message);
		}
		for (const [index, file] of rotated.entries()) {
			if (index === 0) {
				continue;
			}
			const moved = await upsert_file_pending_move_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: file.nodeId,
				destParentId: files_ROOT_ID,
				destName: `rotate-${index}.md`,
			});
			if (moved._nay) {
				throw new Error(moved._nay.message);
			}
		}
		const movedToLast = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: `rotate-${fileCount}.md`,
		});
		if (movedToLast._nay) {
			throw new Error(movedToLast._nay.message);
		}

		// Accepting any member applies the whole rotation inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a two-folder swap", async () => {
		const t = test_convex();

		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-swap-a/a-child.md",
				name: "a-child.md",
				markdown: "# Fsc swap a child base",
			}),
		);
		const membership = {
			userId: childA.userId,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			membershipId: childA.membershipId,
		};
		const childB = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-swap-b/b-child.md",
				name: "b-child.md",
				markdown: "# Fsc swap b child base",
				membership,
			}),
		);
		const { folderAId, folderBId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-swap-a",
				name: "fsc-swap-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-swap-b",
				name: "fsc-swap-b",
			});
			await ctx.db.patch("files_nodes", childB.nodeId, { parentId: folderBId });
			const childAChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				nodeId: childA.nodeId,
				path: "/fsc-swap-a/a-child.md",
				markdown: childA.baseMarkdown,
			});
			return { folderAId, folderBId, childAChunkIds };
		});

		// mv a→tmp, mv b→a, mv tmp→b: the third mv replaces A's row, so the two rows
		// left form a folder swap cycle (A: a→b, B: b→a).
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-swap-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accepting either row applies the whole cycle inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: childA.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childA.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a file and folder swap", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-mix-a.md",
				name: "fsc-mix-a.md",
				markdown: "# Fsc mix a base",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-mix-b",
				name: "fsc-mix-b",
			}),
		);

		// The file and the folder trade paths through a temp name.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-mix-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the folder's side: the mixed cycle still applies both moves.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("keeps content and move cycle members unchanged before review", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-cnm-a.md",
				name: "fsc-cnm-a.md",
				markdown: "# Fsc cnm base",
			}),
		);
		const folderBId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-cnm-b",
				name: "fsc-cnm-b",
			}),
		);

		// The file carries a content proposal, then joins the swap: its doc is content-plus-move.
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nCnm change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-tmp.md",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-a.md",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-cnm-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accept from the folder's side: the file is the NON-clicked cycle member.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a three-folder rotation", async () => {
		const t = test_convex();

		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-rot-a/rot-child.md",
				name: "rot-child.md",
				markdown: "# Fsc rot child base",
			}),
		);
		const { folderAId, folderBId, folderCId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-a",
				name: "fsc-rot-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-b",
				name: "fsc-rot-b",
			});
			const folderCId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-rot-c",
				name: "fsc-rot-c",
			});
			return { folderAId, folderBId, folderCId };
		});

		// A→tmp frees a, B claims a, C claims b, and the final move replaces A's tmp
		// row: the three rows form the A→c, B→a, C→b rotation.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveC = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderCId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-b",
		});
		if (moveC._nay) {
			throw new Error(moveC._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-rot-c",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Accepting any member applies the whole rotation inside one transaction.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: childA.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childA.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review when a cycle parent also moves", async () => {
		const t = test_convex();

		// M=/fsc-nest-m holds C=child.md; K=/fsc-nest-k.md is a file with committed chunks.
		const childC = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-nest-m/child.md",
				name: "child.md",
				markdown: "# Fsc nest child base",
			}),
		);
		const membership = {
			userId: childC.userId,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			membershipId: childC.membershipId,
		};
		const fileK = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-nest-k.md",
				name: "fsc-nest-k.md",
				markdown: "# Fsc nest k base",
				membership,
			}),
		);
		const { folderMId } = await t.run(async (ctx) => {
			const folderMId = await seed_folder_node({
				ctx,
				organizationId: childC.organizationId,
				workspaceId: childC.workspaceId,
				userId: childC.userId,
				path: "/fsc-nest-m",
				name: "fsc-nest-m",
			});
			await ctx.db.patch("files_nodes", childC.nodeId, { parentId: folderMId });
			const fileKChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childC.organizationId,
				workspaceId: childC.workspaceId,
				nodeId: fileK.nodeId,
				path: "/fsc-nest-k.md",
				markdown: fileK.baseMarkdown,
			});
			return { folderMId, fileKChunkIds };
		});

		// C→tmp frees child.md, K claims it INSIDE M, M claims K's path, and the final
		// move replaces C's tmp row: the cycle is C→/fsc-nest-m, M→/fsc-nest-k.md,
		// K→(M)/child.md — K's destination parent M moves in the same cycle.
		const moveCTmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: childC.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-tmp.md",
		});
		if (moveCTmp._nay) {
			throw new Error(moveCTmp._nay.message);
		}
		const moveK = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: fileK.nodeId,
			destParentId: folderMId,
			destName: "child.md",
		});
		if (moveK._nay) {
			throw new Error(moveK._nay.message);
		}
		const moveM = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: folderMId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-k.md",
		});
		if (moveM._nay) {
			throw new Error(moveM._nay.message);
		}
		const moveCFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childC.organizationId,
			workspaceId: childC.workspaceId,
			userId: childC.userId,
			nodeId: childC.nodeId,
			destParentId: files_ROOT_ID,
			destName: "fsc-nest-m",
		});
		if (moveCFinal._nay) {
			throw new Error(moveCFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childC.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: childC.membershipId,
			target: { kind: "saved", id: childC.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childC.membershipId,
				target: { kind: "saved", id: childC.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("keeps a changed parent loop unchanged before review", async () => {
		const t = test_convex();

		// A=/fsc-loop-q/a and B=/fsc-loop-b swap; Q is A's committed parent.
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-loop-file.md",
				name: "fsc-loop-file.md",
				markdown: "# Fsc loop base",
			}),
		);
		const { folderQId, folderAId, folderBId } = await t.run(async (ctx) => {
			const folderQId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-loop-q",
				name: "fsc-loop-q",
			});
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				parentId: folderQId,
				path: "/fsc-loop-q/a",
				name: "a",
			});
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/fsc-loop-b",
				name: "fsc-loop-b",
			});
			return { folderQId, folderAId, folderBId };
		});

		// The swap cycle: A→/fsc-loop-b, B→(Q)/a.
		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-loop-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: folderQId,
			destName: "a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-loop-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		// Another user commits Q under B after the proposals: the final tree would nest
		// B under Q and Q under B — a parent loop.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", folderQId, {
				parentId: folderBId,
				path: "/fsc-loop-b/fsc-loop-q",
				treePath: "/fsc-loop-b/fsc-loop-q/",
				pathDepth: 2,
			});
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("requires one review for a folder swap with an empty occupant", async () => {
		const t = test_convex();

		// A holds a child (with chunks); B is EMPTY, so A's destination occupant is
		// replaceable on its own — the cycle must still swap, never archive B.
		const childA = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/fsc-empty-a/a-child.md",
				name: "a-child.md",
				markdown: "# Fsc empty a child base",
			}),
		);
		const { folderAId, folderBId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-empty-a",
				name: "fsc-empty-a",
			});
			await ctx.db.patch("files_nodes", childA.nodeId, { parentId: folderAId });
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				userId: childA.userId,
				path: "/fsc-empty-b",
				name: "fsc-empty-b",
			});
			const childAChunkIds = await seed_committed_chunks_for_file({
				ctx,
				organizationId: childA.organizationId,
				workspaceId: childA.workspaceId,
				nodeId: childA.nodeId,
				path: "/fsc-empty-a/a-child.md",
				markdown: childA.baseMarkdown,
			});
			return { folderAId, folderBId, childAChunkIds };
		});

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: childA.organizationId,
			workspaceId: childA.workspaceId,
			userId: childA.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "fsc-empty-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: childA.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: childA.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: childA.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("needs_review");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("accepts a folder move that replaces an empty folder occupant", async () => {
		const t = test_convex();

		const child = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-src/child.md",
				name: "child.md",
				markdown: "# Edr child base",
			}),
		);
		const { folderId, occupantId } = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-src",
				name: "edr-src",
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-dst",
				name: "edr-dst",
			});
			return { folderId, occupantId };
		});

		// rename() semantics: a folder may replace an EMPTY folder occupant.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: child.organizationId,
			workspaceId: child.workspaceId,
			userId: child.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-dst",
			replace: true,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		expect(proposed._yay.replacesExistingOccupant).toBe(true);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: child.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: child.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: child.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			// The empty occupant is archived (never hard-deleted), the mover owns the path.
			const occupant = await ctx.db.get("files_nodes", occupantId);
			expect(occupant?.archiveOperationId).toBeDefined();
			const folder = await ctx.db.get("files_nodes", folderId);
			expect(folder?.path).toBe("/edr-dst");
			expect(folder?.archiveOperationId).toBeNull();
			const movedChild = await ctx.db.get("files_nodes", child.nodeId);
			expect(movedChild?.path).toBe("/edr-dst/child.md");

			const row = await read_pending_update_row({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				nodeId: folderId,
			});
			expect(row).toBeNull();
		});
	});

	test("refuses an empty folder that was not reviewed", async () => {
		const t = test_convex();

		const child = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-new-src/child.md",
				name: "child.md",
				markdown: "# Edr newcomer child base",
			}),
		);
		const folderId = await t.run(async (ctx) => {
			const folderId = await seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-new-src",
				name: "edr-new-src",
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return folderId;
		});

		// Propose while the destination is free, then an empty folder lands there.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: child.organizationId,
			workspaceId: child.workspaceId,
			userId: child.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-new",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: child.organizationId,
				workspaceId: child.workspaceId,
				userId: child.userId,
				path: "/edr-new",
				name: "edr-new",
			}),
		);

		// The empty folder was not part of the review.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: child.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: child.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: child.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("refuses a hidden newcomer parent and the move that would replace it", async () => {
		const t = test_convex();

		const file = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-claim-file.md",
				name: "edr-claim-file.md",
				markdown: "# Edr claim base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: file.organizationId,
				workspaceId: file.workspaceId,
				userId: file.userId,
				path: "/edr-claim-src",
				name: "edr-claim-src",
			}),
		);

		// The owner's folder proposal hides a later saved occupant at the same path.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: file.organizationId,
			workspaceId: file.workspaceId,
			userId: file.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-claim",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		const newcomerId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: file.organizationId,
				workspaceId: file.workspaceId,
				userId: file.userId,
				path: "/edr-claim",
				name: "edr-claim",
			}),
		);
		const beforeReview = await read_pending_review_state_for_test(t);
		const movedInto = await upsert_file_pending_move_for_test({
			t,
			organizationId: file.organizationId,
			workspaceId: file.workspaceId,
			userId: file.userId,
			nodeId: file.nodeId,
			destParentId: newcomerId,
			destName: "into.md",
		});
		expect(movedInto._nay?.message).toBe("Destination folder is missing");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: file.userId,
			name: "Test User",
		});
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: file.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: file.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		expect(applied._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("refuses a nonempty folder that was not reviewed", async () => {
		const t = test_convex();

		const occupantChild = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-full/keep.md",
				name: "keep.md",
				markdown: "# Edr keep base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-full-src",
				name: "edr-full-src",
			}),
		);

		// Propose while the destination is free, then a NON-empty folder lands there.
		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: occupantChild.organizationId,
			workspaceId: occupantChild.workspaceId,
			userId: occupantChild.userId,
			nodeId: folderId,
			destParentId: files_ROOT_ID,
			destName: "edr-full",
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		await t.run(async (ctx) => {
			const occupantId = await seed_folder_node({
				ctx,
				organizationId: occupantChild.organizationId,
				workspaceId: occupantChild.workspaceId,
				userId: occupantChild.userId,
				path: "/edr-full",
				name: "edr-full",
			});
			await ctx.db.patch("files_nodes", occupantChild.nodeId, { parentId: occupantId });
			return occupantId;
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: occupantChild.userId,
			name: "Test User",
		});
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: occupantChild.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: occupantChild.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("accepts mixed content after a manual move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-idem-src.md",
				name: "apply-idem-src.md",
				markdown: "# Apply idem base",
			}),
		);

		const destParentId = await t.run((ctx) =>
			seed_folder_node({ ctx, ...seeded, path: "/apply-idem-dest", name: "apply-idem-dest" }),
		);
		const changedMarkdown = `${seeded.baseMarkdown}\n\nApply idem change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId,
			destName: "apply-idem-src.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing mixed pending row before apply");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const manualMove = await test_move_nodes(t, asUser, {
			membershipId: seeded.membershipId,
			itemIds: [seeded.nodeId],
			targetParentId: destParentId,
		});
		expect(manualMove._nay).toBeUndefined();
		const accepted = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(accepted._nay).toBeUndefined();
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/apply-idem-dest/apply-idem-src.md");
			expect(await read_file_markdown_from_yjs({ ctx, ...seeded })).toBe(
				normalize_pending_update_markdown(changedMarkdown),
			);
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("accepts a pure move whose rename the UI already performed", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-ui-renamed-src.md",
				name: "apply-ui-renamed-src.md",
				markdown: "# Apply ui renamed base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-ui-renamed-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// A committed rename lands the node at the proposed destination before the accept.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const renamed = await test_rename_node(t, asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			path: "apply-ui-renamed-dest.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		// The move is already applied, so accept is a success no-op that settles the row.
		const applied = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/apply-ui-renamed-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("accepts mixed content after a manual rename", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-ui-mixed-src.md",
				name: "apply-ui-mixed-src.md",
				markdown: "# Apply ui mixed base",
			}),
		);
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nUi mixed change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "apply-ui-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const renamed = await test_rename_node(t, asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			path: "apply-ui-mixed-dest.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}
		const accepted = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(accepted._nay).toBeUndefined();
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/apply-ui-mixed-dest.md");
			expect(await read_file_markdown_from_yjs({ ctx, ...seeded })).toBe(changedMarkdown);
			expect(await read_pending_update_row({ ctx, ...seeded })).toBeNull();
		});
	});
});

describe("upsert_file_pending_archive_in_db", () => {
	test("creates a delete row, sets its expiry, and is idempotent", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/archive-upsert.md",
				name: "archive-upsert.md",
				markdown: "# Archive upsert base",
			}),
		);

		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		expect(created._yay).toEqual({
			fromPath: "/archive-upsert.md",
			nodeKind: "file",
			outcome: "proposed",
		});

		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row after archive upsert");
		}
		expect(pendingRow.pendingArchive).toEqual({ fromPath: "/archive-upsert.md" });
		expect(files_pending_update_has_yjs_content(pendingRow)).toBe(false);
		expect(pendingRow.size).toBe(0);

		expect(pendingRow.expiresAt).toBe(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
		const expiryCheck = await t.run((ctx) => read_pending_update_expiry_check({ ctx, ...seeded }));
		expect(expiryCheck?.nextCheckAt).toBeLessThanOrEqual(pendingRow.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);

		const repeated = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		expect(repeated._yay?.outcome).toBe("proposed");
		const repeatedRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(repeatedRow?._id).toBe(pendingRow._id);
		expect(repeatedRow?.pendingArchive).toEqual({ fromPath: "/archive-upsert.md" });
	});

	test("supersedes a pending move, keeps content branches, and dedupes threadIds", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/archive-supersede.md",
				name: "archive-supersede.md",
				markdown: "# Archive supersede base",
			}),
		);
		const threadId = await t.run((ctx) =>
			seed_chat_thread({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
			}),
		);

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nDelete me later`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "archive-supersede-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		for (let i = 0; i < 2; i++) {
			const archived = await upsert_file_pending_archive_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				threadId,
			});
			if (archived._nay) {
				throw new Error(archived._nay.message);
			}
		}

		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row after archive supersede");
		}
		expect(pendingRow.pendingArchive).toEqual({ fromPath: "/archive-supersede.md" });
		expect(pendingRow.pendingMove).toBeUndefined();
		expect(files_pending_update_has_yjs_content(pendingRow)).toBe(true);
		expect(pendingRow.threadIds).toEqual([threadId]);
	});

	test("rejects missing or archived nodes", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/archive-rejected.md",
				name: "archive-rejected.md",
				markdown: "# Archive rejected base",
			}),
		);
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: crypto.randomUUID() }));

		const rejected = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		expect(rejected._nay?.message).toBe("Not found");
	});
});

describe("apply_file_pending_archive", () => {
	test("archives the file, patches chunk scope, and removes the doc", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive.md",
				name: "apply-archive.md",
				markdown: "# Apply archive base",
			}),
		);
		const { plainTextChunkId } = await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/apply-archive.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending delete row before apply");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.archiveOperationId).toBeDefined();
			const plainTextChunk = await ctx.db.get("files_plain_text_chunks", plainTextChunkId);
			expect(plainTextChunk?.archiveOperationId).toBe(node?.archiveOperationId);
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});

		// Re-accept after settle is a quiet no-op (bulk retries).
		const reApplied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			pendingUpdateId: pendingRow._id,
			reviewedRevision: pendingRow.revision,
		});
		expect(reApplied._yay).toBe(null);
	});

	test("archives a folder subtree with one operation id and settles only the acting user's docs", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive-folder/child.md",
				name: "child.md",
				markdown: "# Folder child base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/apply-archive-folder",
				name: "apply-archive-folder",
			}),
		);
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { parentId: folderId }));
		const outsiderSeeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive-outsider.md",
				name: "apply-archive-outsider.md",
				markdown: "# Outsider base",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			}),
		);

		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		// The acting user also has their own doc on the child: accept removes it too.
		const childDelete = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (childDelete._nay) {
			throw new Error(childDelete._nay.message);
		}
		// Another user's doc on the child must survive the accept untouched. They are a real member with a
		// real role, because proposing a delete asks the node whether this user may write it.
		const otherUserId = await t.run(async (ctx) => {
			const now = Date.now();
			const userId = await ctx.db.insert("users", { clerkUserId: "clerk_apply_archive_other" });
			await ctx.db.insert("organizations_workspaces_users", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: now,
			});
			await access_control_db_ensure_role_assignment(ctx, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId,
				role: "member",
				now,
			});
			return userId;
		});
		const otherDoc = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: otherUserId,
			nodeId: seeded.nodeId,
		});
		if (otherDoc._nay) {
			throw new Error(otherDoc._nay.message);
		}
		// A file committed into the folder AFTER the proposal is archived too.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const lateFile = await asUser.action(api.files_nodes_content.create_text_node, {
			membershipId: seeded.membershipId,
			parentId: folderId,
			path: "late.md",
		});
		if (lateFile._nay) throw new Error(lateFile._nay.message);
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderId },
			})),
		});
		if (applied._nay) {
			throw new Error(applied._nay.message);
		}

		await t.run(async (ctx) => {
			const folder = await ctx.db.get("files_nodes", folderId);
			const child = await ctx.db.get("files_nodes", seeded.nodeId);
			const late = await ctx.db.get("files_nodes", lateFile._yay.nodeId);
			expect(folder?.archiveOperationId).toBeDefined();
			expect(child?.archiveOperationId).toBe(folder?.archiveOperationId);
			expect(late?.archiveOperationId).toBe(folder?.archiveOperationId);
			const outsider = await ctx.db.get("files_nodes", outsiderSeeded.nodeId);
			expect(outsider?.archiveOperationId).toBeNull();

			const actingFolderRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: folderId,
			});
			expect(actingFolderRow).toBeNull();
			const actingChildRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(actingChildRow).toBeNull();
			const otherChildRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: otherUserId,
				nodeId: seeded.nodeId,
			});
			expect(otherChildRow?.pendingArchive).toBeDefined();
		});
	});

	test("ignores a locked archived tree when a new active folder reuses its path", async () => {
		const t = test_convex();
		const membership = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const archivedTree = await t.run(async (ctx) => {
			const rootId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-reused-docs",
				name: "pending-reused-docs",
			});
			const childId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				parentId: rootId,
				path: "/pending-reused-docs/secret",
				name: "secret",
			});
			return { rootId, childId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Pending Path Reuse User",
		});
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: membership.membershipId,
			nodeIds: [archivedTree.rootId],
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		const archivedOperationId = (await t.run((ctx) => ctx.db.get("files_nodes", archivedTree.rootId)))
			?.archiveOperationId;
		expect(archivedOperationId).toBeDefined();

		const activeTree = await t.run(async (ctx) => {
			const rootId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-reused-docs",
				name: "pending-reused-docs",
			});
			const childId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				parentId: rootId,
				path: "/pending-reused-docs/current",
				name: "current",
			});
			return { rootId, childId };
		});
		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: activeTree.rootId,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}

		// The lock arrives after the proposal. Accept must still use node lineage rather than
		// mistaking the archived `/pending-reused-docs` tree for this active one.
		await set_pending_test_read_only({ asUser, membershipId: membership.membershipId, nodeId: archivedTree.childId });
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: membership.membershipId,
			target: { kind: "saved", id: activeTree.rootId },
			...(await reviewed_pending_for_test(t, {
				membershipId: membership.membershipId,
				target: { kind: "saved", id: activeTree.rootId },
			})),
		});
		expect(applied._nay).toBeUndefined();

		await t.run(async (ctx) => {
			const activeRoot = await ctx.db.get("files_nodes", activeTree.rootId);
			const activeChild = await ctx.db.get("files_nodes", activeTree.childId);
			expect(activeRoot?.archiveOperationId).toBeDefined();
			expect(activeChild?.archiveOperationId).toBe(activeRoot?.archiveOperationId);
			expect((await ctx.db.get("files_nodes", archivedTree.rootId))?.archiveOperationId).toBe(archivedOperationId);
			expect((await ctx.db.get("files_nodes", archivedTree.childId))?.archiveOperationId).toBe(archivedOperationId);
		});
	});

	test("a true archived descendant still blocks a pending folder archive at accept time", async () => {
		const t = test_convex();
		const membership = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const tree = await t.run(async (ctx) => {
			const rootId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-true-archived",
				name: "pending-true-archived",
			});
			const childId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				parentId: rootId,
				path: "/pending-true-archived/child",
				name: "child",
			});
			return { rootId, childId };
		});
		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: membership.userId,
			nodeId: tree.rootId,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: membership.userId,
			name: "Pending True Descendant User",
		});
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: membership.membershipId,
			nodeIds: [tree.childId],
		});
		if (archived._nay) {
			throw new Error(archived._nay.message);
		}
		await set_pending_test_read_only({ asUser, membershipId: membership.membershipId, nodeId: tree.childId });

		const refused = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: membership.membershipId,
			target: { kind: "saved", id: tree.rootId },
			...(await reviewed_pending_for_test(t, {
				membershipId: membership.membershipId,
				target: { kind: "saved", id: tree.rootId },
			})),
		});
		expect(refused._nay?.name).toBe("read_only");
		expect((await t.run((ctx) => ctx.db.get("files_nodes", tree.rootId)))?.archiveOperationId).toBeNull();
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: membership.userId,
					nodeId: tree.rootId,
				}),
			),
		).not.toBeNull();
	});

	test("drops the doc quietly when the node was already archived", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/apply-archive-raced.md",
				name: "apply-archive-raced.md",
				markdown: "# Raced base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		// The sidebar Archive action (or another accept) archived the node first.
		const sidebarOperationId = crypto.randomUUID();
		await t.run((ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { archiveOperationId: sidebarOperationId }));

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const applied = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(applied._yay).toBe(null);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.archiveOperationId).toBe(sidebarOperationId);
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
		});
	});
});

describe("pending delete discard, save, expiry, and overlay reads", () => {
	test("discard clears the delete and keeps the content proposal", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-delete-content.md",
				name: "discard-delete-content.md",
				markdown: "# Discard delete base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nStill wanted`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", seeded.nodeId)).not.toBeNull();
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row?.pendingArchive).toBeUndefined();
			expect(row && files_pending_update_has_yjs_content(row)).toBe(true);
		});
	});

	test("discard removes a delete-only doc and never touches the node", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-delete-only.md",
				name: "discard-delete-only.md",
				markdown: "# Discard delete-only base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing delete-only row before discard");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("save is rejected while a delete pends", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-behind-delete.md",
				name: "save-behind-delete.md",
				markdown: "# Save behind delete base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nStaged change`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nStaged change`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const rowWithDelete = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!rowWithDelete) {
			throw new Error("Missing pending row while testing save behind a pending delete");
		}
		const saved = await asUser.mutation(internal.files_pending_updates.save_file_pending_update_in_db, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			pendingUpdateId: rowWithDelete._id,
			expectedRevision: rowWithDelete.revision,
			baseYjsSequence: 0,
			baseLineageGeneration: 0,
		});
		expect(saved._nay?.message).toBe("File has a pending delete");
	});

	test("an expired delete-only doc is removed and the node stays", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-delete.md",
				name: "expire-delete.md",
				markdown: "# Expire delete base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing delete-only row before expiry");
		}
		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node).not.toBeNull();
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("get_by_path hides a pending-deleted file for the proposer only", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-delete.md",
				name: "overlay-delete.md",
				markdown: "# Overlay delete base",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const forProposer = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-delete.md",
			overlayUserId: seeded.userId,
		});
		expect(forProposer).toBeNull();

		const committed = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-delete.md",
		});
		expect(committed?._id).toBe(seeded.nodeId);
	});

	test("get_by_path hides a deleted folder's descendants", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-delete-folder/child.md",
				name: "child.md",
				markdown: "# Overlay folder child base",
			}),
		);
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/overlay-delete-folder",
				name: "overlay-delete-folder",
			}),
		);
		const created = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderId,
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const childForProposer = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-delete-folder/child.md",
			overlayUserId: seeded.userId,
		});
		expect(childForProposer).toBeNull();

		const childCommitted = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-delete-folder/child.md",
		});
		expect(childCommitted?._id).toBe(seeded.nodeId);
	});
});

describe("discard_file_pending_content", () => {
	test("copies staged content into unstaged content without saving it", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-content.md",
				name: "discard-content.md",
				markdown: "# Discard content base",
			}),
		);
		const stagedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nAccepted change`);
		const unstagedMarkdown = normalize_pending_update_markdown(`${stagedMarkdown}\n\nUnresolved change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown,
			unstagedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const pendingDoc = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingDoc) {
			throw new Error("Missing pending content doc before discard");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: pendingDoc._id,
			})),
			pendingUpdateId: pendingDoc._id,
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		const docAfterDiscard = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingDoc._id));
		if (!docAfterDiscard) {
			throw new Error("Expected accepted staged content to keep the pending doc");
		}
		expect(
			await t.run(async (ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: docAfterDiscard })),
		).toEqual({
			baseMarkdown: seeded.baseMarkdown,
			stagedMarkdown,
			unstagedMarkdown: stagedMarkdown,
		});
	});

	test("rejects a stale pendingUpdateId instead of discarding the replacement doc", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-content-stale-id.md",
				name: "discard-content-stale-id.md",
				markdown: "# Discard stale content base",
			}),
		);

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nFirst draft`,
		});
		const stalePendingDoc = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!stalePendingDoc) {
			throw new Error("Missing stale pending content doc before replacement");
		}

		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		const currentStagedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nCurrent staged`);
		const currentUnstagedMarkdown = normalize_pending_update_markdown(`${currentStagedMarkdown}\n\nCurrent draft`);
		await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: currentStagedMarkdown,
			unstagedMarkdown: currentUnstagedMarkdown,
		});
		const currentPendingDoc = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!currentPendingDoc) {
			throw new Error("Missing replacement pending content doc");
		}
		expect(currentPendingDoc._id).not.toBe(stalePendingDoc._id);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: stalePendingDoc._id,
			})),
			pendingUpdateId: stalePendingDoc._id,
		});
		expect(discarded._nay?.message).toBe("Not found");

		const docAfterDiscard = await t.run((ctx) => ctx.db.get("files_pending_updates", currentPendingDoc._id));
		expect(docAfterDiscard).not.toBeNull();
		expect(
			await t.run(async (ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: docAfterDiscard! })),
		).toEqual({
			baseMarkdown: seeded.baseMarkdown,
			stagedMarkdown: currentStagedMarkdown,
			unstagedMarkdown: currentUnstagedMarkdown,
		});
	});
});

describe("discard_file_pending_structural", () => {
	test("deletes a pure-move row and leaves the node untouched", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-move-src.md",
				name: "discard-move-src.md",
				markdown: "# Discard move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "discard-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before discard");
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/discard-move-src.md");
			const rowAfterDiscard = await ctx.db.get("files_pending_updates", pendingRow._id);
			expect(rowAfterDiscard).toBeNull();
		});
	});

	test("refuses replacement after a swap partner was discarded", async () => {
		const t = test_convex();

		// Two EMPTY folders swap; discarding one side turns the other accept into a
		// plain empty-folder replacement of the now-stationary occupant.
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/edr-disc-file.md",
				name: "edr-disc-file.md",
				markdown: "# Edr disc base",
			}),
		);
		const { folderAId, folderBId } = await t.run(async (ctx) => {
			const folderAId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/edr-disc-a",
				name: "edr-disc-a",
			});
			const folderBId = await seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/edr-disc-b",
				name: "edr-disc-b",
			});
			return { folderAId, folderBId };
		});

		const moveATmp = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-tmp",
		});
		if (moveATmp._nay) {
			throw new Error(moveATmp._nay.message);
		}
		const moveB = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderBId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-a",
		});
		if (moveB._nay) {
			throw new Error(moveB._nay.message);
		}
		const moveAFinal = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: folderAId,
			destParentId: files_ROOT_ID,
			destName: "edr-disc-b",
		});
		if (moveAFinal._nay) {
			throw new Error(moveAFinal._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderBId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderBId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}
		const beforeReview = await read_pending_review_state_for_test(t);
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: folderAId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: folderAId },
			})),
		});
		expect(refused._nay?.name).toBe("destination_changed");
		expect(await read_pending_review_state_for_test(t)).toEqual(beforeReview);
	});

	test("drops the move and keeps the content on a mixed row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-mixed-src.md",
				name: "discard-mixed-src.md",
				markdown: "# Discard mixed base",
			}),
		);
		const changedMarkdown = `${seeded.baseMarkdown}\n\nDiscard mixed change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "discard-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected the content proposal to survive the structural discard");
			}
			expect(row.pendingMove).toBeUndefined();
			expect(files_pending_update_has_yjs_content(row)).toBe(true);
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id });
			expect(chunks.length).toBeGreaterThan(0);
		});
	});

	test("keeps the destination node when discarding a copy row", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-source.md",
				name: "discard-copy-source.md",
				markdown: "# Copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-dest.md",
				name: "discard-copy-dest.md",
				markdown: "# Copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// cp onto an existing file: the destination node was NOT created by the proposal.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Only the proposal row is dropped; the pre-existing node keeps its committed content.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps both the source and the destination when discarding a copy row", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-keep-source.md",
				name: "discard-copy-keep-source.md",
				markdown: "# Copy keep source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-keep-dest.md",
				name: "discard-copy-keep-dest.md",
				markdown: "# Copy keep dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		// cp onto an existing file: the copy lives on the TARGET row and names its source.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-keep-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Nothing moved and nothing was archived: only the proposal row is dropped.
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeNull();
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			expect(destNode?.archiveOperationId).toBeNull();
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the node when content was committed since the copy was proposed", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-committed-source.md",
				name: "discard-copy-committed-source.md",
				markdown: "# Committed guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-committed-dest.md",
				name: "discard-copy-committed-dest.md",
				markdown: "# Committed guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-committed-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Someone commits real content to the destination node through the regular Yjs flow.
		await t.run(async (ctx) => {
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			if (!destNode?.yjsLastSequenceId) {
				throw new Error("Missing destination yjsLastSequenceId while advancing committed state");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", destNode.yjsLastSequenceId, { lastSequence: 1 });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Discard removes the proposal and keeps the saved file.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-committed-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the node when a rebase re-aligns the row base after a commit", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-rebase-source.md",
				name: "discard-copy-rebase-source.md",
				markdown: "# Rebase guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-rebase-dest.md",
				name: "discard-copy-rebase-dest.md",
				markdown: "# Rebase guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-rebase-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});

		// A remote edit lands before the client rebases the copied content.
		const remoteMarkdown = `${dest.baseMarkdown}\n\nRemote commit`;
		const remoteDiff = await t.run(async (ctx) =>
			build_file_diff_update_from_snapshot({
				ctx,
				nodeId: dest.nodeId,
				markdown: remoteMarkdown,
			}),
		);
		await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, dest.nodeId)).yjsLastSequenceId,
			update: remoteDiff,
			sessionId: "remote-session",
		});

		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				nodeId: dest.nodeId,
			}),
		);
		const latestBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const unstagedBranchYjsDoc = files_yjs_doc_clone({
			yjsDoc: latestBaseYjsDoc,
		});
		const unstagedBranchProjection = files_yjs_doc_update_from_text({
			rootKind: "rich_text",
			mut_yjsDoc: unstagedBranchYjsDoc,
			text: `${remoteMarkdown}\n\nCopied content`,
		});
		if (unstagedBranchProjection._nay) {
			throw new Error("Failed to build the rebased copy branch");
		}
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: dest.membershipId,
			nodeId: dest.nodeId,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: latestFileState.yjsUpdate,
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(persistResult._nay.message);
		}

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row?.content?.base).toMatchObject({ kind: "yjs", sequence: 1 });
			expect(row?.copiedFrom).toEqual({
				target: { kind: "saved", id: source.nodeId },
				path: "/discard-copy-rebase-source.md",
			});
		});

		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// Discard keeps the saved file after the copied content was rebased.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-rebase-dest.md");
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});

	test("keeps the node when another user has a pending row on it", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-otheruser-source.md",
				name: "discard-copy-otheruser-source.md",
				markdown: "# Other user guard source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-copy-otheruser-dest.md",
				name: "discard-copy-otheruser-dest.md",
				markdown: "# Other user guard dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/discard-copy-otheruser-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Another user drafts on the destination node; hard delete would destroy their draft.
		const otherUserRowId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: await ctx.db.insert("users", { clerkUserId: "other_user_pending_guard" }),
				target: { kind: "saved", id: dest.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-copy-otheruser-dest.md");
			const otherUserRow = await ctx.db.get("files_pending_updates", otherUserRowId);
			expect(otherUserRow).not.toBeNull();
			const proposerRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(proposerRow).toBeNull();
		});
	});

	test("keeps a saved node that another user renamed since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-saved-renamed-dest.md",
				name: "discard-saved-renamed-dest.md",
				markdown: "# Saved renamed base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing saved row before discard");
		}

		// Another member renames the saved file after the proposal.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_discard_saved_renamed_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			// Writing files needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return { otherUserId, otherMembershipId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const renamed = await test_rename_node(t, asOtherUser, {
			membershipId: other.otherMembershipId,
			nodeId: dest.nodeId,
			path: "discard-saved-renamed-by-other.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// The other user's rename must survive: keep the node, drop only the proposal row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-saved-renamed-by-other.md");
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id });
			expect(chunks).toHaveLength(0);
		});
	});

	test("keeps a saved node that another user moved with move_nodes since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-saved-moved-dest.md",
				name: "discard-saved-moved-dest.md",
				markdown: "# Saved moved base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing saved row before discard");
		}

		// Another member moves the saved file after the proposal.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_discard_saved_moved_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			// Writing files needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			const folderId = await seed_folder_node({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				path: "/discard-saved-moved-folder",
				name: "discard-saved-moved-folder",
			});
			return { otherUserId, otherMembershipId, folderId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const moved = await test_move_nodes(t, asOtherUser, {
				membershipId: other.otherMembershipId,
				itemIds: [dest.nodeId],
				targetParentId: other.folderId,
			});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_update, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (discarded._nay) {
			throw new Error(discarded._nay.message);
		}

		await t.run(async (ctx) => {
			// The other user's move must survive: keep the node, drop only the proposal row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/discard-saved-moved-folder/discard-saved-moved-dest.md");
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
		});
	});

	test("no-ops on content-only rows and keeps the content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/discard-content-src.md",
				name: "discard-content-src.md",
				markdown: "# Discard content base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nContent only`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		// No structural aspect on the row: the discard is an idempotent no-op success.
		const discarded = await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(discarded._nay).toBeUndefined();

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
	});
});

describe("structural rows on content collapse", () => {
	test("content collapse on a mixed row degrades it to a pure-move row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/degrade-mixed-src.md",
				name: "degrade-mixed-src.md",
				markdown: "# Degrade base",
			}),
		);
		const changedMarkdown = `${seeded.baseMarkdown}\n\nDegrade change`;
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "degrade-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		// Reverting the content to base would normally delete the row; the move must survive.
		const collapsed = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: seeded.baseMarkdown,
			unstagedMarkdown: seeded.baseMarkdown,
		});
		if (collapsed._nay) {
			throw new Error(collapsed._nay.message);
		}

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!row) {
				throw new Error("Expected a degraded pure-move row after content collapse");
			}
			expect(row.pendingMove?.destName).toBe("degrade-mixed-dest.md");
			expect(files_pending_update_has_yjs_content(row)).toBe(false);
			expect(row.size).toBe(0);
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: row._id });
			expect(chunks).toHaveLength(0);
			expect(row.expiresAt).toBe(row.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
			expect((await read_pending_update_expiry_check({ ctx, ...seeded }))?.nextCheckAt).toBeLessThanOrEqual(
				row.updatedAt + files_DRAFT_IDLE_EXPIRY_MS,
			);
		});
	});

	test.each([false, true])("content collapse keeps a delete when collaboration off is %s", async (nonCollaborative) => {
		const t = test_convex();
		const baseMarkdown = normalize_pending_update_markdown("# Delete base");
		const seeded = await t.run(async (ctx) =>
			nonCollaborative
				? seed_non_collaborative_file({ ctx, path: "/degrade-delete.md", text: baseMarkdown })
				: seed_file_with_markdown({
						ctx,
						path: "/degrade-delete.md",
						name: "degrade-delete.md",
						markdown: baseMarkdown,
					}),
		);
		const ids = {
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		};
		const upserted = await upsert_file_pending_update_internal_for_test({
			...ids,
			stagedMarkdown: baseMarkdown,
			unstagedMarkdown: `${baseMarkdown}\n\nAgent line`,
		});
		expect(upserted._nay).toBeUndefined();
		const archived = await upsert_file_pending_archive_for_test(ids);
		expect(archived._nay).toBeUndefined();
		const beforeCollapse = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(beforeCollapse?.content?.unstagedStateId).toBeDefined();

		// Discard all sends both branches back to the base. The delete still needs review.
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const collapsed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: baseMarkdown,
			unstagedMarkdown: baseMarkdown,
		});
		expect(collapsed._nay).toBeUndefined();
		await t.run(async (ctx) => {
			const pendingUpdate = await read_pending_update_row({ ctx, ...seeded });
			expect(pendingUpdate).not.toBeNull();
			expect(pendingUpdate?.pendingArchive).toEqual({ fromPath: "/degrade-delete.md" });
			expect(pendingUpdate?.content).toBeUndefined();
			expect(pendingUpdate?.size).toBe(0);
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingUpdate!._id })).toHaveLength(0);
			expect(pendingUpdate!.expiresAt).toBe(pendingUpdate!.updatedAt + files_DRAFT_IDLE_EXPIRY_MS);
			expect((await read_pending_update_expiry_check({ ctx, ...seeded }))?.nextCheckAt).toBeLessThanOrEqual(
				pendingUpdate!.updatedAt + files_DRAFT_IDLE_EXPIRY_MS,
			);
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.archiveOperationId).toBeNull();
		});
	});

	test("content collapse degrades a copy row with a move to a pure move", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/collapse-replace-source.md",
				name: "collapse-replace-source.md",
				markdown: "# Collapse replace source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/collapse-replace-dest.md",
				name: "collapse-replace-dest.md",
				markdown: "# Collapse replace dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/collapse-replace-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			destParentId: files_ROOT_ID,
			destName: "collapse-replace-renamed.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		// Reverting the copied content keeps only the pending move.
		const collapsed = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: dest.baseMarkdown,
			unstagedMarkdown: dest.baseMarkdown,
		});
		if (collapsed._nay) {
			throw new Error(collapsed._nay.message);
		}

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected the degraded pure-move row to survive the content collapse");
		}
		expect(row.copiedFrom).toBeUndefined();
		expect(row.pendingMove?.destName).toBe("collapse-replace-renamed.md");
		expect(files_pending_update_has_yjs_content(row)).toBe(false);
	});
});

describe("save with structural rows", () => {
	test("Save accepts a pure move without changing its content", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-move-src.md",
				name: "save-move-src.md",
				markdown: "# Save move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "save-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(saved._nay).toBeUndefined();

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row).toBeNull();
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/save-move-dest.md");
			expect(await read_file_markdown_from_yjs({ ctx, ...seeded })).toBe(seeded.baseMarkdown);
		});
	});

	test("full Save publishes mixed content and its move together", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-mixed-src.md",
				name: "save-mixed-src.md",
				markdown: "# Save mixed base",
			}),
		);
		const changedMarkdown = normalize_pending_update_markdown(`${seeded.baseMarkdown}\n\nSave mixed change`);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: changedMarkdown,
			unstagedMarkdown: changedMarkdown,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "save-mixed-dest.md",
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const pendingRow = await read_seeded_pending_row(t, seeded);
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const committedMarkdown = await t.run((ctx) =>
			read_file_markdown_from_yjs({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(committedMarkdown).toContain("Save mixed change");

		await t.run(async (ctx) => {
			const row = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			expect(row).toBeNull();
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id });
			expect(chunks).toHaveLength(0);
			expect((await ctx.db.get("files_nodes", seeded.nodeId))?.path).toBe("/save-mixed-dest.md");
		});
	});

	test("partial save clears copiedFrom and keeps the remaining content", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-copy-source.md",
				name: "save-copy-source.md",
				markdown: "# Save copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-copy-dest.md",
				name: "save-copy-dest.md",
				markdown: "# Save copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);

		// Staged stays at base while unstaged carries the copied content, so a save is partial.
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nCopied content`,
			copiedFrom: { nodeId: source.nodeId, path: "/save-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			}),
		);
		if (!row) {
			throw new Error("Expected the pending row to survive a partial save");
		}
		expect(row.copiedFrom).toBeUndefined();
		expect(files_pending_update_has_yjs_content(row)).toBe(true);
	});

	test("save onto an archived target publishes the content and settles the row", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-archived-target-source.md",
				name: "save-archived-target-source.md",
				markdown: "# Archived target source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/save-archived-target-dest.md",
				name: "save-archived-target-dest.md",
				markdown: "# Archived target dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const replacementMarkdown = normalize_pending_update_markdown(
			`${source.baseMarkdown}\n\nArchived target replacement`,
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			stagedMarkdown: replacementMarkdown,
			unstagedMarkdown: replacementMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/save-archived-target-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		// Any user archives the target file before the proposer accepts.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", dest.nodeId, { archiveOperationId: "archive-op-save-target" });
		});

		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: dest.userId,
			name: "Test User",
		});
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: dest.membershipId,
			target: { kind: "saved", id: dest.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: dest.membershipId,
				target: { kind: "saved", id: dest.nodeId },
			})),
		});
		if (saved._nay) {
			throw new Error(saved._nay.message);
		}
		expect(saved._yay.newSequence).not.toBeNull();

		await t.run(async (ctx) => {
			// The save published the proposal onto the still-archived node and settled the row;
			// unarchiving later shows the saved text.
			const destNode = await ctx.db.get("files_nodes", dest.nodeId);
			expect(destNode?.archiveOperationId).toBe("archive-op-save-target");
			const sourceNode = await ctx.db.get("files_nodes", source.nodeId);
			expect(sourceNode?.archiveOperationId).toBeNull();
			const committedMarkdown = await read_file_markdown_from_yjs({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				nodeId: dest.nodeId,
			});
			expect(committedMarkdown).toBe(replacementMarkdown);
			const row = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			expect(row).toBeNull();
		});
	});
});

describe("expire_file_pending_updates structural rows", () => {
	test("expiry keeps a saved node that another user renamed since the proposal", async () => {
		const t = test_convex();

		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-saved-renamed-dest.md",
				name: "expire-saved-renamed-dest.md",
				markdown: "# Expire saved renamed base",
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nWritten content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing saved row before expiry");
			}
			return pendingRow;
		});

		// Another member renames the saved file after the proposal.
		const other = await t.run(async (ctx) => {
			const otherUserId = await ctx.db.insert("users", {
				clerkUserId: "clerk_expire_saved_renamed_other",
			});
			const otherMembershipId = await ctx.db.insert("organizations_workspaces_users", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				active: true,
				pendingOrganizationRemoval: false,
				updatedAt: Date.now(),
			});
			// Writing files needs `content.write`, which comes from the member role.
			await ctx.db.insert("access_control_role_assignments", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: otherUserId,
				role: "member",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return { otherUserId, otherMembershipId };
		});
		const asOtherUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: other.otherUserId,
			name: "Other User",
		});
		const renamed = await test_rename_node(t, asOtherUser, {
			membershipId: other.otherMembershipId,
			nodeId: dest.nodeId,
			path: "expire-saved-renamed-by-other.md",
		});
		if (renamed._nay) {
			throw new Error(renamed._nay.message);
		}

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		await t.run(async (ctx) => {
			// The other user's rename must survive expiry: keep the node, drop only the row.
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/expire-saved-renamed-by-other.md");
			expect(node?.archiveOperationId).toBeNull();
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const chunks = await list_pending_update_text_chunks({ ctx, pendingUpdateId: pendingRow._id });
			expect(chunks).toHaveLength(0);
		});
	});

	test("expiry deletes a copy row but keeps the node", async () => {
		const t = test_convex();

		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-copy-source.md",
				name: "expire-copy-source.md",
				markdown: "# Expire copy source",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-copy-dest.md",
				name: "expire-copy-dest.md",
				markdown: "# Expire copy dest base",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nReplacement content`,
			copiedFrom: { nodeId: source.nodeId, path: "/expire-copy-source.md" },
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const pendingRow = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: dest.userId,
				nodeId: dest.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing copy row before expiry");
			}
			return pendingRow;
		});

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);

		await t.run(async (ctx) => {
			// The row expires like a plain content row; the pre-existing node is never hard-deleted.
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			expect(node?.path).toBe("/expire-copy-dest.md");
		});
	});

	test("expiry deletes a pure-move row but keeps the node", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/expire-move-src.md",
				name: "expire-move-src.md",
				markdown: "# Expire move base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "expire-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run(async (ctx) => {
			const pendingRow = await read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			});
			if (!pendingRow) {
				throw new Error("Missing pending move row before expiry");
			}
			return pendingRow;
		});

		// A check run before the draft's expiry must not delete the proposal.
		await t.mutation(internal.files_pending_updates.expire_file_pending_updates, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
		});
		const rowAfterStaleRun = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id));
		expect(rowAfterStaleRun).not.toBeNull();

		vi.useFakeTimers();
		await expire_pending_update_for_test(t, pendingRow._id);
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const node = await ctx.db.get("files_nodes", seeded.nodeId);
			expect(node?.path).toBe("/expire-move-src.md");
		});
	});
});

describe("reads behind a pure-move row", () => {
	test("committed content stays readable behind a pure-move row", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/read-move-src.md",
				name: "read-move-src.md",
				markdown: "# Read move base",
			}),
		);
		await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/read-move-src.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "read-move-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before reads");
		}

		// Chunk reads must fall through to the committed chunks, not return an empty pending view.
		const chunkRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/read-move-src.md",
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(chunkRead?.content).toBe(seeded.baseMarkdown);

		// The markdown state read returns the committed content but still reports the
		// structural row's id, so write_file/edit_file mix onto it.
		const markdownState = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/read-move-src.md",
		});
		expect(markdownState?.content).toBe(seeded.baseMarkdown);
		expect(markdownState?.pendingUpdateId).toBe(pendingRow._id);
	});
});

describe("pending path overlay reads", () => {
	test("get_by_path resolves through the proposer's pending move", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-src.md",
				name: "overlay-src.md",
				markdown: "# Overlay base",
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "overlay-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}

		// The claimed destination presents the moved node with its doc UNCHANGED.
		const atDest = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-dest.md",
			overlayUserId: seeded.userId,
		});
		expect(atDest?._id).toBe(seeded.nodeId);
		expect(atDest?.path).toBe("/overlay-src.md");

		// The vacated source reads as missing for the proposer.
		const atSource = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-src.md",
			overlayUserId: seeded.userId,
		});
		expect(atSource).toBeNull();

		// Without `overlayUserId` the committed lookup is unchanged (other users' view).
		const committedSource = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-src.md",
		});
		expect(committedSource?._id).toBe(seeded.nodeId);
		const committedDest = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-dest.md",
		});
		expect(committedDest).toBeNull();

		// Another user commits a rename of the source node and a newcomer file takes the old
		// path. The newcomer is untouched by the overlay, so it stays visible to the proposer.
		const newcomerNodeId = await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, {
				path: "/overlay-moved-away.md",
				treePath: "/overlay-moved-away.md",
				name: "overlay-moved-away.md",
			});
			return await ctx.db.insert("files_nodes", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				path: "/overlay-src.md",
				treePath: "/overlay-src.md",
				pathDepth: 1,
				lowercaseExtension: "md",
				name: "overlay-src.md",
				sortName: files_sort_text_key("overlay-src.md"),
				kind: "file",
				parentId: files_ROOT_ID,
				createdBy: seeded.userId,
				updatedBy: seeded.userId,
				updatedAt: Date.now(),
				contentType: null,
				assetId: null,
				contentByteSize: null,
				textKind: null,
				collaborationEnabled: null,
				yjsSnapshotId: null,
				yjsLastSequenceId: null,
				statsId: null,
				contentTooLargeByteSize: null,
				contentShapeMismatchAt: null,
				contentYjsStateTooLargeByteSize: null,
				contentFrontmatterTooLargeFieldCount: null,
				contentFrontmatterTooLargeIndexDocumentCount: null,
				restrictedScopeNodeId: null,
				isRestrictedScopeRoot: false,
				writePolicy: null,

				archiveOperationId: null,
				newChildWritePolicy: null,
			});
		});
		const newcomer = await t.query(internal.files_nodes.get_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			visibilityUserId: seeded.userId,
			path: "/overlay-src.md",
			overlayUserId: seeded.userId,
		});
		expect(newcomer?._id).toBe(newcomerNodeId);
	});

	test("content reads at the claimed destination serve the moved file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/overlay-content-src.md",
				name: "overlay-content-src.md",
				markdown: "# Overlay content base",
			}),
		);
		await t.run((ctx) =>
			seed_committed_chunks_for_file({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
				path: "/overlay-content-src.md",
				markdown: seeded.baseMarkdown,
			}),
		);
		const created = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: files_ROOT_ID,
			destName: "overlay-content-dest.md",
		});
		if (created._nay) {
			throw new Error(created._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending move row before reads");
		}

		// Chunk reads translate the claimed destination to the moved file's content.
		const chunkRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/overlay-content-dest.md",
			overlayUserId: seeded.userId,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(chunkRead?.target).toEqual({ kind: "saved", id: seeded.nodeId });
		expect(chunkRead?.content).toBe(seeded.baseMarkdown);

		// The markdown state read composes with the structural row: content resolves from the
		// committed tree and the row's id is still reported for mixing.
		const markdownState = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/overlay-content-dest.md",
			overlayUserId: seeded.userId,
		});
		expect(markdownState?.content).toBe(seeded.baseMarkdown);
		expect(markdownState?.pendingUpdateId).toBe(pendingRow._id);

		// The vacated source path serves nothing for the proposer.
		const vacatedRead = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			path: "/overlay-content-src.md",
			overlayUserId: seeded.userId,
			mode: { kind: "full", maxBytes: 100_000 },
		});
		expect(vacatedRead).toBeNull();
	});
});

// #region door 2 shape checks
describe("create_file_pending_update_operation_batch", () => {
	test("refuses an old batch after a new proposal reuses revision one", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/batch-replaced.md",
				name: "batch-replaced.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: seeded.userId, name: "Test User" });
		expect(
			(
				await upsert_file_pending_move_for_test({
					t,
					...seeded,
					destParentId: files_ROOT_ID,
					destName: "first-move.md",
				})
			)._nay,
		).toBeUndefined();
		const before = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		if (!before) throw new Error("Expected the first proposal");
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) throw new Error(batch._nay.message);
		expect(
			(
				await asUser.mutation(api.files_pending_updates.discard_file_pending_structural, {
					membershipId: seeded.membershipId,
					target: { kind: "saved", id: seeded.nodeId },
					...(await reviewed_pending_for_test(t, {
						membershipId: seeded.membershipId,
						target: { kind: "saved", id: seeded.nodeId },
					})),
				})
			)._nay,
		).toBeUndefined();
		expect(
			(
				await upsert_file_pending_move_for_test({
					t,
					...seeded,
					destParentId: files_ROOT_ID,
					destName: "second-move.md",
				})
			)._nay,
		).toBeUndefined();
		const after = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		expect(after?._id).not.toBe(before._id);
		expect(after?.revision).toBe(before.revision);
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			operationBatchId: batch._yay.operationBatchId,
			role: "unstaged",
			text: "old input",
		});
		expect(staged._nay?.name).toBe("target_changed");
		expect(await t.run((ctx) => ctx.db.query("files_pending_update_text_inputs").collect())).toEqual([]);
	});

	test("rejects sealed outputs after a same-time proposal change and keeps index revisions current", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/revision-base.md", text: "# Base" }),
		);
		r2Objects.set("content-snapshot/revision-base.md", "# Base");
		const proposed = await upsert_file_pending_update_internal_for_test({
			t,
			...seeded,
			unstagedMarkdown: "---\ntopic: draft\n---\n# Proposed",
		});
		if (proposed._nay) throw new Error(proposed._nay.message);
		const before = await read_seeded_pending_row(t, seeded);
		if (!before) throw new Error("Expected the proposal");
		const beforeIndexes = await t.run(async (ctx) => ({
			text: await list_pending_update_text_chunks({ ctx, pendingUpdateId: before._id }),
			plain: await list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: before._id }),
			metadata: await ctx.db
				.query("files_metadata_docs")
				.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", before._id))
				.collect(),
		}));
		const family = await seal_output_family_for_test(t, seeded);
		expect(
			await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", family.operationBatchId)),
		).toMatchObject({ target: before.target, expectedRevision: before.revision, expectedPrivateVersion: null });

		// Two writes can share a millisecond. The revision must still reject the old batch.
		vi.spyOn(Date, "now").mockReturnValue(before.updatedAt);
		const moved = await upsert_file_pending_move_for_test({
			t,
			...seeded,
			destParentId: files_ROOT_ID,
			destName: "revision-moved.md",
		});
		expect(moved._nay).toBeUndefined();
		const after = await read_seeded_pending_row(t, seeded);
		if (!after) throw new Error("Expected the moved proposal");
		expect(after.updatedAt).toBe(before.updatedAt);
		expect(after.revision).toBe(before.revision + 1);
		expect(after.content).toEqual(before.content);
		await t.run(async (ctx) => {
			for (const rows of Object.values(beforeIndexes)) {
				expect(rows.length).toBeGreaterThan(0);
			}
			expect(await list_pending_update_text_chunks({ ctx, pendingUpdateId: before._id })).toEqual(
				beforeIndexes.text.map((row) => ({ ...row, proposalRevision: after.revision })),
			);
			expect(await list_pending_update_plain_text_chunks({ ctx, pendingUpdateId: before._id })).toEqual(
				beforeIndexes.plain.map((row) => ({ ...row, proposalRevision: after.revision })),
			);
			expect(
				await ctx.db
					.query("files_metadata_docs")
					.withIndex("by_pendingUpdate_fieldPath", (q) => q.eq("pendingUpdateId", before._id))
					.collect(),
			).toEqual(beforeIndexes.metadata.map((row) => ({ ...row, proposalRevision: after.revision })));
		});

		const committed = await t.mutation(internal.files_pending_updates.commit_file_pending_update_upsert_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			pendingUpdateId: before._id,
			operationBatchId: family.operationBatchId,
			expectedRevision: before.revision,
			base: { kind: "asset", expectedAssetId: seeded.assetId },
			baseStateId: family.base.stateId,
			stagedStateId: family.staged.stateId,
			unstagedStateId: family.unstaged.stateId,
			baseStateDigest: family.base.digest,
			stagedStateDigest: family.staged.digest,
			unstagedStateDigest: family.unstaged.digest,
			unstagedText: "old output",
			unstagedBranchChanged: true,
		});
		expect(committed._nay?.name).toBe("target_changed");
		expect(await read_seeded_pending_row(t, seeded)).toEqual(after);
		expect(await t.run((ctx) => ctx.db.get("files_pending_update_yjs_states", family.base.stateId))).toMatchObject({
			owner: { kind: "temporary", operationBatchId: family.operationBatchId },
		});
		await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId: family.operationBatchId,
		});
	});

	test.each(["creationGeneration", "structuralRevision", "state"] as const)(
		"refuses more private text after %s changes",
		async (field) => {
			const t = test_convex();
			const seeded = await t.run(async (ctx) => {
				const membership = await test_mocks_fill_db_with.membership(ctx);
				const { organizationId, workspaceId, userId } = membership;
				const nodeId = await ctx.db.insert("files_pending_nodes", {
					organizationId,
					workspaceId,
					userId,
					kind: "file",
					name: "private.txt",
					parent: { kind: "root" },
					creationGeneration: 1,
					structuralRevision: 1,
					state: "active",
					closedAt: null,
				});
				const pendingUpdateId = await ctx.db.insert("files_pending_updates", {
					organizationId,
					workspaceId,
					userId,
					target: { kind: "private", id: nodeId },
					revision: 1,
					size: 0,
					updatedAt: Date.now(),
					expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
				});
				const operationBatchId = await ctx.db.insert("files_pending_update_operation_batches", {
					organizationId,
					workspaceId,
					userId,
					target: { kind: "private", id: nodeId },
					expectedPendingUpdateId: pendingUpdateId,
					expectedRevision: 1,
					expectedPrivateVersion: { creationGeneration: 1, structuralRevision: 1 },
					expiresAt: Date.now() + 60_000,
					updatedAt: Date.now(),
					lastActivityAt: Date.now(),
				});
				await ctx.db.patch(
					"files_pending_nodes",
					nodeId,
					field === "state" ? { state: "discarded", closedAt: Date.now() } : { [field]: 2 },
				);
				return { organizationId, workspaceId, userId, operationBatchId };
			});
			const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
				...seeded,
				role: "unstaged",
				text: "late text",
			});
			expect(staged._nay?.name).toBe("target_changed");
			expect(await t.run((ctx) => ctx.db.query("files_pending_update_text_inputs").collect())).toEqual([]);
		},
	);

	test("refuses a second batch while one is already active for the same user and file", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-batch-admission",
				name: "pending-batch-admission",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(first._nay).toBeUndefined();

		// Two interleaved operations on one proposal would tear each other's staging, so the
		// second admission is a visible refusal instead of a silent queue.
		const second = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(second._nay?.message).toBe("A pending update operation for this file is already in progress");
	});

	test("takes over the same user's batch once it sits idle past the takeover window", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-batch-takeover",
				name: "pending-batch-takeover",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		const firstBatchId = first._yay.operationBatchId;

		// A crashed client stages nothing, so only time passes. Age the liveness stamp past the
		// takeover window instead of waiting.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_pending_update_operation_batches", firstBatchId, {
				lastActivityAt: Date.now() - 3 * 60 * 1000,
			});
		});

		const second = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(second._nay).toBeUndefined();

		// The idle batch was retired by the takeover, not left active beside the new one.
		const firstBatch = await t.run(async (ctx) => ctx.db.get("files_pending_update_operation_batches", firstBatchId));
		expect(firstBatch?.expiresAt).toBe(0);
	});

	test("staging activity refreshes the liveness stamp, so an active client's batch is not taken over", async () => {
		const t = test_convex();

		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-batch-active",
				name: "pending-batch-active",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const first = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (first._nay) {
			throw new Error(first._nay.message);
		}
		const firstBatchId = first._yay.operationBatchId;

		// The batch looks idle, but the client then stages a text input, which refreshes the
		// liveness stamp.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_pending_update_operation_batches", firstBatchId, {
				lastActivityAt: Date.now() - 3 * 60 * 1000,
			});
		});
		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			operationBatchId: firstBatchId,
			role: "unstaged",
			text: "# Still typing",
		});
		if (staged._nay) {
			throw new Error(staged._nay.message);
		}

		const second = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(second._nay?.message).toBe("A pending update operation for this file is already in progress");
	});
});

describe("pending update state seal door 2", () => {
	function encode_doc(build: (yjsDoc: YDoc) => void) {
		const yjsDoc = new YDoc();
		yjsDoc.transact(() => build(yjsDoc));
		return files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc));
	}

	async function seed_plain_text_pending_fixture(t: ReturnType<typeof test_convex>, path: string) {
		return await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path,
				name: path.slice(1),
				markdown: "",
				rootKind: "plain_text",
			}),
		);
	}

	// Control 8's named assertion: door 2 must NOT run door 1's content whitelist. A plain-text
	// document that also carries a real Tiptap `default` root encodes ContentType structs, so
	// the whitelist would refuse it forever — while parity on the plain root answers allow.
	test("accepts a branch state whose plain-text root is intact but which also carries a default root, and the pending row is patched", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-both-roots");
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Door 2 Both Roots User",
		});

		// Create the pending row through the real flow first: the rebase commit is update-only.
		const initialUpsert = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: "line one\nline two\n",
			unstagedMarkdown: "line one\nline two\n",
		});
		if (initialUpsert._nay) {
			throw new Error(initialUpsert._nay.message);
		}
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing pending row before the both-roots rebase");
		}

		// The both-roots branches: real content under plain_text, a stale tab's Tiptap paragraph
		// beside it. The client base is a clone of the live state.
		const latestFileState = await t.run(async (ctx) =>
			read_file_yjs_state({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				nodeId: seeded.nodeId,
			}),
		);
		const liveBaseYjsDoc = files_yjs_doc_create_from_array_buffer_update(latestFileState.yjsUpdate);
		const stagedBranchYjsDoc = files_yjs_doc_clone({ yjsDoc: liveBaseYjsDoc });
		stagedBranchYjsDoc.transact(() => {
			stagedBranchYjsDoc.getText("plain_text").insert(0, "line one\nline two\n");
			stagedBranchYjsDoc.getXmlFragment("default").insert(0, [new YXmlElement("paragraph")]);
		});
		const unstagedBranchYjsDoc = files_yjs_doc_clone({ yjsDoc: liveBaseYjsDoc });
		unstagedBranchYjsDoc.transact(() => {
			unstagedBranchYjsDoc.getText("plain_text").insert(0, "line one\nline two\nline three\n");
			unstagedBranchYjsDoc.getXmlFragment("default").insert(0, [new YXmlElement("paragraph")]);
		});

		// Door 2 runs at the seal inside this helper: all three states must be accepted.
		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			baseYjsSequence: latestFileState.yjsSequence,
			baseYjsUpdate: latestFileState.yjsUpdate,
			stagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(stagedBranchYjsDoc)),
			unstagedBranchYjsUpdate: files_u8_to_array_buffer(encodeStateAsUpdate(unstagedBranchYjsDoc)),
		});
		if (persistResult._nay) {
			throw new Error(`Expected door 2 to accept the both-roots branch: ${persistResult._nay.message}`);
		}
		if (!persistResult._yay || !("pendingUpdate" in persistResult._yay)) {
			throw new Error("Expected the rebase action result while testing the both-roots branch");
		}
		expect(persistResult._yay.pendingUpdate).not.toBeNull();

		// Save projects only the file's plain text onto the live document.
		const saveResult = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: pendingRow._id,
			})),
			pendingUpdateId: pendingRow._id,
		});
		expect(saveResult._nay).toBeUndefined();
		const savedState = await t.run((ctx) => read_file_yjs_state({ ctx, ...seeded }));
		const savedDoc = files_yjs_doc_create_from_array_buffer_update(savedState.yjsUpdate);
		expect(savedDoc.getText("plain_text").toString()).toBe("line one\nline two\n");
		expect(savedDoc.getXmlFragment("default").length).toBe(0);
		savedDoc.destroy();
		const remaining = await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }));
		if (!remaining) throw new Error("Expected the unaccepted third line");
		expect(
			await t.run((ctx) => read_pending_row_markdown_state({ ctx, pendingUpdate: remaining, rootKind: "plain_text" })),
		).toEqual({
			baseMarkdown: "line one\nline two\n",
			stagedMarkdown: "line one\nline two\n",
			unstagedMarkdown: "line one\nline two\nline three\n",
		});

		const discardResult = await asUser.mutation(api.files_pending_updates.discard_file_pending_content, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
				pendingUpdateId: pendingRow._id,
			})),
			pendingUpdateId: pendingRow._id,
		});
		expect(discardResult._nay).toBeUndefined();
	});

	test("refuses a branch state whose plain root is a Y.Map at the seal, before any write", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-map-root");
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Door 2 Map Root User",
		});

		// Parity is vacuously true on this state (a map's content is invisible to toString and
		// length); only the root-scoped `_map.size === 0` line refuses it. The refusal happens at
		// the first (base) seal, so no pending row and no canonical state is ever written.
		const mapRootState = encode_doc((d) => {
			d.getMap("plain_text").set("k", "v");
		});

		const persistResult = await persist_file_pending_update_rebased_state_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			baseYjsSequence: 0,
			baseYjsUpdate: mapRootState,
			stagedBranchYjsUpdate: mapRootState,
			unstagedBranchYjsUpdate: mapRootState,
		});
		expect(persistResult._nay?.message).toBe("Update does not match the file shape");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row).toBeNull();
	});

	test("refuses malformed, V2-encoded, and zero-byte states with their named messages", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-encodings");
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Door 2 Encoding User",
		});
		const legalState = encode_doc((d) => {
			d.getText("plain_text").insert(0, "legal");
		});

		const persist_with_unstaged = async (unstaged: ArrayBuffer) =>
			await persist_file_pending_update_rebased_state_for_test(asUser, {
				membershipId: seeded.membershipId,
				nodeId: seeded.nodeId,
				baseYjsSequence: 0,
				baseYjsUpdate: legalState,
				stagedBranchYjsUpdate: legalState,
				unstagedBranchYjsUpdate: unstaged,
			});

		const v2Doc = new YDoc();
		v2Doc.getText("plain_text").insert(0, "v2");
		expect((await persist_with_unstaged(files_u8_to_array_buffer(encodeStateAsUpdateV2(v2Doc))))._nay?.message).toBe(
			"Unsupported update encoding",
		);
		expect((await persist_with_unstaged(files_u8_to_array_buffer(new Uint8Array([255, 255, 255]))))._nay?.message).toBe(
			"Malformed update",
		);
		// Zero bytes must be a refusal, never a crash. The paged pipeline refuses it twice over:
		// a zero-byte page cannot be staged, and a role with no staged pages cannot be sealed
		// (the helper stages no page for zero bytes, so its seal finds no state).
		expect((await persist_with_unstaged(files_u8_to_array_buffer(new Uint8Array(0))))._nay?.message).toBe("Not found");
		const emptyPage = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (emptyPage._nay) {
			throw new Error(emptyPage._nay.message);
		}
		const stagedEmptyPage = await asUser.mutation(api.files_pending_updates.stage_file_pending_update_state_page, {
			membershipId: seeded.membershipId,
			operationBatchId: emptyPage._yay.operationBatchId,
			role: "unstaged",
			pageIndex: 0,
			bytes: files_u8_to_array_buffer(new Uint8Array(0)),
		});
		expect(stagedEmptyPage._nay?.message).toBe("Empty state page");
	});

	test("refuses a state page over the wire cap before any page insert", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-page-cap");

		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}

		const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_state_page_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			operationBatchId: batch._yay.operationBatchId,
			phase: "input",
			role: "unstaged",
			pageIndex: 0,
			bytes: files_u8_to_array_buffer(new Uint8Array(files_MAX_YJS_WIRE_BYTES + 1)),
		});
		expect(staged._nay?.message).toBe(`State page exceeds ${files_MAX_YJS_WIRE_BYTES}-byte limit`);

		// The cap runs before the insert: no page row was written.
		const pages = await t.run(async (ctx) => ctx.db.query("files_pending_update_yjs_state_pages").collect());
		expect(pages).toHaveLength(0);
	});

	test("seals a legal multi-page tombstone-heavy state and refuses one over the 4 MiB cap", async () => {
		const t = test_convex();
		const seeded = await seed_plain_text_pending_fixture(t, "/door2-state-caps");

		// A legal state can be far larger than its visible text: a gc-disabled client doc keeps
		// deleted characters in its encoded state, so the size rule must come from the state
		// bytes, never the visible text.
		function tombstone_heavy_state(args: { cycles: number; cycleChars: number }) {
			const yjsDoc = new YDoc({ gc: false });
			const ytext = yjsDoc.getText("plain_text");
			for (let i = 0; i < args.cycles; i++) {
				ytext.insert(0, "a".repeat(args.cycleChars));
				ytext.delete(0, args.cycleChars);
			}
			ytext.insert(0, "kept\n");
			return files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc));
		}

		// One batch for both roles (one active batch per user/node): the legal state seals under
		// the "unstaged" role, the over-cap one refuses under "staged".
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		const operationBatchId = batch._yay.operationBatchId;

		async function stage_and_seal(role: "staged" | "unstaged", state: ArrayBuffer) {
			const bytes = new Uint8Array(state);
			for (let pageIndex = 0; pageIndex * files_MAX_YJS_WIRE_BYTES < bytes.byteLength; pageIndex++) {
				const pageStart = pageIndex * files_MAX_YJS_WIRE_BYTES;
				const staged = await t.mutation(internal.files_pending_updates.stage_file_pending_update_state_page_internal, {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					operationBatchId,
					phase: "input",
					role,
					pageIndex,
					bytes: files_u8_to_array_buffer(bytes.slice(pageStart, pageStart + files_MAX_YJS_WIRE_BYTES)),
				});
				if (staged._nay) {
					throw new Error(staged._nay.message);
				}
			}
			return await t.mutation(internal.files_pending_updates.seal_file_pending_update_state_internal, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				operationBatchId,
				phase: "input",
				role,
				expectedTotalBytes: state.byteLength,
			});
		}

		// ~3.16 MB across four pages (the plan's round-13 legal full state, approximated): seals.
		const legalState = tombstone_heavy_state({ cycles: 4, cycleChars: 790_000 });
		expect(legalState.byteLength).toBeGreaterThan(2 * files_MAX_YJS_WIRE_BYTES);
		expect(legalState.byteLength).toBeLessThan(files_MAX_YJS_RECONSTRUCTED_STATE_BYTES);
		const legalSealed = await stage_and_seal("unstaged", legalState);
		expect(legalSealed._nay).toBeUndefined();
		if (legalSealed._nay) {
			throw new Error(legalSealed._nay.message);
		}
		const sealedStateDoc = await t.run(async (ctx) =>
			ctx.db.get("files_pending_update_yjs_states", legalSealed._yay.stateId),
		);
		expect(sealedStateDoc).toMatchObject({ sealed: true, totalBytes: legalState.byteLength, pageCount: 4 });

		// One past 4 MiB: the seal refuses on the recorded byte total.
		const overState = tombstone_heavy_state({ cycles: 5, cycleChars: 850_000 });
		expect(overState.byteLength).toBeGreaterThan(files_MAX_YJS_RECONSTRUCTED_STATE_BYTES);
		const overSealed = await stage_and_seal("staged", overState);
		expect(overSealed._nay?.message).toBe(`State exceeds ${files_MAX_YJS_RECONSTRUCTED_STATE_BYTES}-byte limit`);
	});
});
// #endregion door 2 shape checks

// #region pending state TTL sweep
describe("cleanup_expired_pending_state_rows", () => {
	async function seed_state_family(args: {
		t: ReturnType<typeof test_convex>;
		seeded: {
			organizationId: Id<"organizations">;
			workspaceId: Id<"organizations_workspaces">;
			userId: Id<"users">;
			nodeId: Id<"files_nodes">;
		};
		owner:
			| { kind: "active"; pendingUpdateId: Id<"files_pending_updates">; role: "base" }
			| {
					kind: "temporary";
					operationBatchId: Id<"files_pending_update_operation_batches">;
					phase: "input";
					role: "base";
					expiresAt: number;
			  }
			| { kind: "retired"; cleanupTaskId: Id<"files_pending_update_state_cleanup_tasks"> };
		pageCount?: number;
	}) {
		const { t, seeded, pageCount = 1, owner } = args;

		return await t.run(async (ctx) => {
			const stateId = await ctx.db.insert("files_pending_update_yjs_states", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				owner,
				lineageGeneration: 0,
				sealed: true,
				pageCount,
				totalBytes: pageCount * 2,
				digest: "test-digest",
			});
			expect(
				(
					await files_private_storage_db_reserve(ctx, {
						...seeded,
						resource: { kind: "state", id: stateId },
						byteCount: pageCount * 2,
					})
				)._nay,
			).toBeUndefined();
			for (let pageIndex = 0; pageIndex < pageCount; pageIndex++)
				await ctx.db.insert("files_pending_update_yjs_state_pages", {
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					stateId,
					pageIndex,
					bytes: files_u8_to_array_buffer(new Uint8Array([0, 0])),
				});
			return stateId;
		});
	}

	test("keeps the full byte charge until the last page is deleted across bounded passes", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-pages.md", name: "sweep-pages.md", markdown: "# Sweep" }),
		);
		const now = Date.now();
		const operationBatchId = await t.run((ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: null,
				expectedRevision: null,
				expectedPrivateVersion: null,
				expiresAt: now - 1000,
				lastActivityAt: now - 1000,
				updatedAt: now - 1000,
			}),
		);
		const stateIds: Id<"files_pending_update_yjs_states">[] = [];
		for (let index = 0; index < 2; index++)
			stateIds.push(
				await seed_state_family({
					t,
					seeded,
					owner: { kind: "temporary", operationBatchId, phase: "input", role: "base", expiresAt: now - 1000 },
					pageCount: 5,
				}),
			);
		const first = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(first.done).toBe(false);
		const remaining = await t.run(async (ctx) => ({
			pages: await ctx.db.query("files_pending_update_yjs_state_pages").collect(),
			states: await ctx.db.query("files_pending_update_yjs_states").collect(),
			holds: await ctx.db.query("files_private_storage_reservations").collect(),
		}));
		expect(remaining.pages).toHaveLength(4);
		expect(remaining.states).toHaveLength(1);
		expect(remaining.states[0]?.totalBytes).toBe(10);
		expect(remaining.holds.find((hold) => hold.resource.id === remaining.states[0]?._id)).toMatchObject({
			byteCount: 10,
			settlement: { kind: "held" },
		});
		const second = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(second.done).toBe(true);
		await t.run(async (ctx) => {
			expect(await ctx.db.query("files_pending_update_yjs_state_pages").collect()).toEqual([]);
			expect(await ctx.db.query("files_pending_update_yjs_states").collect()).toEqual([]);
			expect(await ctx.db.get("files_pending_update_operation_batches", operationBatchId)).toBeNull();
			const holds = await ctx.db.query("files_private_storage_reservations").collect();
			for (const id of stateIds)
				expect(holds.find((hold) => hold.resource.id === id)).toMatchObject({
					byteCount: 10,
					settlement: { kind: "deleted" },
				});
		});
	});

	test("sweeps expired temporary families but never active ones (the gte(0) lower bound)", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-bounds", name: "sweep-bounds", markdown: "# Sweep" }),
		);
		const now = Date.now();

		const pendingUpdateId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				revision: 1,
				size: 0,
				updatedAt: now,
				expiresAt: now + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);
		const batchId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: pendingUpdateId,
				expectedRevision: 1,
				expectedPrivateVersion: null,
				expiresAt: now - 1000,
				lastActivityAt: now - 1000,
				updatedAt: now - 1000,
			}),
		);

		// Docs without `owner.expiresAt` sort BEFORE every number on the index: without the
		// gte(0) lower bound the sweep would also return (and delete) this active family.
		const activeStateId = await seed_state_family({
			t,
			seeded,
			owner: {
				kind: "active",
				pendingUpdateId,
				role: "base",
			},
		});
		const expiredTemporaryStateId = await seed_state_family({
			t,
			seeded,
			owner: {
				kind: "temporary",
				operationBatchId: batchId,
				phase: "input",
				role: "base",
				expiresAt: now - 1000,
			},
		});

		const swept = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(swept.deletedCount).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_update_yjs_states", activeStateId)).not.toBeNull();
			expect(await ctx.db.get("files_pending_update_yjs_states", expiredTemporaryStateId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_operation_batches", batchId)).toBeNull();
		});
	});

	test("expired operation batches take their text inputs and temporary families with them", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-batches", name: "sweep-batches", markdown: "# Sweep" }),
		);
		const now = Date.now();
		const expiredBatchId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: null,
				expectedRevision: null,
				expectedPrivateVersion: null,
				expiresAt: now - 1000,
				lastActivityAt: now - 1000,
				updatedAt: now - 1000,
			}),
		);
		const liveBatchId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_operation_batches", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				expectedPendingUpdateId: null,
				expectedRevision: null,
				expectedPrivateVersion: null,
				expiresAt: now + 30 * 60 * 1000,
				lastActivityAt: now,
				updatedAt: now,
			}),
		);
		const expiredTextInputId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_text_inputs", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				target: { kind: "saved", id: seeded.nodeId },
				operationBatchId: expiredBatchId,
				role: "staged",
				text: "staged text",
				expiresAt: now - 1000,
			}),
		);
		const expiredStageId = await t.run(async (ctx) =>
			ctx.db.insert("files_yjs_trusted_update_stages", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				fileNodeId: seeded.nodeId,
				kind: "pending_accept",
				update: files_u8_to_array_buffer(new Uint8Array([0, 0])),
				expiresAt: now - 1000,
			}),
		);
		await t.run(async (ctx) => {
			expect(
				(
					await files_private_storage_db_reserve(ctx, {
						...seeded,
						resource: { kind: "text_input", id: expiredTextInputId },
						byteCount: files_get_utf8_byte_size("staged text"),
					})
				)._nay,
			).toBeUndefined();
			expect(
				(
					await files_private_storage_db_reserve(ctx, {
						...seeded,
						resource: { kind: "trusted_stage", id: expiredStageId },
						byteCount: 2,
					})
				)._nay,
			).toBeUndefined();
		});

		const swept = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(swept.deletedCount).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_update_operation_batches", expiredBatchId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_operation_batches", liveBatchId)).not.toBeNull();
			expect(await ctx.db.get("files_pending_update_text_inputs", expiredTextInputId)).toBeNull();
			expect(await ctx.db.get("files_yjs_trusted_update_stages", expiredStageId)).toBeNull();
		});
	});

	test("drains retired cleanup tasks and tolerates a task whose states were already deleted", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({ ctx, path: "/sweep-tasks", name: "sweep-tasks", markdown: "# Sweep" }),
		);
		const now = Date.now();

		// A task whose states user-deletion already removed: the drain must still delete the
		// task doc instead of keeping it forever as a false signal of pending work.
		const drainedTaskId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_state_cleanup_tasks", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				createdAt: now,
			}),
		);
		// A task that still owns a family: the drain deletes states, pages, then the task.
		const ownedTaskId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_update_state_cleanup_tasks", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				createdAt: now,
			}),
		);
		const retiredStateId = await seed_state_family({
			t,
			seeded,
			owner: {
				kind: "retired",
				cleanupTaskId: ownedTaskId,
			},
		});

		const swept = await t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_now: now,
			_test_disableReschedule: true,
		});
		expect(swept.deletedCount).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_update_state_cleanup_tasks", drainedTaskId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_state_cleanup_tasks", ownedTaskId)).toBeNull();
			expect(await ctx.db.get("files_pending_update_yjs_states", retiredStateId)).toBeNull();
		});
	});
});
// #endregion pending state TTL sweep

describe("pending update read-only checks", () => {
	test("a locked target refuses a new content proposal without creating a row", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-proposal.md",
				name: "pending-read-only-proposal.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only proposal user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a proposal survives a lock and accepts after unlock", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-durable.md",
				name: "pending-read-only-durable.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only durable user",
		});
		const proposedMarkdown = "# Accepted after unlock";
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: proposedMarkdown,
			unstagedMarkdown: proposedMarkdown,
		});
		expect(proposed._nay).toBeUndefined();
		const pendingBeforeLock = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingBeforeLock) {
			throw new Error("Missing proposal before lock");
		}

		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		const refused = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("read_only");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingBeforeLock._id))).not.toBeNull();

		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		const accepted = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(accepted._nay).toBeUndefined();
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", pendingBeforeLock._id))).toBeNull();
		expect(
			await t.run((ctx) =>
				read_file_markdown_from_yjs({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			),
		).toContain("Accepted after unlock");
	});

	test("a lock and unlock before the no-change final mutation still settles the batch", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-final-barrier.md",
				name: "pending-read-only-final-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only final barrier user",
		});
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		const settled = await t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			expectedRevision: null,
		});
		expect(settled._nay).toBeUndefined();
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", batch._yay.operationBatchId)))
				?.expiresAt,
		).toBe(0);
	});

	test("a no-change settle that read no doc leaves a doc that appeared since then", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-no-change-late-doc.md",
				name: "pending-no-change-late-doc.md",
				markdown: "# Base",
			}),
		);

		// The action read no doc. A concurrent write made one before the settle ran.
		const lateDoc = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Base\n\nLate doc",
		});
		if (lateDoc._nay) {
			throw new Error(lateDoc._nay.message);
		}
		const lateRow = await t.run(async (ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!lateRow) {
			throw new Error("expected the late doc to exist");
		}

		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		const settled = await t.mutation(internal.files_pending_updates.settle_file_pending_update_no_change_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			expectedRevision: null,
		});
		expect(settled._nay?.message).toBe("Pending update changed, retry the write");
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", lateRow._id))).toEqual(lateRow);
	});

	test("a lock before the no-change final mutation refuses and retires the batch", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-no-change-gap.md",
				name: "pending-read-only-no-change-gap.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only no-change gap user",
		});
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		const operationBatchId = batch._yay.operationBatchId;
		const staged = await asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
			membershipId: seeded.membershipId,
			operationBatchId,
			role: "unstaged",
			text: seeded.baseMarkdown,
		});
		if (staged._nay) {
			throw new Error(staged._nay.message);
		}

		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const proposing = asUser.action(api.ai_chat.upsert_file_pending_update, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			operationBatchId,
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		releaseSnapshotFetch?.();
		const refused = await proposing;
		expect(refused._nay?.name).toBe("read_only");
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", operationBatchId)))?.expiresAt,
		).toBe(0);
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock and unlock before the refresh final mutation still refreshes the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-refresh-barrier.md",
				name: "pending-read-only-refresh-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only refresh barrier user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing proposal before refresh barrier");
		}
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		const refreshed = await t.mutation(internal.files_pending_updates.refresh_file_pending_update_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			pendingUpdateId: pendingRow._id,
			expectedRevision: pendingRow.revision,
		});
		expect(refreshed._nay).toBeUndefined();

		const rowAfter = await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id));
		expect(rowAfter?.updatedAt).toBeGreaterThan(pendingRow.updatedAt);
		expect(
			(await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", batch._yay.operationBatchId)))
				?.expiresAt,
		).toBe(0);
	});

	test("a lock and unlock in the save action gap still saves the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-save-gap.md",
				name: "pending-read-only-save-gap.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only save gap user",
		});
		const proposalText = "# Save gap proposal";
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: proposalText,
			unstagedMarkdown: proposalText,
		});
		expect(proposed._nay).toBeUndefined();
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing proposal before save gap");
		}

		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const saving = test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		releaseSnapshotFetch?.();
		const saved = await saving;
		expect(saved._nay).toBeUndefined();
		expect(saved._yay?.newSequence).toBeGreaterThan(0);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_updates", pendingRow._id)).toBeNull();
			const trustedStages = await ctx.db
				.query("files_yjs_trusted_update_stages")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.collect();
			expect(trustedStages).toEqual([]);
			const lastSaved = await ctx.db
				.query("files_pending_updates_last_sequence_saved")
				.withIndex("by_organization_workspace_user_fileNode", (q) =>
					q
						.eq("organizationId", seeded.organizationId)
						.eq("workspaceId", seeded.workspaceId)
						.eq("userId", seeded.userId)
						.eq("fileNodeId", seeded.nodeId),
				)
				.first();
			expect(lastSaved?.lastSequenceSaved).toBe(saved._yay?.newSequence);
			expect(
				await read_file_markdown_from_yjs({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			).toContain("Save gap proposal");
		});
	});

	test("a lock and unlock before the rebase final mutation still rebases the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-rebase-final.md",
				name: "pending-read-only-rebase-final.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only rebase user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
		const [pendingRow, fileState] = await Promise.all([
			t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
			t.run((ctx) =>
				read_file_yjs_state({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			),
		]);
		if (!pendingRow) {
			throw new Error("Missing proposal before rebase final");
		}
		const staged = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: fileState.yjsUpdate,
			stagedBranchYjsUpdate: fileState.yjsUpdate,
			unstagedBranchYjsUpdate: fileState.yjsUpdate,
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		const rebased = await asUser.mutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			operationBatchId: staged.operationBatchId,
			expectedRevision: pendingRow.revision,
			base: {
				kind: "yjs",
				baseYjsSequence: fileState.yjsSequence,
				baseLineageGeneration: 0,
				expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			},
			baseStateId: staged.base.stateId,
			stagedStateId: staged.staged.stateId,
			unstagedStateId: staged.unstaged.stateId,
			baseStateDigest: staged.base.digest,
			stagedStateDigest: staged.staged.digest,
			unstagedStateDigest: staged.unstaged.digest,
			unstagedText: seeded.baseMarkdown,
		});
		expect(rebased._nay).toBeUndefined();
		expect(rebased._yay?.pendingUpdate?._id).toBe(pendingRow._id);
		expect(rebased._yay?.pendingUpdate?.updatedAt).toBeGreaterThan(pendingRow.updatedAt);
		expect(
			await t.run((ctx) => ctx.db.get("files_pending_update_operation_batches", staged.operationBatchId)),
		).toBeNull();
	});

	test("a locked copy source stays readable", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-copy-source.md",
				name: "pending-read-only-copy-source.md",
				markdown: "# Source",
			}),
		);
		const copyDest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-copy-dest.md",
				name: "pending-read-only-copy-dest.md",
				markdown: "# Destination",
				membership: source,
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: source.userId,
			name: "Read-only copy user",
		});
		await set_pending_test_read_only({ asUser, membershipId: source.membershipId, nodeId: source.nodeId });

		// A copy only reads the source, so the source's lock does not stop it.
		const copied = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: copyDest.nodeId,
			unstagedMarkdown: source.baseMarkdown,
			copiedFrom: { nodeId: source.nodeId, path: "/pending-read-only-copy-source.md" },
		});
		expect(copied._nay).toBeUndefined();
	});

	test("a locked move participant refuses proposal, while a durable move accepts after unlock", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-source.md",
				name: "pending-read-only-move-source.md",
				markdown: "# Source",
			}),
		);
		const occupant = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-occupant.md",
				name: "pending-read-only-move-occupant.md",
				markdown: "# Occupant",
				membership: source,
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: source.userId,
			name: "Read-only move user",
		});
		await set_pending_test_read_only({ asUser, membershipId: source.membershipId, nodeId: occupant.nodeId });
		const blockedReplacement = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-occupant.md",
			replace: true,
		});
		expect(blockedReplacement._nay?.name).toBe("read_only");
		await set_pending_test_writable({ asUser, membershipId: source.membershipId, nodeId: occupant.nodeId });

		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-moved.md",
		});
		expect(proposed._nay).toBeUndefined();
		await set_pending_test_read_only({ asUser, membershipId: source.membershipId, nodeId: source.nodeId });
		const refused = await test_apply_file_pending_move(asUser, {
			membershipId: source.membershipId,
			target: { kind: "saved", id: source.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: source.membershipId,
				target: { kind: "saved", id: source.nodeId },
			})),
		});
		expect(refused._nay?.name).toBe("read_only");
		await set_pending_test_writable({ asUser, membershipId: source.membershipId, nodeId: source.nodeId });
		const accepted = await test_apply_file_pending_move(asUser, {
			membershipId: source.membershipId,
			target: { kind: "saved", id: source.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: source.membershipId,
				target: { kind: "saved", id: source.nodeId },
			})),
		});
		expect(accepted._nay).toBeUndefined();
		expect((await t.run((ctx) => ctx.db.get("files_nodes", source.nodeId)))?.path).toBe("/pending-read-only-moved.md");
	});

	test("a locked descendant refuses a folder archive proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const folderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-archive-folder",
				name: "pending-read-only-archive-folder",
			});
			const child = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-folder/child.md",
				name: "child.md",
				markdown: "# Child",
				membership,
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return { ...membership, folderId, childNodeId: child.nodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only archive user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.childNodeId });

		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.folderId,
		});
		expect(proposed._nay?.name).toBe("read_only");
	});

	test("a locked file refuses the content batch before any Yjs state is staged", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-batch-door.md",
				name: "pending-read-only-batch-door.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only batch door user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		// The editor asks for a batch before it uploads any branch state. Refusing here keeps the
		// client from uploading Yjs pages that could never be committed.
		const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		expect(batch._nay?.name).toBe("read_only");
		expect(await t.run((ctx) => ctx.db.query("files_pending_update_operation_batches").collect())).toEqual([]);
	});

	test("a batch made on a locked file cannot commit", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) =>
			seed_non_collaborative_file({ ctx, path: "/off-batch-lock.md", text: "# Off base" }),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only batch commit user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		// The internal batch door checks nothing by design: its callers check. Only the commit can
		// still refuse this write, so a batch made after the lock must not carry a write through.
		const staged = await seal_output_family_for_test(t, seeded);
		const commit = (family: typeof staged) =>
			t.mutation(internal.files_pending_updates.commit_file_pending_update_upsert_in_db, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				operationBatchId: family.operationBatchId,
				expectedRevision: null,
				base: { kind: "asset", expectedAssetId: seeded.assetId },
				baseStateId: family.base.stateId,
				stagedStateId: family.staged.stateId,
				unstagedStateId: family.unstaged.stateId,
				baseStateDigest: family.base.digest,
				stagedStateDigest: family.staged.digest,
				unstagedStateDigest: family.unstaged.digest,
				unstagedText: "# Draft",
				unstagedBranchChanged: true,
			});

		const committed = await commit(staged);
		expect(committed._nay?.name).toBe("read_only");
		expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).toBeNull();

		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		// The refused commit left its batch active; the retry starts over with a fresh one.
		await t.mutation(internal.files_pending_updates.retire_file_pending_update_operation_batch, {
			operationBatchId: staged.operationBatchId,
		});
		const retry = await seal_output_family_for_test(t, seeded);
		const retried = await commit(retry);
		expect(retried._nay).toBeUndefined();
		expect(await t.run((ctx) => read_pending_update_row({ ctx, ...seeded }))).not.toBeNull();
	});

	test("a private draft cannot publish while its parent folder is locked", async () => {
		const t = test_convex();
		const db = await t.run(async (ctx) => test_mocks_fill_db_with.membership(ctx));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: db.userId,
			name: "Read-only draft publish user",
		});
		const folderId = await t.run((ctx) =>
			seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/locked-parent",
				name: "locked-parent",
			}),
		);
		// The real producer accepts the draft before the parent becomes read-only.
		const draft = await create_private_text_for_test({ path: "/locked-parent/draft.txt", staged: "Saved from a private draft\n", collaborative: false }, { t, membershipId: db.membershipId });
		await set_pending_test_read_only({ asUser, membershipId: db.membershipId, nodeId: folderId });
		const publish = () => test_save_file_pending_update(asUser, {
			membershipId: db.membershipId,
			target: draft.target,
			pendingUpdateId: draft.pendingUpdateId,
			reviewedRevision: draft.proposal.revision,
		});

		const refused = await publish();
		expect(refused._nay).toBeDefined();
		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_pending_nodes", draft.target.id)).toMatchObject({ state: "active" });
			expect(await ctx.db.get("files_pending_updates", draft.pendingUpdateId)).not.toBeNull();
			expect(await ctx.db.query("files_nodes").collect()).toEqual([expect.objectContaining({ _id: folderId })]);
		});

		await set_pending_test_writable({ asUser, membershipId: db.membershipId, nodeId: folderId });
		const published = await publish();
		if (published._nay) throw new Error(published._nay.message);
		expect(published._yay.target.kind).toBe("saved");
	});

	test("a private draft cannot edit while its parent folder is locked", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const db = await test_mocks_fill_db_with.membership(ctx);
			const folderId = await seed_folder_node({
				ctx,
				organizationId: db.organizationId,
				workspaceId: db.workspaceId,
				userId: db.userId,
				path: "/draft-parent",
				name: "draft-parent",
			});
			const created = await files_pending_nodes_db_create(ctx, {
				...db,
				parent: { kind: "saved", id: folderId },
				name: "draft.txt",
				kind: "file",
			});
			if (created._nay) throw new Error(created._nay.message);
			return { ...db, folderId, privateNodeId: created._yay.privateNodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only draft edit user",
		});
		const target = { kind: "private" as const, id: seeded.privateNodeId };
		const readTarget = () =>
			asUser.query(api.files_pending_updates.get_file_pending_target, {
				membershipId: seeded.membershipId,
				target,
			});

		expect((await readTarget())?.canEdit).toBe(true);
		// The header's breadcrumb hangs the pending chain from this saved folder.
		expect((await readTarget())?.savedParentId).toBe(seeded.folderId);
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.folderId });
		expect((await readTarget())?.canEdit).toBe(false);
		await set_pending_test_writable({ asUser, membershipId: seeded.membershipId, nodeId: seeded.folderId });
		expect((await readTarget())?.canEdit).toBe(true);
	});

	test("the agent proposal path refuses a locked file", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-agent-path.md",
				name: "pending-read-only-agent-path.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only agent path user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		// The agent creates its batch server-side, so it never passes the public batch door above.
		// An agent write is still a normal write and has to stop at the lock.
		const proposed = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Agent draft",
		});
		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock taken while the content action runs refuses the commit mutation", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-commit-barrier.md",
				name: "pending-read-only-commit-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only commit barrier user",
		});

		// Hold the action inside its snapshot read, then lock. The action already checked the lock,
		// so only the commit mutation can still refuse this write.
		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const proposing = upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		releaseSnapshotFetch?.();
		const proposed = await proposing;

		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock before the refresh final mutation refuses and keeps the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-refresh-refusal.md",
				name: "pending-read-only-refresh-refusal.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only refresh refusal user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
		const pendingRow = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		if (!pendingRow) {
			throw new Error("Missing proposal before refresh refusal");
		}
		const batch = await t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			target: { kind: "saved", id: seeded.nodeId },
		});
		if (batch._nay) {
			throw new Error(batch._nay.message);
		}
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		// A refresh rewrites the stored branches, so it is a write and the lock stops it. The
		// proposal itself stays, so the user can still read or discard it.
		const refreshed = await t.mutation(internal.files_pending_updates.refresh_file_pending_update_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			operationBatchId: batch._yay.operationBatchId,
			pendingUpdateId: pendingRow._id,
			expectedRevision: pendingRow.revision,
		});
		expect(refreshed._nay?.name).toBe("read_only");
		expect((await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id)))?.updatedAt).toBe(
			pendingRow.updatedAt,
		);
	});

	test("a lock before the rebase final mutation refuses and keeps the proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-rebase-refusal.md",
				name: "pending-read-only-rebase-refusal.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only rebase refusal user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			unstagedMarkdown: "# Draft",
		});
		expect(proposed._nay).toBeUndefined();
		const [pendingRow, fileState] = await Promise.all([
			t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
			t.run((ctx) =>
				read_file_yjs_state({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			),
		]);
		if (!pendingRow) {
			throw new Error("Missing proposal before rebase refusal");
		}
		const staged = await stage_and_seal_input_family_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			baseYjsUpdate: fileState.yjsUpdate,
			stagedBranchYjsUpdate: fileState.yjsUpdate,
			unstagedBranchYjsUpdate: fileState.yjsUpdate,
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		// A rebase replaces the stored branch states, so it writes and the lock stops it.
		const rebased = await asUser.mutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			pendingUpdateId: pendingRow._id,
			operationBatchId: staged.operationBatchId,
			expectedRevision: pendingRow.revision,
			base: {
				kind: "yjs",
				baseYjsSequence: fileState.yjsSequence,
				baseLineageGeneration: 0,
				expectedYjsLastSequenceId: (await test_get_file_yjs_pointers(t, seeded.nodeId)).yjsLastSequenceId,
			},
			baseStateId: staged.base.stateId,
			stagedStateId: staged.staged.stateId,
			unstagedStateId: staged.unstaged.stateId,
			baseStateDigest: staged.base.digest,
			stagedStateDigest: staged.staged.digest,
			unstagedStateDigest: staged.unstaged.digest,
			unstagedText: seeded.baseMarkdown,
		});
		expect(rebased._nay?.name).toBe("read_only");
		expect((await t.run((ctx) => ctx.db.get("files_pending_updates", pendingRow._id)))?.updatedAt).toBe(
			pendingRow.updatedAt,
		);
	});

	test("a lock taken while the save action runs refuses the save mutation", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-save-barrier.md",
				name: "pending-read-only-save-barrier.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only save barrier user",
		});
		const proposed = await upsert_file_pending_update_public_for_test(asUser, {
			membershipId: seeded.membershipId,
			nodeId: seeded.nodeId,
			stagedMarkdown: "# Save barrier draft",
			unstagedMarkdown: "# Save barrier draft",
		});
		expect(proposed._nay).toBeUndefined();

		// Hold the save action inside its snapshot read, then lock. The action already checked the
		// lock, so only the final save mutation can still refuse this write.
		const normalFetch = globalThis.fetch;
		let releaseSnapshotFetch: (() => void) | undefined;
		const snapshotFetchBlocked = new Promise<void>((resolve) => {
			releaseSnapshotFetch = resolve;
		});
		let announceSnapshotFetch: (() => void) | undefined;
		const snapshotFetchStarted = new Promise<void>((resolve) => {
			announceSnapshotFetch = resolve;
		});
		let blocked = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
				if (!blocked && url.startsWith("https://r2.test/object?key=")) {
					blocked = true;
					announceSnapshotFetch?.();
					await snapshotFetchBlocked;
				}
				return await normalFetch(input, init);
			}),
		);

		const saving = test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		await snapshotFetchStarted;
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });
		releaseSnapshotFetch?.();
		const saved = await saving;

		expect(saved._nay?.name).toBe("read_only");
		await t.run(async (ctx) => {
			expect(
				await read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			).not.toBeNull();
			expect(
				await read_file_markdown_from_yjs({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					nodeId: seeded.nodeId,
				}),
			).not.toContain("Save barrier draft");
		});
	});

	test("a locked move source refuses the proposal, and a locked file inside a moved folder does not", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const file = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-leaf.md",
				name: "pending-read-only-move-leaf.md",
				markdown: "# Leaf",
				membership,
			});
			const folderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-folder",
				name: "pending-read-only-move-folder",
			});
			const child = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-folder/child.md",
				name: "child.md",
				markdown: "# Child",
				membership,
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return { ...membership, leafNodeId: file.nodeId, folderId, childNodeId: child.nodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only move source user",
		});

		// A move renames the node itself, so a lock on the moved file refuses the proposal.
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.leafNodeId });
		const refusedLeaf = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.leafNodeId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-leaf-renamed.md",
		});
		expect(refusedLeaf._nay?.name).toBe("read_only");

		// A writable folder may move while it holds a locked child. Rename and move check the named
		// item and its immediate parent, not descendants.
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.childNodeId });
		const movedFolder = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.folderId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-folder-renamed",
		});
		expect(movedFolder._nay).toBeUndefined();
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.folderId,
				}),
			),
		).not.toBeNull();
	});

	test("a locked destination refuses a proposal and a locked replacement child refuses Accept", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const file = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-dest-file.md",
				name: "pending-read-only-move-dest-file.md",
				markdown: "# Mover",
				membership,
			});
			const destFolderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-dest",
				name: "pending-read-only-move-dest",
			});
			const sourceFolderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-src-folder",
				name: "pending-read-only-move-src-folder",
			});
			const occupantFolderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-move-occupant-folder",
				name: "pending-read-only-move-occupant-folder",
			});
			const occupantChild = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-move-occupant-folder/child.md",
				name: "child.md",
				markdown: "# Occupant child",
				membership,
			});
			await ctx.db.patch("files_nodes", occupantChild.nodeId, { parentId: occupantFolderId });
			return {
				...membership,
				fileNodeId: file.nodeId,
				destFolderId,
				sourceFolderId,
				occupantFolderId,
				occupantChildNodeId: occupantChild.nodeId,
			};
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only move destination user",
		});

		// Dropping a file into a folder adds a child entry to that folder, so a locked destination
		// refuses the proposal.
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.destFolderId });
		const refusedDestination = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.fileNodeId,
			destParentId: seeded.destFolderId,
			destName: "pending-read-only-move-dest-file.md",
		});
		expect(refusedDestination._nay?.name).toBe("read_only");

		// Accept checks archived children before replacing the folder.
		const archived = await asUser.mutation(api.files_nodes.archive_nodes, {
			membershipId: seeded.membershipId,
			nodeIds: [seeded.occupantChildNodeId],
		});
		expect(archived._nay).toBeUndefined();
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.occupantChildNodeId });
		const proposedOccupant = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.sourceFolderId,
			destParentId: files_ROOT_ID,
			destName: "pending-read-only-move-occupant-folder",
			replace: true,
		});
		expect(proposedOccupant._nay).toBeUndefined();
		const refusedOccupant = await test_apply_file_pending_move(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.sourceFolderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.sourceFolderId },
			})),
		});
		expect(refusedOccupant._nay?.name).toBe("read_only");
		expect((await t.run(ctx => ctx.db.get("files_nodes", seeded.sourceFolderId)))?.path)
			.toBe("/pending-read-only-move-src-folder");
		expect((await t.run(ctx => ctx.db.get("files_nodes", seeded.occupantFolderId)))?.archiveOperationId).toBeNull();
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.sourceFolderId,
				}),
			),
		).not.toBeNull();
	});

	test("a locked file refuses its own archive proposal", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_signed_in_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-self.md",
				name: "pending-read-only-archive-self.md",
				markdown: "# Base",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only archive self user",
		});
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.nodeId });

		const proposed = await upsert_file_pending_archive_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
		});
		expect(proposed._nay?.name).toBe("read_only");
		expect(
			await t.run((ctx) =>
				read_pending_update_row({
					ctx,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					userId: seeded.userId,
					nodeId: seeded.nodeId,
				}),
			),
		).toBeNull();
	});

	test("a lock on the file or on an active descendant refuses the archive accept", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) => {
			const membership = await test_mocks_fill_db_with.membership(ctx);
			const file = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-accept.md",
				name: "pending-read-only-archive-accept.md",
				markdown: "# Base",
				membership,
			});
			const folderId = await seed_folder_node({
				ctx,
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: membership.userId,
				path: "/pending-read-only-archive-accept-folder",
				name: "pending-read-only-archive-accept-folder",
			});
			const child = await seed_file_with_markdown({
				ctx,
				path: "/pending-read-only-archive-accept-folder/child.md",
				name: "child.md",
				markdown: "# Child",
				membership,
			});
			await ctx.db.patch("files_nodes", child.nodeId, { parentId: folderId });
			return { ...membership, fileNodeId: file.nodeId, folderId, childNodeId: child.nodeId };
		});
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Read-only archive accept user",
		});
		for (const nodeId of [seeded.fileNodeId, seeded.folderId]) {
			const proposed = await upsert_file_pending_archive_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId,
			});
			if (proposed._nay) {
				throw new Error(proposed._nay.message);
			}
		}

		// Both proposals were made while everything was writable. Accept checks the current lock
		// again: once on the node itself, and once on every active file the archive would sweep.
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.fileNodeId });
		await set_pending_test_read_only({ asUser, membershipId: seeded.membershipId, nodeId: seeded.childNodeId });
		const refusedFile = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.fileNodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.fileNodeId },
			})),
		});
		expect(refusedFile._nay?.name).toBe("read_only");
		const refusedFolder = await asUser.mutation(api.files_pending_updates.apply_file_pending_archive, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.folderId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.folderId },
			})),
		});
		expect(refusedFolder._nay?.name).toBe("read_only");
		await t.run(async (ctx) => {
			expect((await ctx.db.get("files_nodes", seeded.fileNodeId))?.archiveOperationId).toBeNull();
			expect((await ctx.db.get("files_nodes", seeded.folderId))?.archiveOperationId).toBeNull();
		});
	});
});

describe("pending file that was moved while pending", () => {
	test("accept saves content onto the moved node", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/qa-mv-repro.md",
				name: "qa-mv-repro.md",
				markdown: "# Base",
			}),
		);
		const destFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/qa-mv-dest",
				name: "qa-mv-dest",
			}),
		);
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const moved = await test_move_nodes(t, asUser, {
				membershipId: seeded.membershipId,
				itemIds: [seeded.nodeId],
				targetParentId: destFolderId,
			});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}

		const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
		expect(node?.path).toBe("/qa-mv-dest/qa-mv-repro.md");

		const saved = await test_save_file_pending_update(asUser, {
			membershipId: seeded.membershipId,
			target: { kind: "saved", id: seeded.nodeId },
			...(await reviewed_pending_for_test(t, {
				membershipId: seeded.membershipId,
				target: { kind: "saved", id: seeded.nodeId },
			})),
		});
		expect(saved._nay).toBeUndefined();

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row).toBeNull();
	});

	test("agent mv of a saved file with pending content onto an occupied path stays reviewable", async () => {
		const t = test_convex();
		const seeded = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/qa-mv-src2/qa-mv-saved2.md",
				name: "qa-mv-saved2.md",
				markdown: "# Base",
			}),
		);
		const srcFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/qa-mv-src2",
				name: "qa-mv-src2",
			}),
		);
		const destFolderId = await t.run(async (ctx) =>
			seed_folder_node({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				path: "/qa-mv-dst2",
				name: "qa-mv-dst2",
			}),
		);
		// A committed occupant already owns the destination path.
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", seeded.nodeId, { parentId: srcFolderId });
			const occupant = await seed_file_with_markdown({
				ctx,
				path: "/qa-mv-dst2/qa-mv-saved2.md",
				name: "qa-mv-saved2.md",
				markdown: "# Existing",
				membership: {
					userId: seeded.userId,
					organizationId: seeded.organizationId,
					workspaceId: seeded.workspaceId,
					membershipId: seeded.membershipId,
				},
			});
			await ctx.db.patch("files_nodes", occupant.nodeId, { parentId: destFolderId });
		});

		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			stagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
			unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}

		const proposed = await upsert_file_pending_move_for_test({
			t,
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			nodeId: seeded.nodeId,
			destParentId: destFolderId,
			destName: "qa-mv-saved2.md",
			replace: true,
		});
		if (proposed._nay) {
			throw new Error(proposed._nay.message);
		}
		// The occupant's fate is reviewable, so the move stays a proposal.
		expect(proposed._yay.appliedImmediately).toBe(false);
		expect(proposed._yay.replacesExistingOccupant).toBe(true);

		const node = await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId));
		expect(node?.path).toBe("/qa-mv-src2/qa-mv-saved2.md");

		const row = await t.run((ctx) =>
			read_pending_update_row({
				ctx,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
			}),
		);
		expect(row?.pendingMove?.destName).toBe("qa-mv-saved2.md");
	});

	test("mv -f onto a saved occupant stays reviewable when another member has a pending row on it", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-other-src.md",
				name: "saved-other-src.md",
				markdown: "# e1",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-other-dst.md",
				name: "saved-other-dst.md",
				markdown: "# e2",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		const upserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: dest.organizationId,
			workspaceId: dest.workspaceId,
			userId: dest.userId,
			nodeId: dest.nodeId,
			unstagedMarkdown: `${dest.baseMarkdown}\n\nAgent content`,
		});
		if (upserted._nay) {
			throw new Error(upserted._nay.message);
		}
		const sourceUpserted = await upsert_file_pending_update_internal_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			unstagedMarkdown: `${source.baseMarkdown}\n\nAgent content`,
		});
		if (sourceUpserted._nay) {
			throw new Error(sourceUpserted._nay.message);
		}
		// Another member's draft on the destination makes it real work — no hard delete.
		const otherRowId = await t.run(async (ctx) =>
			ctx.db.insert("files_pending_updates", {
				organizationId: dest.organizationId,
				workspaceId: dest.workspaceId,
				userId: await ctx.db.insert("users", { clerkUserId: "other_user_saved_move_guard" }),
				target: { kind: "saved", id: dest.nodeId },
				revision: 1,
				size: 0,
				updatedAt: Date.now(),
				expiresAt: Date.now() + files_DRAFT_IDLE_EXPIRY_MS,
			}),
		);

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "saved-other-dst.md",
			replace: true,
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		expect(moved._yay.appliedImmediately).toBe(false);
		expect(moved._yay.replacesExistingOccupant).toBe(true);

		await t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", dest.nodeId)).not.toBeNull();
			expect(await ctx.db.get("files_pending_updates", otherRowId)).not.toBeNull();
		});
	});

	test("mv -f onto a saved occupant stays reviewable after committed content landed on it", async () => {
		const t = test_convex();
		const source = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-edited-src.md",
				name: "saved-edited-src.md",
				markdown: "# e1",
			}),
		);
		const dest = await t.run(async (ctx) =>
			seed_file_with_markdown({
				ctx,
				path: "/saved-edited-dst.md",
				name: "saved-edited-dst.md",
				markdown: "# e2",
				membership: {
					userId: source.userId,
					organizationId: source.organizationId,
					workspaceId: source.workspaceId,
					membershipId: source.membershipId,
				},
			}),
		);
		for (const seeded of [source, dest]) {
			const upserted = await upsert_file_pending_update_internal_for_test({
				t,
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				nodeId: seeded.nodeId,
				unstagedMarkdown: `${seeded.baseMarkdown}\n\nAgent content`,
			});
			if (upserted._nay) {
				throw new Error(upserted._nay.message);
			}
		}

		// A saved edit on the destination keeps replacement subject to review.
		await t.run(async (ctx) => {
			const node = await ctx.db.get("files_nodes", dest.nodeId);
			if (!node?.yjsLastSequenceId) {
				throw new Error("Expected a yjs last sequence doc on the destination");
			}
			await ctx.db.patch("files_yjs_docs_last_sequences", node.yjsLastSequenceId, { lastSequence: 1 });
		});

		const moved = await upsert_file_pending_move_for_test({
			t,
			organizationId: source.organizationId,
			workspaceId: source.workspaceId,
			userId: source.userId,
			nodeId: source.nodeId,
			destParentId: files_ROOT_ID,
			destName: "saved-edited-dst.md",
			replace: true,
		});
		if (moved._nay) {
			throw new Error(moved._nay.message);
		}
		expect(moved._yay.appliedImmediately).toBe(false);
		expect(moved._yay.replacesExistingOccupant).toBe(true);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", dest.nodeId))).not.toBeNull();
	});
});
