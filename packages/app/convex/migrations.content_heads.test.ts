import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Doc as YjsDoc, applyUpdate } from "yjs";
import type { FunctionReturnType } from "convex/server";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { data_deletion_db_request } from "./data_deletion_requests.ts";
import { create_file_fixture, mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import { upsert_file_pending_update_public_for_test } from "./files_pending_updates.setup.test.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_finish_pending_update_run,
	test_mocks_fill_db_with,
	test_move_nodes,
	test_spy_handler,
} from "./setup.test.ts";
import { run as moveRun } from "./files_move_run.ts";
import * as readUrls from "./r2_get_url.ts";
import * as overlay from "../server/files-pending-overlay.ts";
import { files_saved_content_collect, files_saved_content_db_text_chunks } from "../server/files-saved-content.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_proposal,
} from "../server/files-saved-placement.ts";
import { files_YJS_DOC_KEYS } from "../shared/files.ts";
import { files_metadata_FRONTMATTER_FIELD_PREFIX } from "../shared/files-metadata.ts";

const originalText = "Original line\n".repeat(220);
const acceptedText = "Accepted line\n".repeat(220);
const remainderText = `${acceptedText}Private remainder\n`;

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
	vi.spyOn(readUrls, "r2_get_url").mockImplementation(
		async (key) => `https://r2.test/object?key=${encodeURIComponent(key)}`,
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/migration.txt",
		textContent: originalText,
	});
	return { t, db, asUser, nodeId };
}

// Keep the native operation state. Remove only the fields absent before this bridge.
async function remove_head_fields(t: ReturnType<typeof test_convex>) {
	await t.run(async (ctx) => {
		for (const table of [
			"files_nodes",
			"files_saved_places",
			"files_text_chunks",
			"files_plain_text_chunks",
			"files_yjs_updates",
			"files_metadata_docs",
		] as const)
			for (const row of await ctx.db.query(table).collect())
				if ("contentHeadId" in row && row.contentHeadId)
					await ctx.db.patch(table, row._id, { contentHeadId: undefined });
		for (const row of await ctx.db.query("files_move_cohort_content").collect())
			await ctx.db.patch("files_move_cohort_content", row._id, {
				beforeHeadId: undefined,
				afterHeadId: undefined,
				consumedResources: undefined,
			});
		for (const row of await ctx.db.query("files_saved_content_heads").collect())
			await ctx.db.delete("files_saved_content_heads", row._id);
	});
}

async function semantic_state(t: ReturnType<typeof test_convex>) {
	return await t.run(async (ctx) => {
		const result = [];
		for (const table of [
			"files_nodes",
			"files_saved_places",
			"files_move_cohort_content",
			"files_move_cohort_items",
			"files_move_cohorts",
			"files_text_chunks",
			"files_plain_text_chunks",
			"files_yjs_updates",
			"files_metadata_docs",
			"files_metadata_maps",
			"files_yjs_snapshots",
			"files_yjs_docs_last_sequences",
			"file_stats",
			"files_snapshots",
			"files_r2_assets",
			"files_pending_updates",
			"files_pending_update_yjs_states",
			"files_pending_update_yjs_state_pages",
			"files_pending_update_expiry_checks",
			"files_private_storage_reservations",
			"quotas",
			"billing_usage_event_outbox",
		] as const) {
			const rows = await ctx.db.query(table).collect();
			result.push([
				table,
				rows.map((row) => {
					const {
						contentHeadId: _head,
						beforeHeadId: _before,
						afterHeadId: _after,
						consumedResources: _consumed,
						...value
					} = row as typeof row & {
						contentHeadId?: unknown;
						beforeHeadId?: unknown;
						afterHeadId?: unknown;
						consumedResources?: unknown;
					};
					return value;
				}),
			]);
		}
		return result;
	});
}

