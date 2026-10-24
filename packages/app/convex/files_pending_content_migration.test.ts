import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyUpdate, Doc as YDoc, encodeStateAsUpdate } from "yjs";
import { ConvexError } from "convex/values";
import migrations_test from "@convex-dev/migrations/test";
import { api, components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { test_convex, test_run_with_flush, test_spy_handler } from "./setup.test.ts";
import {
	mock_pending_updates_storage,
	read_file_yjs_state,
	save_as_member,
	seed_non_collaborative_file,
	seed_signed_in_file_with_markdown,
	stage_and_seal_input_family_for_test,
	upsert_file_pending_update_internal_for_test,
} from "./files_pending_updates.setup.test.ts";
import {
	files_pending_content_migration_db_cohort_page,
	files_pending_content_migration_db_extend_deadline,
	files_pending_content_migration_db_family,
	files_pending_content_migration_versions,
} from "./files_pending_content_migration.ts";
import { files_nodes_db_get_content_version } from "./files_nodes_db.ts";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_move_content_db_create } from "./files_move_content_db.ts";
import { files_move_content_action_prepare } from "./files_move_content.ts";
import { advance as advance_cohort, files_move_cohorts_db_schedule } from "./files_move_cohorts.ts";
import { files_transfer_source_versions_equal } from "./files_transfer.ts";
import { files_MAX_YJS_RECONSTRUCTED_STATE_BYTES, files_pending_update_content_is_stale } from "../shared/files.ts";
import { files_u8_to_array_buffer } from "../server/files.ts";
import { test_create_saved_placement_fixture } from "../server/files-saved-placement.test-fixtures.ts";
import { files_move_reservations_db_enter } from "../server/files-move-reservations.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_pending_updates_storage();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function fixture(collaborative: boolean) {
	const t = test_convex();
	const file = await t.run(
		async (ctx) =>
			await (collaborative
				? seed_signed_in_file_with_markdown({ ctx, path: "/old.md", name: "old.md", markdown: "base\n" })
				: seed_non_collaborative_file({ ctx, path: "/old.txt", text: "base\n" })),
	);
	const proposed = await upsert_file_pending_update_internal_for_test({
		t,
		...file,
		stagedMarkdown: "accepted\n",
		unstagedMarkdown: "proposed\n",
	});
	if (proposed._nay) throw new Error(proposed._nay.message);
	const proposal = (await t.run((ctx) =>
		ctx.db
			.query("files_pending_updates")
			.withIndex("by_user_target", (q) =>
				q.eq("userId", file.userId).eq("target.kind", "saved").eq("target.id", file.nodeId),
			)
			.unique(),
	))!;
	return { t, ...file, proposal };
}

async function strip_family(
	f: { t: ReturnType<typeof test_convex>; proposal: Doc<"files_pending_updates"> },
	marked = false,
) {
	await f.t.run(async (ctx) => {
		const proposal = (await ctx.db.get("files_pending_updates", f.proposal._id))!;
		const { rootKind, ...content } = proposal.content!;
		const base = content.base.kind === "new" ? content.base : { ...content.base, pendingContentVersion: undefined };
		await ctx.db.patch("files_pending_updates", proposal._id, {
			content: { ...content, base },
			contentNeedsRebase: marked ? true : undefined,
			contentRebaseRootKind: marked ? rootKind : undefined,
		});
	});
}

async function read_family(f: { t: ReturnType<typeof test_convex>; proposal: Doc<"files_pending_updates"> }) {
	return await f.t.run(async (ctx) => {
		const proposal = (await ctx.db.get("files_pending_updates", f.proposal._id))!;
		const content = proposal.content!;
		const ids = [content.baseStateId, content.stagedStateId, content.unstagedStateId];
		return {
			proposal,
			states: await Promise.all(ids.map((id) => ctx.db.get("files_pending_update_yjs_states", id))),
			pages: await Promise.all(
				ids.map((id) =>
					ctx.db
						.query("files_pending_update_yjs_state_pages")
						.withIndex("by_state_pageIndex", (q) => q.eq("stateId", id))
						.collect(),
				),
			),
		};
	});
}

async function hold_cohort_target(f: {
	t: ReturnType<typeof test_convex>;
	nodeId: Id<"files_nodes">;
	cohortId: Id<"files_move_cohorts">;
	recordId: Id<"files_move_cohort_nodes">;
}) {
	// The reader fixture stops before native source capture. Add that exact stored hold.
	await f.t.run(async (ctx) => {
		const cohort = (await ctx.db.get("files_move_cohorts", f.cohortId))!;
		const existing = await ctx.db
			.query("files_move_source_reservations")
			.withIndex("by_source", (q) => q.eq("source.kind", "saved").eq("source.id", f.nodeId))
			.unique();
		const reservationId =
			existing?._id ??
			(await ctx.db.insert("files_move_source_reservations", {
				cohortId: f.cohortId,
				source: { kind: "saved", id: f.nodeId },
				mode: "placement",
				userId: null,
				generation: cohort.proofEpoch,
			}));
		await ctx.db.patch("files_move_cohort_nodes", f.recordId, { sourceReservationId: reservationId });
	});
}

