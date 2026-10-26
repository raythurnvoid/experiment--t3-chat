// Save and pending text tests. Review tests are in files_pending_updates.review.test.ts. Move, archive,
// delete and read-only tests are in files_pending_updates.structural.test.ts.
import { RateLimiter } from "@convex-dev/rate-limiter";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "./_generated/api.js";
import {
	test_save_file_pending_update,
	test_finish_pending_update_run,
	test_convex,
	test_drain_billing_usage_event_outbox,
	test_get_file_yjs_pointers,
	test_meta_search,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "./setup.test.ts";
import { billing_PRODUCTS, billing_get_recurring_credits_cents } from "../shared/billing.ts";
import { billing_db_ensure_anonymous_user_usage_snapshot } from "./billing.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_db_get_content_version } from "./files_nodes_db.ts";
import { billing_event } from "../server/billing.ts";
import { r2_create_asset_key } from "./r2_assets.ts";
import {
	files_db_get_pending_update,
	files_DRAFT_IDLE_EXPIRY_MS,
	files_ROOT_ID,
	files_u8_to_array_buffer,
} from "../server/files.ts";
import {
	files_yjs_compute_diff_update_from_yjs_doc,
	files_yjs_doc_clone,
	files_yjs_doc_create_from_array_buffer_update,
} from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text, files_yjs_doc_update_from_text } from "../shared/files-tiptap.ts";
import {
	files_get_utf8_byte_size,
	files_PENDING_UPDATE_STALE_BASE_MESSAGE,
	files_pending_update_content_is_stale,
} from "../shared/files.ts";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import {
	accept_as_member,
	build_file_diff_update_from_snapshot,
	create_private_text_for_test,
	enqueueActionSpy,
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
	read_pending_row_markdown_state,
	read_pending_row_state_bytes,
	read_pending_update_last_sequence_saved_doc,
	read_pending_update_row,
	read_seeded_pending_row,
	reviewed_pending_for_test,
	save_as_member,
	seed_file_with_markdown,
	seed_non_collaborative_file,
	seed_signed_in_file_with_markdown,
	set_pending_test_read_only,
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
			expectedPendingContentVersion: 1,
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
			expectedPendingContentVersion: 1,
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
			expect(docAfter.content?.base).toEqual({ kind: "asset", assetId: node?.assetId, pendingContentVersion: 1 });
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
				expectedPendingContentVersion: 1,
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
				expectedPendingContentVersion: 1,
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
				expectedPendingContentVersion: 1,
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
		await test_run_with_flush(t, (ctx) => ctx.db.patch("files_nodes", seeded.nodeId, { collaborationEnabled: true }));
		const asUser = t.withIdentity({
			issuer: "https://clerk.test",
			external_id: seeded.userId,
			name: "Test User",
		});
		const committed = await asUser.mutation(
			internal.files_pending_updates.save_file_pending_update_non_collaborative_in_db,
			{
				expectedPendingContentVersion: 1,
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
			expectedPendingContentVersion: 1,
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
				expectedPendingContentVersion: 1,
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
			subject: { kind: "user", userId: seeded.userId, plugin: null },
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
			subject: { kind: "user", userId: seeded.userId, plugin: null },
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
					{
						...readScope,
						userId: seeded.userId,
						subject: { kind: "user", userId: seeded.userId, plugin: null },
						query,
						numItems: 10,
						cursor,
					},
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

	test("after a member save the read doors keep the owner's old proposal visible", async () => {
		const t = test_convex();
		const path = "/off-overlay-stale.md";
		const { seeded, row, readScope } = await seed_file_with_proposal(t, path);
		const savedMarkdown = "# Off overlay\n\nsaved needle\n";
		await save_as_member({ t, seeded, text: savedMarkdown });

		const full = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			...readScope,
			userId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path,
			mode: { kind: "full", maxBytes: 10_000 },
		});
		if (!full) throw new Error("expected a full read");
		expect(full.content).toBe(proposalMarkdown);
		expect(full.pendingUpdateId).toBe(row._id);

		// `wc` must count the owner's draft, not the newer saved text.
		const stats = await t.query(internal.files_nodes.read_committed_file_chunk_stats, {
			...readScope,
			userId: seeded.userId,
			path,
		});
		expect(stats.usable).toBe(false);

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

		// Reading keeps the old proposal. Review is still needed before writing or saving it.
		const state = await t.query(internal.files_nodes_content.get_file_text_content_db_state_by_path, {
			...readScope,
			userId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path,
		});
		if (!state) throw new Error("expected a content state");
		expect(state.content).toBe(proposalMarkdown);
		expect(state.pendingUpdateId).toBe(row._id);
		expect(state.materializationState).toBeNull();

		// Pending chunks and committed chunks are two queries, so read every page.
		const search = async (query: string) => {
			const paths: string[] = [];
			let cursor: string | null = null;
			for (let page = 0; page < 10; page++) {
				const result: FunctionReturnType<typeof internal.files_nodes.text_search_files> = await t.query(
					internal.files_nodes.text_search_files,
					{
						...readScope,
						userId: seeded.userId,
						subject: { kind: "user", userId: seeded.userId, plugin: null },
						query,
						numItems: 10,
						cursor,
					},
				);
				paths.push(...result.items.map((item) => item.path));
				if (result.isDone) break;
				cursor = result.continueCursor;
			}
			return paths;
		};
		expect(await search("saved")).not.toContain(path);
		expect(await search("proposal")).toContain(path);
		const saved = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			...readScope,
			userId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path,
			committedOnly: true,
			mode: { kind: "full", maxBytes: 10_000 },
		});
		expect(saved?.content).toBe(savedMarkdown);
		expect(await t.run((ctx) => ctx.db.get("files_pending_updates", row._id))).toEqual(row);
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

	test("metadata search keeps the owner's old frontmatter after a member save", async () => {
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
		expect(await search_title("saved")).not.toContain(path);
		expect(await search_title("proposal")).toContain(path);
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
			const found = await asUser.action(api.files_nodes.search_saved_metadata, {
				membershipId: seeded.membershipId,
				plan: { op: "eq", fieldPath: "frontmatter.title", value },
				numItems: 50,
				cursor: null,
			});
			return found._yay!.page.map((row) => (row.kind === "problem" ? row.message : row.nodeId));
		};
		const title_by_path = async () => {
			const found = await t.query(internal.files_metadata.get_index_values_by_path, {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				subject: { kind: "user", userId: seeded.userId, plugin: null },
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
		expect(await title_by_path()).toBe("proposal");
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

describe("pending content version reads", () => {
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
				pendingContentVersion: 1,
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
			subject: { kind: "user" as const, userId: seeded.userId, plugin: null },
			query: "markedneedle",
			numItems: 10,
			cursor: null,
		};
		expect(
			(await t.query(internal.files_nodes.text_search_files, searchArgs)).items.map((item) => item.path),
		).toContain("/mark.txt");
		await test_run_with_flush(t, async ctx => {
			const node = (await ctx.db.get("files_nodes", seeded.nodeId))!;
			await ctx.db.patch("files_nodes", node._id, { pendingContentVersion: node.pendingContentVersion + 1 });
		});
		await test_run_with_flush(t, async ctx => {
			const node = (await ctx.db.get("files_nodes", seeded.nodeId))!;
			await ctx.db.patch("files_nodes", node._id, { pendingContentVersion: node.pendingContentVersion + 1 });
		});
		expect((await t.query(internal.files_nodes.text_search_files, searchArgs)).items.map((item) => item.path)).toContain(
			"/mark.txt",
		);
		const content = await t.query(internal.files_nodes.read_file_content_from_chunks, {
			organizationId: seeded.organizationId,
			workspaceId: seeded.workspaceId,
			userId: seeded.userId,
			subject: { kind: "user", userId: seeded.userId, plugin: null },
			path: "/mark.txt",
			mode: { kind: "full", maxBytes: 1000 },
		});
		expect(content?.content).toBe(`markedneedle ${seeded.userId}\n`);

		await t.run(async (ctx) => {
			for (const doc of before.docs) {
				expect(await ctx.db.get("files_pending_updates", doc._id)).toEqual(
					doc,
				);
			}
			expect(await ctx.db.query("files_pending_update_yjs_states").collect()).toEqual(before.states);
			expect(await ctx.db.query("files_pending_update_yjs_state_pages").collect()).toEqual(before.pages);
			expect(await ctx.db.query("files_text_chunks").collect()).toEqual(before.chunks);
			expect(await ctx.db.query("files_pending_update_expiry_checks").collect()).toEqual(before.checks);
			expect(await ctx.db.query("files_pending_updates_last_sequence_saved").collect()).toHaveLength(2);
		});
	});

	test("keeps old saved markers without a content proposal", async () => {
		const t = test_convex();
		const seeded = await t.run((ctx) => seed_non_collaborative_file({ ctx, path: "/mark-empty.txt", text: "base\n" }));
		await test_run_with_flush(t, async (ctx) => {
			await ctx.db.insert("files_pending_updates_last_sequence_saved", {
				organizationId: seeded.organizationId,
				workspaceId: seeded.workspaceId,
				userId: seeded.userId,
				fileNodeId: seeded.nodeId,
				lastSequenceSaved: 9,
				pendingContentVersion: 1,
				updatedAt: 123,
			});
			await ctx.db.patch("files_nodes", seeded.nodeId, { pendingContentVersion: 2 });
			expect(await ctx.db.query("files_pending_updates_last_sequence_saved").collect()).toHaveLength(1);
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
			expect(await asUser.query(api.files_pending_target.get_file_pending_update, queryArgs)).toEqual({
				...original,
				currentYjsLastSequenceId: null,
				currentPendingContentVersion: 1,
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
				expect(files_pending_update_content_is_stale(marked!, node!)).toBe(true);
				expect(await asUser.query(api.files_pending_target.get_file_pending_update, queryArgs)).toEqual({
					...marked,
					currentYjsLastSequenceId,
					currentPendingContentVersion: node!.pendingContentVersion,
				});
				const prepared = await asUser.action(
					api.files_pending_updates.prepare_file_pending_update_for_review,
					queryArgs,
				);
				expect(prepared._nay).toBeUndefined();
				expect(
					files_pending_update_content_is_stale(prepared._yay!.pendingUpdate!, node!),
				).toBe(false);
				expect(await asUser.query(api.files_pending_target.get_file_pending_update, queryArgs)).toEqual({
					...prepared._yay?.pendingUpdate,
					currentYjsLastSequenceId,
					currentPendingContentVersion: node!.pendingContentVersion,
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
				await asOther.query(api.files_pending_target.get_file_pending_update, {
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
			expect(await read_seeded_pending_row(t, seeded)).toEqual(original);

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
			expect(
				files_pending_update_content_is_stale(prepared, (await t.run((ctx) => ctx.db.get("files_nodes", seeded.nodeId)))!),
			).toBe(false);
			expect(prepared.content?.rootKind).toBe(rootKind);
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