function migration(t: ReturnType<typeof test_convex>) {
	const functions = [
		internal.migrations.backfill_content_head_nodes,
		internal.migrations.backfill_content_head_review,
		internal.migrations.backfill_content_head_places,
		internal.migrations.backfill_content_head_text,
		internal.migrations.backfill_content_head_search,
		internal.migrations.backfill_content_head_updates,
		internal.migrations.backfill_content_head_metadata,
	];
	let index = 0;
	let cursor: string | null = null;
	let replayed = false;
	const step = async () => {
		const fn = functions[index];
		if (!fn) return false;
		const args = { oneBatchOnly: true, cursor, dryRun: false, batchSize: 1 };
		const before = await semantic_state(t);
		const result = await t.mutation(fn, args);
		expect(await semantic_state(t), "A migration page changes ownership only").toEqual(before);
		if (!result) throw new Error("Missing migration page result");
		if (!replayed && result.processed > 0) {
			const heads = await t.run((ctx) => ctx.db.query("files_saved_content_heads").collect());
			expect(await t.mutation(fn, args), "The same page can be retried").toEqual(result);
			expect(await semantic_state(t), "Retry keeps draft bytes, public IDs and receipts").toEqual(before);
			expect(
				await t.run((ctx) => ctx.db.query("files_saved_content_heads").collect()),
				"Retry does not create another head",
			).toEqual(heads);
			replayed = true;
		}
		cursor = result.isDone ? null : result.continueCursor;
		if (result.isDone) index++;
		return true;
	};
	return {
		step,
		async finish() {
			for (let page = 0; page < 100; page++) if (!(await step())) return;
			throw new Error("Content migration did not finish");
		},
	};
}

async function owned_rows(t: ReturnType<typeof test_convex>) {
	return await t.run(async (ctx) => {
		const rows = [];
		for (const table of ["files_text_chunks", "files_plain_text_chunks", "files_yjs_updates"] as const)
			for (const row of await ctx.db.query(table).collect())
				if ("fileNodeId" in row && row.fileNodeId)
					rows.push({ id: row._id, headId: row.contentHeadId, moveView: row.moveView });
		return rows;
	});
}

async function check_saved_content(f: Awaited<ReturnType<typeof fixture>>, expected: string) {
	const chunks = await f.t.run((ctx) =>
		files_saved_content_collect(
			files_saved_content_db_text_chunks(ctx.db, {
				organizationId: f.db.organizationId,
				workspaceId: f.db.workspaceId,
				nodeId: f.nodeId,
			}),
		),
	);
	expect(chunks.map((chunk) => chunk.textChunk).join(""), "Current reads keep their exact text").toBe(expected);
	const snapshot = await f.asUser.action(api.files_yjs_load.yjs_prepare_doc_last_snapshot, {
		membershipId: f.db.membershipId,
		nodeId: f.nodeId,
	});
	const updates = await f.asUser.query(api.files_yjs_load.yjs_get_incremental_updates, {
		membershipId: f.db.membershipId,
		nodeId: f.nodeId,
	});
	if (!snapshot || !updates) throw new Error("Missing public Yjs content");
	expect(updates.yjsLastSequenceId).toBe(snapshot.yjsLastSequenceId);
	const response = await fetch(snapshot.snapshotUrl);
	expect(response.status).toBe(200);
	const document = new YjsDoc();
	try {
		applyUpdate(document, new Uint8Array(await response.arrayBuffer()));
		for (const update of updates.updates)
			if (update.sequence > snapshot.snapshot.sequence) applyUpdate(document, new Uint8Array(update.update));
		expect(document.getText(files_YJS_DOC_KEYS.plainText).toString(), "Public editor bytes keep their exact text").toBe(
			expected,
		);
	} finally {
		document.destroy();
	}
}

async function check_current_owner(f: Awaited<ReturnType<typeof fixture>>) {
	await f.t.run(async (ctx) => {
		const node = await ctx.db.get("files_nodes", f.nodeId);
		if (!node?.contentHeadId) throw new Error("Missing current content head");
		const head = await ctx.db.get("files_saved_content_heads", node.contentHeadId);
		expect(head).toMatchObject({
			fileNodeId: node._id,
			ready: true,
			retired: false,
			pendingContentVersion: node.pendingContentVersion,
			yjsSnapshotId: node.yjsSnapshotId,
			yjsLastSequenceId: node.yjsLastSequenceId,
		});
		for (const table of ["files_text_chunks", "files_plain_text_chunks", "files_yjs_updates"] as const)
			for (const row of await ctx.db.query(table).collect())
				if ("fileNodeId" in row && row.fileNodeId === node._id && !row.moveView)
					expect(row.contentHeadId, "Current committed docs have the current head").toBe(node.contentHeadId);
	});
}