async function cohort_fixture(oldInput = false) {
	const f = await test_create_saved_placement_fixture({
		beforeMove: async ({ t, db, nodeId }) => {
			const proposed = await upsert_file_pending_update_internal_for_test({
				t,
				...db,
				nodeId,
				stagedMarkdown: "accepted\n",
				unstagedMarkdown: "proposed\n",
			});
			if (proposed._nay) throw new Error(proposed._nay.message);
			if (oldInput) {
				const proposal = (await t.run((ctx) =>
					ctx.db
						.query("files_pending_updates")
						.withIndex("by_user_target", (q) =>
							q.eq("userId", db.userId).eq("target.kind", "saved").eq("target.id", nodeId),
						)
						.unique(),
				))!;
				await strip_family({ t, proposal });
			}
		},
	});
	await hold_cohort_target(f);
	const itemId = await f.t.run(async (ctx) => {
		const node = (await ctx.db.get("files_nodes", f.nodeId))!;
		await ctx.db.patch("files_move_cohort_nodes", f.recordId, {
			sourceContentVersion: await files_nodes_db_get_content_version(ctx, node),
		});
		const itemId = await ctx.db.insert("files_move_cohort_items", {
			cohortId: f.cohortId,
			order: 0,
			origin: { kind: "transfer", itemId: f.itemId },
			pendingUpdateId: f.proposal._id,
			reviewedRevision: f.proposal.revision,
			selectedContentStateId: f.proposal.content!.stagedStateId,
			target: f.proposal.target,
			privateVersion: null,
			nodeRecordId: f.recordId,
			afterProposal: null,
			contentId: null,
			replacementItemId: null,
			status: "staged",
			validatedEpoch: null,
			billingState: "none",
		});
		await ctx.db.patch("files_move_cohort_nodes", f.recordId, { itemId });
		return itemId;
	});
	const created = await test_run_with_flush(f.t, (ctx) =>
		files_move_content_db_create(ctx, { cohortId: f.cohortId, itemId, nodeId: f.nodeId }),
	);
	if (created._nay) throw new Error(created._nay.message);
	return {
		...f,
		itemId,
		contentId: created._yay,
		context: {
			cohortId: f.cohortId,
			contentId: created._yay,
			fence: f.fence,
			attemptFence: f.attemptFence,
			preparationFence: 0,
		},
	};
}