test.each(["before", "after old content cleanup", "abort", "unchanged"] as const)(
	"migrates content alongside Review cleanup: %s",
	async (when) => {
		const f = await fixture();
		const selectedText = when === "unchanged" ? originalText : acceptedText;
		const edited = await upsert_file_pending_update_public_for_test(f.asUser, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			stagedMarkdown: selectedText,
			unstagedMarkdown: remainderText,
		});
		if (edited._nay) throw new Error(edited._nay.message);
		const proposal = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.db.userId).eq("target.kind", "saved").eq("target.id", f.nodeId),
				)
				.unique(),
		);
		if (!proposal?.content) throw new Error("Missing native proposal");
		const canJoin = overlay.files_pending_overlay_db_can_join_step;
		vi.spyOn(overlay, "files_pending_overlay_db_can_join_step").mockImplementation(async (ctx, factor) => {
			const allowed = await canJoin(ctx, factor);
			const slot = await ctx.db
				.query("files_move_workspace_slots")
				.withIndex("by_workspace", (q) =>
					q.eq("organizationId", f.db.organizationId).eq("workspaceId", f.db.workspaceId),
				)
				.unique();
			return allowed && !slot?.cohortId;
		});
		const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 1,
			items: [
				{
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
					selectedContentStateId: proposal.content.stagedStateId,
				},
			],
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId, activityId } = started._yay;
		const backfill = migration(f.t);
		let startedMigration = false;
		let sawPromotion = false;
		let capturedCohort: Id<"files_move_cohorts"> | undefined;
		let capturedContent: Id<"files_move_cohort_content"> | undefined;
		let candidateHeadId: Id<"files_saved_content_heads"> | undefined;
		let checkedSealed = false;
		let checkedPublished = false;
		const checked = new Set<string>();
		test_spy_handler(moveRun, async (handler, ctx, args) => {
			const before = await f.t.run(async (dbCtx) => {
				const cohort = await dbCtx.db
					.query("files_move_cohorts")
					.withIndex("by_origin_run", (q) => q.eq("origin.kind", "review").eq("origin.runId", runId))
					.first();
				const content = cohort
					? await dbCtx.db
							.query("files_move_cohort_content")
							.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", f.nodeId))
							.unique()
					: null;
				return { cohort, content };
			});
			if (before.cohort) capturedCohort = before.cohort._id;
			const ready =
				when === "before"
					? !!before.cohort && before.cohort.publishedAt === null
					: when === "abort" || when === "unchanged"
						? before.content?.sealed && before.cohort?.publishedAt === null
						: before.content?.phaseCursor === "finish:1|";
			if (!startedMigration && ready) {
				if (when === "unchanged") {
					// Keep the native sealed Review. Reproduce only the former bridge's shared owner.
					await f.t.run(async (dbCtx) => {
						const content = before.content!;
						if (!content.beforeHeadId || !content.afterHeadId) throw new Error("Missing native Review owners");
						for (const table of ["files_text_chunks", "files_plain_text_chunks", "files_yjs_updates"] as const)
							for (const row of await dbCtx.db.query(table).collect())
								if (row.contentHeadId === content.afterHeadId)
									await dbCtx.db.patch(table, row._id, { contentHeadId: content.beforeHeadId });
						await dbCtx.db.patch("files_move_cohort_content", content._id, {
							afterHeadId: content.beforeHeadId,
							consumedResources: undefined,
						});
						if (content.afterHeadId !== content.beforeHeadId)
							await dbCtx.db.delete("files_saved_content_heads", content.afterHeadId);
					});
				} else await remove_head_fields(f.t);
				startedMigration = true;
				if (when === "abort")
					await f.asUser.mutation(api.activities.request_stop, { membershipId: f.db.membershipId, activityId });
				// Tag one surviving source doc before cleanup can promote it.
				for (let page = 0; page < 30; page++) {
					await backfill.step();
					const rows = await owned_rows(f.t);
					const migratedReview =
						when === "unchanged"
							? await f.t.run((dbCtx) => dbCtx.db.get("files_move_cohort_content", before.content!._id))
							: null;
					if (
						(when !== "unchanged" || migratedReview?.consumedResources !== undefined) &&
						rows.some(
							(row) =>
								row.headId &&
								(when === "after old content cleanup" ? row.moveView?.view === "after" : row.moveView?.view !== "after"),
						)
					)
						break;
					if (page === 29) throw new Error("Migration did not reach a surviving source doc");
				}
			}
			if (before.content) capturedContent = before.content._id;
			if (startedMigration) await backfill.step();
			const owners = startedMigration ? await owned_rows(f.t) : [];
			const result = await handler(ctx, args);
			if (!startedMigration) return result;
			for (const row of await owned_rows(f.t)) {
				const prior = owners.find((old) => old.id === row.id);
				if (prior?.headId)
					expect.soft(row.headId, "Promoted content docs keep their migrated owner").toBe(prior.headId);
				if (prior?.moveView && !row.moveView) sawPromotion = true;
			}
			const cohort = before.cohort
				? await f.t.run((dbCtx) => dbCtx.db.get("files_move_cohorts", before.cohort!._id))
				: null;
			const content = capturedContent
				? await f.t.run((dbCtx) => dbCtx.db.get("files_move_cohort_content", capturedContent!))
				: null;
			if (content?.afterHeadId && content.afterHeadId !== content.beforeHeadId) candidateHeadId = content.afterHeadId;
			if (content?.sealed && cohort && cohort.phase !== "aborting" && content.phaseCursor !== "abort:done") {
				expect(content.consumedResources, "Sealing or backfill captures the original draft states").toEqual(
					[proposal.content!.baseStateId, proposal.content!.stagedStateId, proposal.content!.unstagedStateId].map(
						(id) => ({ kind: "state", id }),
					),
				);
				if (when === "unchanged") {
					expect(content.prepared?.kind).toBe("saved_yjs");
					expect(content.trustedStageId, "The native Review has no accepted byte change").toBeNull();
					expect(content.afterHeadId, "Unchanged Review copies have a distinct candidate owner").not.toBe(
						content.beforeHeadId,
					);
				}
				await f.t.run(async (dbCtx) => {
					if (!content.afterHeadId) throw new Error("Missing candidate head");
					const place = await files_saved_placement_db_get_node(dbCtx.db, f.nodeId, {
						cohortId: cohort._id,
						view: "after",
					});
					if (!place) throw new Error("Missing accepted place");
					const head = await dbCtx.db.get("files_saved_content_heads", content.afterHeadId);
					const snapshot = content.afterSnapshotId
						? await dbCtx.db.get("files_yjs_snapshots", content.afterSnapshotId)
						: null;
					expect(head, "Sealed and published content keeps the accepted header and snapshot").toMatchObject({
						fileNodeId: f.nodeId,
						ready: true,
						retired: false,
						assetId: place.assetId,
						contentType: place.contentType,
						textKind: place.textKind,
						collaborationEnabled: place.collaborationEnabled,
						contentByteSize: place.contentByteSize,
						pendingContentVersion: place.pendingContentVersion,
						yjsSnapshotId: content.afterSnapshotId,
						yjsLastSequenceId: content.afterSequence?.lastSequenceId ?? null,
						statsId: content.afterStatsId,
						snapshotAssetId: snapshot?.assetId ?? null,
					});
					if (!content.afterSequence) throw new Error("Missing accepted sequence");
					const { lastSequenceId: _id, ...sequence } = content.afterSequence;
					expect(head?.sequence, "Candidate counters keep the prepared Review sequence").toEqual(sequence);
				});
				if (cohort.publishedAt === null) checkedSealed = true;
				else checkedPublished = true;
			}
			const phase = `${cohort?.phase}:${content?.phaseCursor}`;
			if (!checked.has(phase)) {
				checked.add(phase);
				await check_saved_content(f, cohort?.publishedAt != null ? selectedText : originalText);
			}
			return result;
		});
		expect(
			await f.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: f.db.membershipId, runId }),
		).toEqual({ _yay: null });
		await test_finish_pending_update_run(f.asUser, runId, { stepwise: true });
		// Stop can finish the Review status before its separate abort worker finishes.
		if (when === "abort") {
			if (!capturedCohort) throw new Error("Missing stopped cohort");
			for (let step = 0; step < 100; step++) {
				const cohort = await f.t.run((ctx) => ctx.db.get("files_move_cohorts", capturedCohort!));
				if (!cohort || cohort.phase === "complete") break;
				await f.asUser.action(internal.files_move_run.run, {
					cohortId: cohort._id,
					step: cohort.step,
					runGeneration: cohort.runJob?.generation ?? null,
					mode: "step",
				});
				if (step === 99) throw new Error("Native abort cleanup did not finish");
			}
		}
		expect(startedMigration, "The native operation reached the requested migration boundary").toBe(true);
		await backfill.finish();
		if (when !== "abort") {
			expect(sawPromotion, "Cleanup promotes an already migrated doc").toBe(true);
			expect(checkedPublished, "The test checks a published candidate").toBe(true);
			if (when === "before") expect(checkedSealed, "The test checks a sealed candidate before publication").toBe(true);
		} else {
			await f.t.run(async (ctx) => {
				for (const table of ["files_text_chunks", "files_plain_text_chunks", "files_yjs_updates"] as const)
					expect(
						(await ctx.db.query(table).collect()).filter((row) => row.moveView),
						"Abort clears all candidate and before tags",
					).toEqual([]);
				if (candidateHeadId) {
					const candidate = await ctx.db.get("files_saved_content_heads", candidateHeadId);
					if (candidate)
						expect(candidate, "An aborted candidate is retired").toMatchObject({ ready: false, retired: true });
					expect((await ctx.db.get("files_nodes", f.nodeId))?.contentHeadId).not.toBe(candidateHeadId);
				}
			});
		}
		await check_saved_content(f, when === "abort" ? originalText : selectedText);
		await check_current_owner(f);
		const remaining = await f.t.run((ctx) => files_saved_placement_db_get_proposal(ctx.db, proposal._id));
		expect(remaining?.content, "The remaining draft keeps a complete family").toBeDefined();
		if (when === "abort") expect(remaining).toEqual(proposal);
		const beforeRetry = await semantic_state(f.t);
		await migration(f.t).finish();
		expect(await semantic_state(f.t), "A full migration retry keeps drafts, history and charges").toEqual(beforeRetry);
	},
);