describe("bridge families", () => {
	test.each([false, true])(
		"keeps the proved old root after the saved shape and counter change, collaborative=%s",
		async (collaborative) => {
			const f = await fixture(collaborative);
			await strip_family(f);
			const before = await read_family(f);
			const node = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
			const migrated = await f.t.run((ctx) =>
				files_pending_content_migration_db_family(ctx, before.proposal, {
					...node,
					pendingContentVersion: 2,
					textKind: collaborative ? "plain_text" : "rich_text",
				}),
			);
			expect(migrated?.rootKind, "owned branch bytes prove the old root instead of today's shape").toBe(
				f.proposal.content!.rootKind,
			);
			expect(migrated?.base).toMatchObject({ pendingContentVersion: 0 });
			expect(await read_family(f)).toEqual(before);
		},
	);

	test("refuses a retained old header when no branch or historical root can prove its shape", async () => {
		const f = await fixture(true);
		await strip_family(f);
		const before = await read_family(f);
		await f.t.run(async (ctx) => {
			// Finished Review headers can remain after their branch docs are cleaned up.
			for (const state of before.states) await ctx.db.delete("files_pending_update_yjs_states", state!._id);
		});
		await expect(
			f.t.run(async (ctx) =>
				files_pending_content_migration_db_family(ctx, before.proposal, {
					...(await ctx.db.get("files_nodes", f.nodeId))!,
					pendingContentVersion: 2,
					textKind: "plain_text",
				}),
			),
			"missing history must not adopt the current file's shape",
		).rejects.toThrow("Draft root needs a migration decision");
	});

	test.each([false, true])(
		"keeps a marked family's old root and maps its missing counter to zero, collaborative=%s",
		async (collaborative) => {
			const f = await fixture(collaborative);
			await strip_family(f, true);
			const before = await read_family(f);
			const node = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
			const migrated = await f.t.run((ctx) =>
				files_pending_content_migration_db_family(ctx, before.proposal, {
					...node,
					pendingContentVersion: 2,
					textKind: collaborative ? "plain_text" : "rich_text",
				}),
			);
			expect(migrated?.rootKind, "the recorded source root wins over the current target shape").toBe(
				f.proposal.content!.rootKind,
			);
			expect(migrated?.base).toEqual({ ...before.proposal.content!.base, pendingContentVersion: 0 });
			expect(await read_family(f), "reading migration facts does not edit the family").toEqual(before);
		},
	);

	test.each([false, true])(
		"fills only root and base facts and never adopts a later reset counter, collaborative=%s",
		async (collaborative) => {
			const f = await fixture(collaborative);
			await strip_family(f);
			const before = await read_family(f);
			await f.t.run(async (ctx) => {
				const node = (await ctx.db.get("files_nodes", f.nodeId))!;
				await ctx.db.patch("files_pending_updates", before.proposal._id, {
					content: await files_pending_content_migration_db_family(ctx, before.proposal, node),
				});
				await ctx.db.patch("files_nodes", node._id, { pendingContentVersion: 2 });
			});
			const after = await read_family(f);
			expect(after.proposal).toEqual({
				...before.proposal,
				content: {
					...before.proposal.content,
					rootKind: f.proposal.content!.rootKind,
					base: { ...before.proposal.content!.base, pendingContentVersion: collaborative ? 0 : 1 },
				},
			});
			expect(after.states, "state IDs, digests and ownership stay exact").toEqual(before.states);
			expect(after.pages, "every stored page and byte stays exact").toEqual(before.pages);
			const node = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
			expect(files_pending_update_content_is_stale(after.proposal, node)).toBe(true);
			expect(await f.t.run((ctx) => files_pending_content_migration_db_family(ctx, after.proposal, node))).toEqual(
				after.proposal.content,
			);
			await f.t.run(async (ctx) =>
				ctx.db.patch("files_pending_updates", after.proposal._id, {
					content: await files_pending_content_migration_db_family(ctx, after.proposal, node),
				}),
			);
			expect(await read_family(f), "a duplicate fact fill changes nothing").toEqual(after);
		},
	);

	test("keeps an old OFF draft after a member Save and marks its unproved history stale", async () => {
		const f = await fixture(false);
		await strip_family(f);
		const originalNode = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
		await save_as_member({ t: f.t, seeded: { ...f, assetId: originalNode.assetId! }, text: "new saved text\n" });
		const before = await read_family(f);
		await f.t.run(async (ctx) => {
			const node = (await ctx.db.get("files_nodes", f.nodeId))!;
			await ctx.db.patch("files_pending_updates", before.proposal._id, {
				content: await files_pending_content_migration_db_family(ctx, before.proposal, node),
			});
		});
		const after = await read_family(f);
		expect(after.proposal).toEqual({
			...before.proposal,
			content: {
				...before.proposal.content,
				rootKind: "plain_text",
				base: { ...before.proposal.content!.base, pendingContentVersion: 0 },
			},
		});
		expect(after.states).toEqual(before.states);
		expect(after.pages).toEqual(before.pages);
		const node = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
		expect(node.assetId).not.toBe(originalNode.assetId);
		expect(node.pendingContentVersion).toBe(1);
		expect(files_pending_update_content_is_stale(after.proposal, node)).toBe(true);
	});

	test("a reset refuses a rootless old family without changing saved content, then succeeds after fact fill", async () => {
		const f = await fixture(true);
		await strip_family(f);
		const before = await read_family(f);
		const node = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
		const saved = await f.t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", f.nodeId),
			snapshot: await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId!),
			sequence: await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId!),
			history: await ctx.db
				.query("files_snapshots")
				.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
					q.eq("organizationId", f.organizationId).eq("workspaceId", f.workspaceId).eq("fileNodeId", f.nodeId),
				)
				.collect(),
		}));
		const asUser = f.t.withIdentity({ issuer: "https://clerk.test", external_id: f.userId });
		const args = { membershipId: f.membershipId, nodeId: f.nodeId, acknowledgeDropCollaborativeHistory: true };
		const refused = await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, args);
		expect(refused._nay?.name, "the exact rootless family requires bounded migration before a reset").toBe(
			"migration_pending",
		);
		expect(
			await f.t.run(async (ctx) => ({
				node: await ctx.db.get("files_nodes", f.nodeId),
				snapshot: await ctx.db.get("files_yjs_snapshots", node.yjsSnapshotId!),
				sequence: await ctx.db.get("files_yjs_docs_last_sequences", node.yjsLastSequenceId!),
				history: await ctx.db
					.query("files_snapshots")
					.withIndex("by_organization_workspace_fileNode_archivedAt", (q) =>
						q.eq("organizationId", f.organizationId).eq("workspaceId", f.workspaceId).eq("fileNodeId", f.nodeId),
					)
					.collect(),
			})),
		).toEqual(saved);
		expect(await read_family(f)).toEqual(before);
		await f.t.run(async (ctx) =>
			ctx.db.patch("files_pending_updates", before.proposal._id, {
				content: await files_pending_content_migration_db_family(ctx, before.proposal, node),
			}),
		);
		const filled = await read_family(f);
		expect(filled.proposal.content).toMatchObject({ rootKind: "rich_text", base: { pendingContentVersion: 0 } });
		expect(await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, args)).toEqual({ _yay: null });
		expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId))).toMatchObject({
			collaborationEnabled: false,
			pendingContentVersion: 2,
		});
		expect(await read_family(f), "the later reset keeps all filled draft bytes and metadata").toEqual(filled);
	});

	test("a structural-only proposal does not pause a reset", async () => {
		const t = test_convex();
		const f = await t.run((ctx) =>
			seed_signed_in_file_with_markdown({ ctx, path: "/old.md", name: "old.md", markdown: "base\n" }),
		);
		const moved = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
			organizationId: f.organizationId,
			workspaceId: f.workspaceId,
			userId: f.userId,
			target: { kind: "saved", id: f.nodeId },
			destParent: { kind: "root" },
			destName: "renamed.md",
		});
		if (moved._nay) throw new Error(moved._nay.message);
		const before = await t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.userId).eq("target.kind", "saved").eq("target.id", f.nodeId),
				)
				.unique(),
		);
		expect(before?.content).toBeUndefined();
		const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: f.userId });
		expect(
			await asUser.mutation(api.files_nodes_content.set_file_non_collaborative, {
				membershipId: f.membershipId,
				nodeId: f.nodeId,
				acknowledgeDropCollaborativeHistory: true,
			}),
		).toEqual({ _yay: null });
		expect(await t.run((ctx) => ctx.db.get("files_nodes", f.nodeId))).toMatchObject({
			collaborationEnabled: false,
			pendingContentVersion: 2,
		});
		expect(
			await t.run((ctx) => ctx.db.get("files_pending_updates", before!._id)),
			"the structural proposal stays exact",
		).toEqual(before);
	});

	test("a fresh prepared family supersedes its old stale marker", async () => {
		const f = await fixture(true);
		await strip_family(f, true);
		const asUser = f.t.withIdentity({ issuer: "https://clerk.test", external_id: f.userId });
		const updated = await asUser.action(api.files_pending_updates.prepare_file_pending_update_for_review, {
			membershipId: f.membershipId,
			target: { kind: "saved", id: f.nodeId },
			pendingUpdateId: f.proposal._id,
		});
		if (updated._nay) throw new Error(updated._nay.message);
		const after = await read_family(f);
		const node = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!;
		expect(after.proposal.content?.base).toMatchObject({ pendingContentVersion: 1 });
		expect(
			files_pending_update_content_is_stale(after.proposal, node),
			"a new explicit pin wins over a retained old marker",
		).toBe(false);
	});
});