test("old Review history cannot replace the newer content owner", async () => {
	const f = await fixture();
	const reviews = [];
	for (const text of ["First saved text\n", "Second saved text\n"]) {
		vi.setSystemTime(Date.now() + 1_000);
		const edited = await upsert_file_pending_update_public_for_test(f.asUser, {
			membershipId: f.db.membershipId,
			nodeId: f.nodeId,
			stagedMarkdown: text,
			unstagedMarkdown: text,
		});
		if (edited._nay) throw new Error(edited._nay.message);
		const proposal = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.db.userId).eq("target.kind", "saved").eq("target.id", f.nodeId),
				)
				.unique(),
		);
		if (!proposal?.content) throw new Error("Missing native proposal");
		const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: f.db.membershipId,
			requestId: crypto.randomUUID(),
			kind: "accept",
			expectedItemCount: 1,
			items: [
				{
					pendingUpdateId: proposal._id,
					reviewedRevision: proposal.revision,
					selectedContentStateId: proposal.content.stagedStateId,
				},
			],
		});
		if (started._nay) throw new Error(started._nay.message);
		const { runId, activityId } = started._yay;
		expect(
			await f.asUser.mutation(api.files_pending_update_runs.seal, { membershipId: f.db.membershipId, runId }),
		).toEqual({ _yay: null });
		await test_finish_pending_update_run(f.asUser, runId);
		reviews.push(
			await f.t.run(async (ctx) => {
				const cohort = await ctx.db
					.query("files_move_cohorts")
					.withIndex("by_origin_run", (q) => q.eq("origin.kind", "review").eq("origin.runId", runId))
					.unique();
				const content = cohort
					? await ctx.db
							.query("files_move_cohort_content")
							.withIndex("by_cohort_node", (q) => q.eq("cohortId", cohort._id).eq("nodeId", f.nodeId))
							.unique()
					: null;
				const activity = await ctx.db.get("activities", activityId);
				if (!cohort || !content || !activity?.expiresAt) throw new Error("Missing native Review history");
				expect(cohort.phase).toBe("complete");
				expect(content.phaseCursor).toBe("finish:done");
				return { runId, activityId, cohort, content, expiresAt: activity.expiresAt };
			}),
		);
	}
	const [first, second] = reviews;
	if (!first || !second?.content.afterHeadId) throw new Error("Missing saved content owners");
	const currentHeadId = second.content.afterHeadId;
	expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.contentHeadId).toBe(currentHeadId);
	// An old completed Review may not have been reached by the migration yet.
	await f.t.run((ctx) =>
		ctx.db.patch("files_move_cohort_content", first.content._id, { beforeHeadId: undefined, afterHeadId: undefined }),
	);
	let cursor: string | null = null;
	for (let page = 0; page < 20; page++) {
		const result: FunctionReturnType<typeof internal.migrations.backfill_content_head_review> = await f.t.mutation(
			internal.migrations.backfill_content_head_review,
			{ oneBatchOnly: true, cursor, dryRun: false, batchSize: 1 },
		);
		if (!result) throw new Error("Missing migration page result");
		if (result.isDone) break;
		cursor = result.continueCursor;
		if (page === 19) throw new Error("Review migration did not finish");
	}
	const backfilled = await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", first.content._id));
	expect.soft(backfilled?.beforeHeadId, "Unmapped completed history stays unmapped").toBeUndefined();
	expect.soft(backfilled?.afterHeadId, "Unmapped completed history stays unmapped").toBeUndefined();
	expect
		.soft(
			(await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.contentHeadId,
			"Historical backfill keeps the newer content head",
		)
		.toBe(currentHeadId);
	// Also cover history which was mapped before the newer Review saved its text.
	await f.t.run((ctx) =>
		ctx.db.patch("files_move_cohort_content", first.content._id, {
			beforeHeadId: first.content.beforeHeadId,
			afterHeadId: first.content.afterHeadId,
		}),
	);
	vi.setSystemTime(first.expiresAt);
	for (let pass = 0; pass < 100; pass++) {
		const result = await f.t.mutation(internal.files_pending_updates.cleanup_expired_pending_state_rows, {
			_test_disableReschedule: true,
		});
		if (result.done) break;
		if (pass === 99) throw new Error("Review storage cleanup did not finish");
	}
	expect(
		(await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", first.content._id)))?.storageResourceCount,
	).toBe(0);
	for (let pass = 0; pass < 100; pass++) {
		await f.t.mutation(internal.activities.cleanup_history, { _test_disableReschedule: true });
		if (!(await f.t.run((ctx) => ctx.db.get("activities", first.activityId)))) break;
		if (pass === 99) throw new Error("Review history cleanup did not finish");
	}
	expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", first.runId))).toBeNull();
	expect(await f.t.run((ctx) => ctx.db.get("files_pending_update_runs", second.runId))).not.toBeNull();
	await f.t.mutation(internal.files_move_cohorts.cleanup, { cohortId: first.cohort._id });
	expect(await f.t.run((ctx) => ctx.db.get("files_move_cohort_content", first.content._id))).toBeNull();
	expect
		.soft(
			(await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.contentHeadId,
			"Old Review history cleanup keeps the newer content head",
		)
		.toBe(currentHeadId);
	await check_saved_content(f, "Second saved text\n");
	const afterCleanup = await f.t.run(async (ctx) => ({
		node: await ctx.db.get("files_nodes", f.nodeId),
		heads: await ctx.db.query("files_saved_content_heads").collect(),
		rows: await ctx.db.query("files_text_chunks").collect(),
	}));
	await f.t.mutation(internal.files_move_cohorts.cleanup, { cohortId: first.cohort._id });
	expect(
		await f.t.run(async (ctx) => ({
			node: await ctx.db.get("files_nodes", f.nodeId),
			heads: await ctx.db.query("files_saved_content_heads").collect(),
			rows: await ctx.db.query("files_text_chunks").collect(),
		})),
		"Repeated history cleanup keeps current content unchanged",
	).toEqual(afterCleanup);
	await check_current_owner(f);
});

test("a plain Move keeps the migrated content owner", async () => {
	const f = await fixture();
	await remove_head_fields(f.t);
	await migration(f.t).finish();
	const headId = (await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))!.contentHeadId;
	const listed = await f.asUser.query(api.files_tree.list_tree_children, {
		membershipId: f.db.membershipId,
		stream: "normal",
		parentId: "root",
		kind: "file",
		archived: false,
		restricted: false,
		paginationOpts: { cursor: null, numItems: 10 },
	});
	expect(listed.page.map((node) => node._id), "The public tree still accepts migrated file rows").toEqual([f.nodeId]);
	expect(listed.page[0], "Internal content ownership stays out of public tree rows").not.toHaveProperty(
		"contentHeadId",
	);
	const folder = await f.asUser.mutation(api.files_nodes.create_folder_node, {
		membershipId: f.db.membershipId,
		parentId: "root",
		path: "dest",
	});
	if (folder._nay) throw new Error(folder._nay.message);
	let sawPlaces = false;
	expect(
		await test_move_nodes(f.t, f.asUser, {
			membershipId: f.db.membershipId,
			itemIds: [f.nodeId],
			targetParentId: folder._yay.nodeId,
			onStep: async () => {
				const places = await f.t.run((ctx) => ctx.db.query("files_saved_places").collect());
				for (const place of places)
					if (place.nodeId === f.nodeId) {
						sawPlaces = true;
						expect(place.contentHeadId, "Move locations share the same content owner").toBe(headId);
					}
			},
		}),
	).toEqual({ _yay: null });
	expect(sawPlaces).toBe(true);
	expect((await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)))?.contentHeadId).toBe(headId);
	await check_current_owner(f);
	await check_saved_content(f, originalText);
});