describe("bridge saved versions", () => {
	test("fills nested old proofs with one and preserves explicit proofs", async () => {
		const f = await fixture(true);
		const { node, version } = await f.t.run(async (ctx) => {
			const node = (await ctx.db.get("files_nodes", f.nodeId))!;
			return { node, version: await files_nodes_db_get_content_version(ctx, node) };
		});
		if (version?.kind !== "yjs") throw new Error("Expected a collaborative version");
		const { pendingContentVersion, ...old } = version;
		const common = {
			membershipId: f.membershipId,
			pendingUpdateId: f.proposal._id,
			reviewedRevision: f.proposal.revision,
			billedUserId: f.userId,
			operationBatchIds: [],
			nodeId: f.nodeId,
		};
		const prepared: NonNullable<Doc<"files_move_cohort_content">["prepared"]>[] = [
			{
				...common,
				kind: "saved_yjs",
				baseYjsSequence: version.sequence,
				baseLineageGeneration: version.lineageGeneration,
				expectedYjsLastSequenceId: version.lastSequenceId,
			},
			{ ...common, kind: "saved_asset", publish: null },
			{
				...common,
				kind: "replacement",
				stagedAssetId: node.assetId!,
				contentAssetId: node.assetId!,
				contentSize: 5,
				contentType: version.contentType,
			},
		];
		const migrated = files_pending_content_migration_versions({
			source: old,
			pending: { savedVersion: old },
			prepared,
			current: { ...version, pendingContentVersion: 7 },
			privateBase: { kind: "new" },
		});
		expect(migrated).toEqual({
			source: { ...old, pendingContentVersion: 1 },
			pending: { savedVersion: { ...old, pendingContentVersion: 1 } },
			prepared: prepared.map((value) => ({ ...value, expectedPendingContentVersion: 1 })),
			current: { ...version, pendingContentVersion: 7 },
			privateBase: { kind: "new" },
		});
		expect(files_transfer_source_versions_equal(old, { ...version, pendingContentVersion: 1 })).toBe(true);
		expect(
			files_transfer_source_versions_equal(old, { ...version, pendingContentVersion: 2 }),
			"a fieldless old proof never means today's counter",
		).toBe(false);
		expect(files_pending_content_migration_versions(migrated)).toEqual(migrated);
	});

	test("refuses a legacy admitted batch after the saved counter advances", async () => {
		const f = await fixture(false);
		const admitted = await f.t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{
				organizationId: f.organizationId,
				workspaceId: f.workspaceId,
				userId: f.userId,
				target: { kind: "saved", id: f.nodeId },
				expectedPendingContentVersion: 1,
			},
		);
		if (admitted._nay) throw new Error(admitted._nay.message);
		await f.t.run(async (ctx) => {
			await ctx.db.patch("files_pending_update_operation_batches", admitted._yay.operationBatchId, {
				expectedPendingContentVersion: undefined,
			});
			await ctx.db.patch("files_nodes", f.nodeId, { pendingContentVersion: 2 });
		});
		const before = await read_family(f);
		const result = await f.t.mutation(internal.files_pending_updates.stage_file_pending_update_text_input_internal, {
			organizationId: f.organizationId,
			workspaceId: f.workspaceId,
			userId: f.userId,
			operationBatchId: admitted._yay.operationBatchId,
			role: "unstaged",
			text: "late old output",
		});
		expect(result._nay?.message).toBe("This file changed. Read it again.");
		expect(await read_family(f)).toEqual(before);
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_pending_update_text_inputs")
					.withIndex("by_operationBatch", (q) => q.eq("operationBatchId", admitted._yay.operationBatchId))
					.collect(),
			),
		).toEqual([]);
	});
});