test("frontmatter gets a content owner while metadata and pending docs stay unchanged", async () => {
	const f = await create_file_fixture("rich_text", "---\nstatus: saved\n---\nSaved body\n");
	expect(
		await f.asUser.mutation(api.files_metadata.set_entries, {
			membershipId: f.db.membershipId,
			fileNodeId: f.nodeId,
			metadataYaml: "label: kept",
		}),
	).toEqual({ _yay: null });
	const edited = await upsert_file_pending_update_public_for_test(f.asUser, {
		membershipId: f.db.membershipId,
		nodeId: f.nodeId,
		stagedMarkdown: "---\nstatus: draft\n---\nDraft body\n",
		unstagedMarkdown: "---\nstatus: draft\n---\nDraft body\n",
	});
	if (edited._nay) throw new Error(edited._nay.message);
	await remove_head_fields(f.t);
	const before = await semantic_state(f.t);
	await migration(f.t).finish();
	expect(await semantic_state(f.t), "Migration keeps metadata maps and draft state").toEqual(before);
	await f.t.run(async (ctx) => {
		const node = (await ctx.db.get("files_nodes", f.nodeId))!;
		expect(node.contentHeadId).toBeDefined();
		const rows = await ctx.db.query("files_metadata_docs").collect();
		const frontmatter = rows.filter(
			(row) => row.sourceKind === "committed" && row.fieldPath.startsWith(files_metadata_FRONTMATTER_FIELD_PREFIX),
		);
		const metadata = rows.filter((row) => row.sourceKind === "committed" && row.fieldPath === "metadata.label");
		const pending = rows.filter((row) => row.sourceKind === "pending");
		expect(frontmatter.length, "The native save produced frontmatter").toBeGreaterThan(0);
		expect(metadata.length, "The Properties write produced metadata").toBeGreaterThan(0);
		expect(pending.length, "The native edit produced pending index docs").toBeGreaterThan(0);
		for (const row of frontmatter)
			expect("contentHeadId" in row ? row.contentHeadId : undefined).toBe(node.contentHeadId);
		for (const row of [...metadata, ...pending]) expect(row).not.toHaveProperty("contentHeadId");
	});
});