describe("bridge cohorts", () => {
	test("migrates consecutive maximum-size owner families with read room in every native step", async () => {
		const families: Doc<"files_pending_updates">[] = [];
		const roleBytes: number[][] = [];
		const f = await test_create_saved_placement_fixture({
			// Keep a bad batch visible to the named assertion instead of an earlier limit throw.
			transactionLimits: { bytesRead: 64 * 1024 * 1024 },
			beforeMove: async ({ t, db, nodeId }) => {
				const saved = await t.run(async (ctx) => ({
					state: await read_file_yjs_state({ ctx, ...db, nodeId }),
					version: await files_nodes_db_get_content_version(ctx, (await ctx.db.get("files_nodes", nodeId))!),
				}));
				if (saved.version?.kind !== "yjs") throw new Error("Expected a collaborative source");
				for (let index = 0; index < 2; index++) {
					const userId =
						index === 0
							? db.userId
							: await t.run(async (ctx) => {
									const userId = await ctx.db.insert("users", { clerkUserId: "large-migration-owner" });
									await ctx.db.insert("organizations_workspaces_users", {
										organizationId: db.organizationId,
										workspaceId: db.workspaceId,
										userId,
										active: true,
										pendingOrganizationRemoval: false,
										updatedAt: Date.now(),
									});
									await access_control_db_ensure_role_assignment(ctx, {
										...db,
										userId,
										role: "member",
										now: Date.now(),
									});
									return userId;
								});
					const proposed = await upsert_file_pending_update_internal_for_test({
						t,
						...db,
						nodeId,
						userId,
						stagedMarkdown: "accepted\n",
						unstagedMarkdown: "proposed\n",
					});
					if (proposed._nay) throw new Error(proposed._nay.message);
					const proposal = (await t.run((ctx) =>
						ctx.db
							.query("files_pending_updates")
							.withIndex("by_user_target", (q) =>
								q.eq("userId", userId).eq("target.kind", "saved").eq("target.id", nodeId),
							)
							.unique(),
					))!;
					const updates = ["", "accepted\n", "proposed\n"].map((suffix) => {
						const doc = new YDoc({ gc: false });
						try {
							applyUpdate(doc, new Uint8Array(saved.state.yjsUpdate));
							const text = doc.getText("plain_text");
							for (let cycle = 0; cycle < 4; cycle++) {
								text.insert(0, "a".repeat(1_048_000));
								text.delete(0, 1_048_000);
							}
							text.insert(text.length, suffix);
							return files_u8_to_array_buffer(encodeStateAsUpdate(doc));
						} finally {
							doc.destroy();
						}
					});
					roleBytes.push(updates.map((update) => update.byteLength));
					for (const update of updates) {
						expect(update.byteLength, "each role is within 3 KiB of the supported state cap").toBeGreaterThan(
							files_MAX_YJS_RECONSTRUCTED_STATE_BYTES - 3 * 1024,
						);
						expect(update.byteLength).toBeLessThanOrEqual(files_MAX_YJS_RECONSTRUCTED_STATE_BYTES);
					}
					const sealed = await stage_and_seal_input_family_for_test({
						t,
						...db,
						userId,
						nodeId,
						baseYjsUpdate: updates[0]!,
						stagedBranchYjsUpdate: updates[1]!,
						unstagedBranchYjsUpdate: updates[2]!,
					});
					const committed = await t.mutation(internal.files_pending_updates.commit_file_pending_update_rebase_in_db, {
						organizationId: db.organizationId,
						workspaceId: db.workspaceId,
						userId,
						nodeId,
						expectedPendingContentVersion: 1,
						pendingUpdateId: proposal._id,
						operationBatchId: sealed.operationBatchId,
						expectedRevision: proposal.revision,
						base: {
							kind: "yjs",
							baseYjsSequence: saved.version.sequence,
							baseLineageGeneration: saved.version.lineageGeneration,
							expectedYjsLastSequenceId: saved.version.lastSequenceId,
						},
						baseStateId: sealed.base.stateId,
						stagedStateId: sealed.staged.stateId,
						unstagedStateId: sealed.unstaged.stateId,
						baseStateDigest: sealed.base.digest,
						stagedStateDigest: sealed.staged.digest,
						unstagedStateDigest: sealed.unstaged.digest,
						unstagedText: "old textproposed\n",
					});
					if (committed._nay) throw new Error(committed._nay.message);
					if (!committed._yay.pendingUpdate) throw new Error("Expected the large canonical family");
					families.push(committed._yay.pendingUpdate);
					await strip_family({ t, proposal: committed._yay.pendingUpdate });
				}
			},
		});
		const before = await Promise.all(families.map((proposal) => read_family({ t: f.t, proposal })));
		await hold_cohort_target(f);
		await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "ready", workPhase: "publish" }));
		let measuring = false;
		const reads: { bytesRead: number; documentsRead: number; databaseQueries: number }[] = [];
		test_spy_handler(advance_cohort, async (handler, ctx, args) => {
			const result = await handler(ctx, args);
			if (measuring) {
				const metrics = await ctx.meta.getTransactionMetrics();
				reads.push({
					bytesRead: metrics.bytesRead.used,
					documentsRead: metrics.documentsRead.used,
					databaseQueries: metrics.databaseQueries.used,
				});
			}
			return result;
		});
		let cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		for (let pass = 0; pass < 40 && !cohort.pendingContentVersionReady; pass++) {
			measuring = true;
			try {
				await f.t.mutation(internal.files_move_cohorts.advance, {
					cohortId: f.cohortId,
					step: cohort.step,
					runGeneration: cohort.runJob?.generation ?? null,
					join: false,
				});
			} finally {
				measuring = false;
			}
			cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
			expect(cohort.publishedAt, "fact fill cannot publish a saved view").toBeNull();
		}
		expect(cohort.pendingContentVersionReady, "all consecutive owner families finish").toBe(true);
		expect(reads.length, "the probe measured real native transactions").toBeGreaterThan(1);
		const peak = Math.max(...reads.map((read) => read.bytesRead));
		console.info("Draft migration byte proof", { roleBytes, reads, peak });
		expect(peak, "the fixture reaches the large stored pages").toBeGreaterThan(4 * 1024 * 1024 - 3 * 1024);
		expect(peak, "each migration step leaves 3 MiB of the 16 MiB read limit free").toBeLessThan(13 * 1024 * 1024);
		for (const [index, proposal] of families.entries()) {
			const after = await read_family({ t: f.t, proposal });
			expect(after.proposal).toEqual({
				...before[index]!.proposal,
				content: {
					...before[index]!.proposal.content,
					rootKind: "plain_text",
					base: { ...before[index]!.proposal.content!.base, pendingContentVersion: 0 },
				},
			});
			expect(after.states, "large state headers stay exact").toEqual(before[index]!.states);
			expect(after.pages, "all large pages and bytes stay exact").toEqual(before[index]!.pages);
		}
	}, 60_000);

	test("extends the exact active cohort after an earlier cohort in the same run completed", async () => {
		const f = await cohort_fixture();
		const elapsed = 6_000;
		const before = await f.t.run(async (ctx) => {
			const first = (await ctx.db.get("files_move_cohorts", f.cohortId))!;
			await ctx.db.patch("files_move_cohorts", first._id, { phase: "complete", pendingContentMigration: undefined });
			const { _id, _creationTime, ...fields } = first;
			const activeId = await ctx.db.insert("files_move_cohorts", {
				...fields,
				pendingContentMigration: { cursor: null, updatedAt: Date.now() - elapsed },
			});
			return {
				first: await ctx.db.get("files_move_cohorts", first._id),
				active: (await ctx.db.get("files_move_cohorts", activeId))!,
				activity: (await ctx.db
					.query("activities")
					.withIndex("by_source_id", (q) => q.eq("source.id", first.origin.runId))
					.unique())!,
			};
		});
		await f.t.run((ctx) => files_pending_content_migration_db_extend_deadline(ctx, before.active));
		const after = await f.t.run(async (ctx) => ({
			first: await ctx.db.get("files_move_cohorts", f.cohortId),
			active: await ctx.db.get("files_move_cohorts", before.active._id),
			activity: await ctx.db.get("activities", before.activity._id),
		}));
		expect(after.active?.deadlineAt, "the later cohort receives its own migration time").toBe(
			before.active.deadlineAt + elapsed,
		);
		expect(after.active?.reviewDeadlineAt).toBe(before.active.reviewDeadlineAt + elapsed);
		expect(after.first, "the completed cohort stays exact").toEqual(before.first);
		expect(after.activity?.deadlineAt).toBe(before.activity.deadlineAt + elapsed);
		await f.t.run((ctx) => files_pending_content_migration_db_extend_deadline(ctx, before.active));
		expect(
			await f.t.run((ctx) => ctx.db.get("activities", before.activity._id)),
			"a duplicate heartbeat adds no time",
		).toEqual(after.activity);
	});

	test("keeps a new cohort with an old input unready until its native migration pages finish", async () => {
		const f = await cohort_fixture(true);
		const before = await read_family(f);
		expect(before.proposal.content?.rootKind, "the native cohort selected a pre-bridge family").toBeUndefined();
		const cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		expect(cohort.pendingContentVersionReady, "new cohort creation cannot certify its old input").not.toBe(true);
		await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { phase: "ready", workPhase: "publish" }));

		await expect(
			f.t.mutation(internal.files_move_cohorts.advance, {
				cohortId: f.cohortId,
				step: cohort.step,
				runGeneration: cohort.runJob?.generation ?? null,
				join: false,
			}),
			"incomplete facts yield a resumable migration step",
		).resolves.toMatchObject({ kind: "next" });
		const waiting = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		expect(waiting.publishedAt, "no saved view is published during fact fill").toBeNull();
		expect(waiting.pendingContentVersionReady, "one record is not the end of the native range").not.toBe(true);
		expect(waiting.phase).toBe("ready");
		expect(waiting.workPhase).toBe("publish");
		let ready = waiting;
		for (let pass = 0; pass < 30 && !ready.pendingContentVersionReady; pass++) {
			await f.t.mutation(internal.files_move_cohorts.advance, {
				cohortId: f.cohortId,
				step: ready.step,
				runGeneration: ready.runJob?.generation ?? null,
				join: false,
			});
			ready = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
			expect(ready.publishedAt, "no saved view is published during fact fill").toBeNull();
		}
		const filled = await read_family(f);
		expect(filled.proposal).toEqual({
			...before.proposal,
			content: {
				...before.proposal.content,
				rootKind: "plain_text",
				base: { ...before.proposal.content!.base, pendingContentVersion: 0 },
			},
		});
		expect(filled.states).toEqual(before.states);
		expect(filled.pages).toEqual(before.pages);

		expect(ready.pendingContentVersionReady).toBe(true);
		expect(ready.publishedAt, "readiness is separate from publication").toBeNull();
		expect(ready.pendingContentMigration).toBeUndefined();
	});

	test.each([false, true])(
		"maps an old replacement candidate without advancing published history twice, published=%s",
		async (published) => {
			const f = await cohort_fixture(true);
			if (published) await f.publish();
			await f.t.run(async (ctx) => {
				const record = (await ctx.db.get("files_move_cohort_nodes", f.recordId))!;
				const oldVersion =
					record.sourceContentVersion?.kind === "yjs"
						? { ...record.sourceContentVersion, pendingContentVersion: undefined }
						: record.sourceContentVersion;
				await ctx.db.patch("files_nodes", f.nodeId, { pendingContentVersion: undefined });
				await ctx.db.patch("files_saved_places", record.beforePlaceId!, { pendingContentVersion: undefined });
				await ctx.db.patch("files_saved_places", record.afterPlaceId!, { pendingContentVersion: undefined });
				await ctx.db.patch("files_move_cohort_nodes", record._id, { sourceContentVersion: oldVersion });
				await ctx.db.patch("files_move_cohort_content", f.contentId, {
					prepared: {
						kind: "replacement",
						membershipId: f.db.membershipId,
						pendingUpdateId: f.proposal._id,
						reviewedRevision: f.proposal.revision,
						billedUserId: f.db.userId,
						operationBatchIds: [],
						nodeId: f.nodeId,
						stagedAssetId: f.saved.assetId!,
						contentAssetId: f.saved.assetId!,
						contentSize: 8,
						contentType: "text/plain",
					},
					beforeContentVersion: oldVersion,
					afterContentVersion: oldVersion,
				});
			});
			await test_run_with_flush(f.t, async (ctx) => {
				const cohort = (await ctx.db.get("files_move_cohorts", f.cohortId))!;
				const entered = await files_move_reservations_db_enter(ctx, {
					cohortId: cohort._id,
					fence: cohort.fence,
					attemptFence: cohort.attemptFence,
					mode: published ? "finish" : "stage",
				});
				if (entered._nay) throw new Error(entered._nay.message);
				await files_pending_content_migration_db_cohort_page(ctx, cohort);
			});
			const result = await f.t.run(async (ctx) => {
				const record = (await ctx.db.get("files_move_cohort_nodes", f.recordId))!;
				return {
					node: await ctx.db.get("files_nodes", f.nodeId),
					before: await ctx.db.get("files_saved_places", record.beforePlaceId!),
					after: await ctx.db.get("files_saved_places", record.afterPlaceId!),
					content: await ctx.db.get("files_move_cohort_content", f.contentId),
				};
			});
			expect(result.node?.pendingContentVersion).toBe(1);
			expect(result.before?.pendingContentVersion).toBe(1);
			expect(result.after?.pendingContentVersion).toBe(published ? 1 : 2);
			expect(result.content?.prepared).toMatchObject({ expectedPendingContentVersion: 1 });
			expect(result.content?.beforeContentVersion).toMatchObject({ pendingContentVersion: 1 });
			expect(result.content?.afterContentVersion).toMatchObject({ pendingContentVersion: published ? 1 : 2 });
		},
	);

	test("an old prepared saved candidate reaches Review after every migration part and releases its hold", async () => {
		const f = await cohort_fixture();
		await f.t.run((ctx) => ctx.db.patch("files_move_cohorts", f.cohortId, { workPhase: "content" }));
		const prepared = await f.asUser.action((ctx) =>
			files_move_content_action_prepare(ctx, {
				cohortId: f.cohortId,
				contentId: f.contentId,
				fence: f.fence,
				attemptFence: f.attemptFence,
				runGeneration: null,
			}),
		);
		if (prepared._nay) throw new Error(prepared._nay.message);
		await strip_family(f);
		await f.t.run(async (ctx) => {
			const content = (await ctx.db.get("files_move_cohort_content", f.contentId))!;
			if (!content.prepared || content.prepared.kind === "private")
				throw new Error("Expected a saved prepared candidate");
			expect(content.prepared.expectedPendingContentVersion).toBe(1);
			await ctx.db.patch("files_move_cohort_content", content._id, {
				prepared: { ...content.prepared, expectedPendingContentVersion: undefined },
			});
			await ctx.db.patch("files_move_cohorts", f.cohortId, {
				pendingContentMigration: undefined,
				pendingContentVersionReady: undefined,
			});
		});
		const before = await read_family(f);
		let cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		let passes = 0;
		while (passes < 30 && cohort.phase === "staging") {
			await f.t.mutation(internal.files_move_cohorts.advance, {
				cohortId: f.cohortId,
				step: cohort.step,
				runGeneration: cohort.runJob?.generation ?? null,
				join: false,
			});
			cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
			passes++;
			if (cohort.errorCode) break;
		}
		expect(passes, "the old prepared candidate crosses the header and owner parts").toBeGreaterThanOrEqual(3);
		expect(cohort.errorCode, "an unproved selected family cannot reuse a pin filled in an earlier part").toBe(
			"needs_review",
		);
		expect(cohort.errorMessage).toBe("This draft needs Review on the current file. Open Review and try again.");
		expect(cohort.phase).toBe("aborting");
		expect(cohort.publishedAt).toBeNull();
		const filled = await read_family(f);
		expect(filled.proposal).toEqual({
			...before.proposal,
			content: {
				...before.proposal.content,
				rootKind: "plain_text",
				base: { ...before.proposal.content!.base, pendingContentVersion: 0 },
			},
		});
		expect(filled.states).toEqual(before.states);
		expect(filled.pages).toEqual(before.pages);
		for (let pass = 0; pass < 80 && cohort.phase !== "complete"; pass++) {
			await f.t.mutation(internal.files_move_cohorts.advance, {
				cohortId: f.cohortId,
				step: cohort.step,
				runGeneration: cohort.runJob?.generation ?? null,
				join: false,
			});
			cohort = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		}
		expect(cohort.phase, "aborting migration releases instead of retrying the same refusal").toBe("complete");
		if (cohort.origin.kind !== "transfer") throw new Error("Expected the native Transfer origin");
		const transferItemId = cohort.origin.itemId;
		await f.t.mutation(internal.files_transfer.settle_cohort, { cohortId: f.cohortId });
		const item = (await f.t.run((ctx) => ctx.db.get("files_transfer_items", transferItemId)))!;
		expect(item.state).toBe("conflict");
		expect(item.conflictKind).toBe("source_changed");
		const status = await f.asUser.query(api.files_transfer_status.get, {
			membershipId: f.db.membershipId,
			runId: item.runId,
		});
		expect(status?.activity.status).toBe("awaiting_input");
		expect(
			await f.t.run((ctx) =>
				ctx.db
					.query("files_move_source_reservations")
					.withIndex("by_source", (q) => q.eq("source.kind", "saved").eq("source.id", f.nodeId))
					.unique(),
			),
		).toBeNull();
		expect(await read_family(f), "settlement keeps the owner's full migrated family").toEqual(filled);
		await f.t.mutation(internal.files_transfer.settle_cohort, { cohortId: f.cohortId });
		expect(
			await f.t.run((ctx) => ctx.db.get("files_transfer_items", item._id)),
			"a repeated settlement cannot retry or change the blocked item",
		).toEqual(item);
	});

	test("hands off a fieldless old action and refuses its later output and failure callback", async () => {
		const f = await cohort_fixture();
		await f.t.run((ctx) => files_move_cohorts_db_schedule(ctx, { cohortId: f.cohortId, handoff: true }));
		const scope = { organizationId: f.db.organizationId, workspaceId: f.db.workspaceId, userId: f.db.userId };
		const old = await f.t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			...scope,
			target: { kind: "saved", id: f.nodeId },
			cohortContent: f.context,
			expectedPendingContentVersion: 1,
		});
		if (old._nay) throw new Error(old._nay.message);
		const initial = (await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)))!;
		const refused = await f.t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{
				...scope,
				target: { kind: "saved", id: f.nodeId },
				cohortContent: f.context,
			},
		);
		expect(refused._nay?.name).toBe("stopped");
		const current = await f.t.run(async (ctx) => ({
			cohort: (await ctx.db.get("files_move_cohorts", f.cohortId))!,
			content: (await ctx.db.get("files_move_cohort_content", f.contentId))!,
		}));
		const late = await f.t.mutation(internal.files_pending_updates.stage_prepared_content_text, {
			cohortContent: f.context,
			userId: f.db.userId,
			operationBatchId: old._yay.operationBatchId,
			role: "staged",
			text: "late old output",
		});
		expect(late._nay?.name, "old output loses its preparation fence before it can write").toBe("stopped");
		expect(current.content.preparationFence).toBe(f.context.preparationFence + 1);
		await f.t.mutation(internal.files_move_cohorts.resume, {
			cohortId: f.cohortId,
			step: initial.step,
			runGeneration: initial.runJob?.generation ?? null,
			error: { message: "Old worker failed after the handoff" },
		});
		expect(
			await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId)),
			"an old failure cannot abort or advance the replacement job",
		).toEqual(current.cohort);
		expect(current.cohort.runJob?.generation).toBe((initial.runJob?.generation ?? 0) + 1);
		await f.t.mutation(internal.files_pending_updates.create_file_pending_update_operation_batch_internal, {
			...scope,
			target: { kind: "saved", id: f.nodeId },
			cohortContent: f.context,
		});
		expect(
			await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", f.contentId)),
			"duplicate old input cannot fence its successor again",
		).toEqual(current.content);
		expect(await f.t.run((ctx) => ctx.db.get("files_move_cohorts", f.cohortId))).toEqual(current.cohort);
	});
});