test("workspace deletion removes the file's content head and can be retried", async () => {
	const f = await fixture();
	const node = await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId));
	if (!node?.contentHeadId) throw new Error("Missing current content head");
	const headId = node.contentHeadId;
	expect(await f.t.run((ctx) => ctx.db.get("files_saved_content_heads", headId))).toMatchObject({
		fileNodeId: f.nodeId,
		ready: true,
	});
	const requestId = await f.t.run((ctx) =>
		data_deletion_db_request(ctx, {
			userId: f.db.userId,
			organizationId: f.db.organizationId,
			workspaceId: f.db.workspaceId,
			scope: "workspace",
			eligibleAt: Date.now(),
		}),
	);
	let done = false;
	for (let pass = 0; pass < 200; pass++) {
		const result = await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, {
			requestId,
			_test_batchSize: 1,
		});
		if (result.done) {
			done = true;
			break;
		}
	}
	expect(done, "Native workspace cleanup finishes").toBe(true);
	expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId)), "The saved file is deleted").toBeNull();
	expect(
		await f.t.run((ctx) => ctx.db.get("files_saved_content_heads", headId)),
		"The deleted file's current content head is removed",
	).toBeNull();
	expect(
		await f.t.mutation(internal.data_deletion.process_workspace_deletion_request, { requestId, _test_batchSize: 1 }),
	).toEqual({ done: true, deletedCount: 0 });
	expect(await f.t.run((ctx) => ctx.db.get("files_nodes", f.nodeId))).toBeNull();
	expect(
		await f.t.run((ctx) => ctx.db.get("files_saved_content_heads", headId)),
		"Retry keeps the deleted file's content head removed",
	).toBeNull();
});