describe("bridge migration operations", () => {
	test("audits a prepared partial as a state family and finds a real missing content fact", async () => {
		const f = await cohort_fixture();
		const batch = await f.t.mutation(
			internal.files_pending_updates.create_file_pending_update_operation_batch_internal,
			{
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				userId: f.db.userId,
				target: { kind: "saved", id: f.nodeId },
				cohortContent: f.context,
				expectedPendingContentVersion: 1,
			},
		);
		if (batch._nay) throw new Error(batch._nay.message);
		const input = await f.t.mutation(internal.files_pending_updates.stage_prepared_content_text, {
			cohortContent: f.context,
			userId: f.db.userId,
			operationBatchId: batch._yay.operationBatchId,
			role: "unstaged",
			text: "proposed\n",
		});
		if (input._nay) throw new Error(input._nay.message);
		const family = await read_family(f);
		await f.t.run(async (ctx) => {
			const version = await files_nodes_db_get_content_version(ctx, (await ctx.db.get("files_nodes", f.nodeId))!);
			if (version?.kind !== "yjs") throw new Error("Expected a collaborative source");
			await ctx.db.patch("files_move_cohort_content", f.contentId, {
				prepared: {
					kind: "saved_yjs",
					membershipId: f.db.membershipId,
					pendingUpdateId: f.proposal._id,
					reviewedRevision: f.proposal.revision,
					billedUserId: f.db.userId,
					operationBatchIds: [batch._yay.operationBatchId],
					nodeId: f.nodeId,
					expectedPendingContentVersion: 1,
					baseYjsSequence: version.sequence,
					baseLineageGeneration: version.lineageGeneration,
					expectedYjsLastSequenceId: version.lastSequenceId,
					partial: {
						operationBatchId: batch._yay.operationBatchId,
						baseStateId: f.proposal.content!.baseStateId,
						stagedStateId: f.proposal.content!.stagedStateId,
						unstagedStateId: f.proposal.content!.unstagedStateId,
						baseStateDigest: family.states[0]!.digest,
						stagedStateDigest: family.states[1]!.digest,
						unstagedStateDigest: family.states[2]!.digest,
						unstagedTextInputId: input._yay,
						unstagedTextChanged: true,
					},
				},
			});
		});
		const current = await f.t.query(internal.migrations.audit_pending_content, {
			table: "files_move_cohort_content",
			cursor: null,
		});
		expect(current.processed).toBeGreaterThan(0);
		expect(current.missing, "prepared state IDs do not imply a content base or root").toBe(0);
		await strip_family(f);
		const old = await f.t.query(internal.migrations.audit_pending_content, {
			table: "files_pending_updates",
			cursor: null,
		});
		expect(old.missing, "an actual old content family still needs facts").toBeGreaterThan(0);
	});

	test.each(["family", "cohort"] as const)(
		"preview rolls back a real %s migration and returns counts only",
		async (kind) => {
			const f = kind === "family" ? await fixture(false) : await cohort_fixture();
			migrations_test.register(f.t as unknown as Parameters<typeof migrations_test.register>[0]);
			if (kind === "family") await strip_family(f);
			const migration = kind === "family" ? "backfill_pending_content_families" : "backfill_pending_content_cohorts";
			const cohortId = "cohortId" in f ? f.cohortId : null;
			let cursor: string | null = null;
			if (kind === "cohort") {
				const cohorts = await f.t.run((ctx) => ctx.db.query("files_move_cohorts").order("asc").collect());
				for (const cohort of cohorts) {
					if (cohort._id === cohortId) break;
					expect(cohort.phase, "the fixture's earlier Create job is already complete").toBe("complete");
					const skipped: unknown = await f.t.mutation(internal.migrations.backfill_pending_content_cohorts, {
						cursor,
						batchSize: 1,
						oneBatchOnly: true,
						dryRun: false,
					});
					if (
						!skipped ||
						typeof skipped !== "object" ||
						!("continueCursor" in skipped) ||
						typeof skipped.continueCursor !== "string"
					)
						throw new Error("Expected a native migration cursor");
					cursor = skipped.continueCursor;
				}
			}
			const read = async () => ({
				family: await read_family(f),
				stored: await f.t.run(async (ctx) => ({
					node: await ctx.db.get("files_nodes", f.nodeId),
					cohorts: await ctx.db.query("files_move_cohorts").collect(),
					jobs: await ctx.db.system.query("_scheduled_functions").collect(),
					migrations: await ctx.runQuery(components.migrations.lib.getStatus, { limit: 100 }),
				})),
			});
			const before = await read();
			const failure: unknown = await f.t
				.mutation(internal.migrations.preview_pending_content, { migration, cursor })
				.catch((error: unknown) => error);
			expect(failure, "preview must throw after the real migration batch").toBeInstanceOf(ConvexError);
			if (!(failure instanceof ConvexError)) throw new Error("Expected the preview receipt");
			const payload: unknown = failure.data;
			if (!payload || typeof payload !== "object" || !("message" in payload) || typeof payload.message !== "string")
				throw new Error("Expected a count-only preview receipt");
			const receipt: unknown = JSON.parse(payload.message);
			expect(receipt).toEqual({
				preview: true,
				processed: 1,
				isDone: expect.any(Boolean),
				continueCursor: expect.any(String),
			});
			expect(await read(), "preview rolls back the full family, node, jobs and component state").toEqual(before);
			const actual = await f.t.mutation(internal.migrations[migration], {
				cursor,
				batchSize: 1,
				oneBatchOnly: true,
				dryRun: false,
			});
			expect(actual).toMatchObject({ processed: 1 });
			const after = await read();
			if (kind === "family") {
				expect(
					after.family.proposal.content,
					"the same real batch fills the missing facts when committed",
				).toMatchObject({ rootKind: "plain_text", base: { pendingContentVersion: 1 } });
				expect(after.family.states).toEqual(before.family.states);
				expect(after.family.pages).toEqual(before.family.pages);
			} else {
				const current = after.stored.cohorts.find((cohort) => cohort._id === cohortId)!;
				const original = before.stored.cohorts.find((cohort) => cohort._id === cohortId)!;
				expect(current.runJob?.generation, "the same real batch schedules a new cohort generation when committed").toBe(
					(original.runJob?.generation ?? 0) + 1,
				);
				expect(after.stored.jobs.length).toBeGreaterThan(before.stored.jobs.length);
			}
		},
	);
});
