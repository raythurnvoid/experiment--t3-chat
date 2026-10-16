import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { test_run_with_flush, test_spy_handler } from "./setup.test.ts";
import { files_media_dependencies_db_create } from "./files_media_dependencies.ts";
import { advance as advance_cohort } from "./files_move_cohorts.ts";
import { files_nodes_content_db_discard_transfer_file_capture } from "./files_transfer_assets_db.ts";
import {
	finalize_transfer_file_copy,
	prepare_transfer_file_media,
	seal_transfer_file_capture,
} from "./files_nodes_content.ts";
import {
	fixture as review_fixture,
	finish_review,
	mock_review_storage,
	private_node,
	saved_text,
	stage_text,
	start_review,
} from "./files_pending_update_runs_content.setup.test.ts";
import {
	fixture as copy_fixture,
	mock_media_storage,
	prepare_document_capture,
} from "./files_transfer_media.setup.test.ts";
import { files_db_load_pending_update_yjs_state_bytes, files_u8_to_array_buffer } from "../server/files.ts";
import { files_metadata_maps_db_read, files_metadata_maps_db_write } from "../server/files-metadata-maps.ts";
import { files_yjs_doc_create_from_array_buffer_update } from "../shared/files-yjs.ts";
import { files_yjs_doc_get_text } from "../shared/files-tiptap.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("old media bridge in Review", () => {
	beforeEach(mock_review_storage);

	test("start and append leave old media fields out of their frozen headers", async () => {
		const f = await review_fixture();
		const proposals = [await private_node({ f, path: "/first" }), await private_node({ f, path: "/second" })];
		const setIds = await f.t.run(async (ctx) => {
			const ids = [];
			for (const proposal of proposals) {
				const created = await files_media_dependencies_db_create(ctx, {
					...f.scope,
					owner: { kind: "proposal", pendingUpdateId: proposal._id },
					expectedCount: 0,
				});
				if (created._nay) throw new Error(created._nay.message);
				await ctx.db.patch("files_pending_updates", proposal._id, { mediaDependencySetId: created._yay });
				ids.push(created._yay);
			}
			return ids;
		});
		const items = proposals.map((proposal) => ({
			pendingUpdateId: proposal._id,
			reviewedRevision: proposal.revision,
			selectedContentStateId: null,
		}));
		const started = await f.asUser.mutation(api.files_pending_update_runs.start, {
			membershipId: f.db.membershipId,
			requestId: "old-media-review",
			kind: "accept",
			expectedItemCount: 2,
			items: items.slice(0, 1),
		});
		if (started._nay) throw new Error(started._nay.message);
		expect(
			await f.asUser.mutation(api.files_pending_update_runs.append_items, {
				membershipId: f.db.membershipId,
				runId: started._yay.runId,
				offset: 1,
				items: items.slice(1),
			}),
		).toEqual({ _yay: null });
		const captured = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_update_run_items")
				.withIndex("by_run_order", (q) => q.eq("runId", started._yay.runId))
				.collect(),
		);
		expect(captured).toHaveLength(2);
		for (const [index, item] of captured.entries()) {
			expect.soft(item, "new Review items omit the unused null proof").not.toHaveProperty("mediaDependencySet");
			expect.soft(item.reviewHeader, "frozen Review headers omit the old proposal media ID").not.toHaveProperty(
				"mediaDependencySetId",
			);
			expect(item.reviewHeader).toMatchObject({
				target: proposals[index]!.target,
				revision: proposals[index]!.revision,
			});
			expect(await f.t.run((ctx) => ctx.db.get("files_pending_updates", proposals[index]!._id))).toMatchObject({
				mediaDependencySetId: setIds[index],
			});
		}
	});

	test("partial Save keeps its text while every remainder drops the old media ID", async () => {
		const f = await review_fixture();
		const draft = await private_node({ f, path: "/partial.txt", text: "initial\n" });
		const batch = await f.asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
			membershipId: f.db.membershipId,
			target: draft.target,
		});
		if (batch._nay) throw new Error(batch._nay.message);
		const partial = await stage_text({
			f,
			target: draft.target,
			operationBatchId: batch._yay.operationBatchId,
			pendingUpdateId: draft._id,
			text: "selected\n",
			unstagedText: "remainder\n",
		});
		const setId = await f.t.run(async (ctx) => {
			await files_metadata_maps_db_write(ctx.db, {
				...f.scope,
				owner: { kind: "pending", id: partial._id },
				entries: [{ key: "keep", value: "draft metadata" }],
			});
			const created = await files_media_dependencies_db_create(ctx, {
				...f.scope,
				owner: { kind: "proposal", pendingUpdateId: partial._id },
				expectedCount: 0,
			});
			if (created._nay) throw new Error(created._nay.message);
			await ctx.db.patch("files_pending_updates", partial._id, { mediaDependencySetId: created._yay });
			return created._yay;
		});
		let sawInitial = false;
		let sawPrepared = false;
		let replayedOldRemainder = false;
		test_spy_handler(advance_cohort, async (handler, ctx, args) => {
			const { cohortId } = args as { cohortId: Id<"files_move_cohorts"> };
			const result = await handler(ctx, args);
			const item = await ctx.db
				.query("files_move_cohort_items")
				.withIndex("by_cohort_order", (q) => q.eq("cohortId", cohortId))
				.first();
			if (item && !replayedOldRemainder) {
				expect.soft(item, "new Move items omit the unused null proof").not.toHaveProperty("mediaDependencySet");
				if (item.afterProposal?.target.kind === "private") {
					sawInitial = true;
					expect
						.soft(item.afterProposal, "initial Move remainders omit the old media ID")
						.not.toHaveProperty("mediaDependencySetId");
				}
				if (item.afterProposal?.target.kind === "saved") {
					sawPrepared = true;
					expect
						.soft(item.afterProposal, "prepared Move remainders omit the old media ID")
						.not.toHaveProperty("mediaDependencySetId");
					// Grouped pages may finish nodes in the next call. Seed the old header before that call.
					const cohort = await ctx.db.get("files_move_cohorts", cohortId);
					expect(cohort?.phase, "the old remainder is seeded before Move completes").not.toBe("complete");
					await ctx.db.patch("files_move_cohort_items", item._id, {
						afterProposal: { ...item.afterProposal, mediaDependencySetId: setId },
					});
					replayedOldRemainder = true;
				}
			}
			return result;
		});
		const runId = await start_review({ f, proposals: [partial], selected: "staged" });
		const completed = await finish_review({ f, runId });
		expect(completed?.activity.status).toBe("succeeded");
		expect({ sawInitial, sawPrepared, replayedOldRemainder }, "all three native remainder paths ran").toEqual({
			sawInitial: true,
			sawPrepared: true,
			replayedOldRemainder: true,
		});
		const remainder = await f.t.run((ctx) => ctx.db.get("files_pending_updates", partial._id));
		expect(remainder, "materializing an old remainder cannot restore its old media ID").not.toHaveProperty(
			"mediaDependencySetId",
		);
		expect(remainder).toMatchObject({ target: { kind: "saved" }, revision: partial.revision + 1 });
		if (remainder?.target.kind !== "saved") throw new Error("Expected the saved remainder");
		expect(await saved_text(f, remainder.target.id)).toBe("selected\n");
		const savedId = remainder.target.id;
		expect(
			await f.t.run(async (ctx) => ({
				saved: (await files_metadata_maps_db_read(ctx.db, { kind: "saved", id: savedId }))?.entries,
				pending: await files_metadata_maps_db_read(ctx.db, { kind: "pending", id: partial._id }),
			})),
			"partial Save publishes metadata and removes its old pending map",
		).toEqual({ saved: [{ key: "keep", value: "draft metadata" }], pending: null });
		const bytes = await f.t.run(async (ctx) => {
			const stateDoc = await ctx.db.get("files_pending_update_yjs_states", remainder.content!.unstagedStateId);
			if (!stateDoc) throw new Error("Expected the remaining text state");
			const loaded = await files_db_load_pending_update_yjs_state_bytes(ctx, { stateDoc });
			if (loaded._nay) throw new Error(loaded._nay.message);
			return files_u8_to_array_buffer(loaded._yay);
		});
		const document = files_yjs_doc_create_from_array_buffer_update(bytes);
		try {
			expect(files_yjs_doc_get_text({ yjsDoc: document, rootKind: "plain_text" })).toEqual({ _yay: "remainder\n" });
		} finally {
			document.destroy();
		}
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", setId))).toMatchObject({
			owner: { kind: "proposal", pendingUpdateId: partial._id },
		});
	});
});

describe("old media bridge in Copy", () => {
	beforeEach(mock_media_storage);

	test("prepare, seal and finish omit the old source set and keep the current proof", async () => {
		const f = await copy_fixture();
		if (f.document.source.kind !== "saved") throw new Error("Expected the saved Copy source");
		expect(
			await f.asUser.mutation(api.files_metadata.set_entries, {
				membershipId: f.source.membershipId,
				fileNodeId: f.document.source.id,
				metadataYaml: "keep: copy metadata",
			}),
		).toEqual({ _yay: null });
		let sawPrepare = false;
		let sawSeal = false;
		let sawFinish = false;
		let activeSetId: Id<"files_media_dependency_sets"> | undefined;
		const oldSet = await f.t.run(async (ctx) => {
			const target = f.selectedMedia!.outputTarget!;
			const proposal = await ctx.db
				.query("files_pending_updates")
				.withIndex("by_user_target", (q) =>
					q.eq("userId", f.destination.userId).eq("target.kind", target.kind).eq("target.id", target.id),
				)
				.first();
			if (!proposal) throw new Error("Expected the copied media proposal");
			const created = await files_media_dependencies_db_create(ctx, {
				organizationId: f.destination.organizationId,
				workspaceId: f.destination.workspaceId,
				userId: f.destination.userId,
				owner: { kind: "proposal", pendingUpdateId: proposal._id },
				expectedCount: 0,
			});
			if (created._nay) throw new Error(created._nay.message);
			return (await ctx.db.get("files_media_dependency_sets", created._yay))!;
		});
		const oldSourceSet = { setId: oldSet._id, generation: oldSet.generation };
		for (const [registered, step] of [
			[prepare_transfer_file_media, "prepare"],
			[seal_transfer_file_capture, "seal"],
			[finalize_transfer_file_copy, "finish"],
		] as const)
			test_spy_handler(registered, async (handler, ctx, args) => {
				const { itemId } = args as { itemId: Id<"files_transfer_items"> };
				const item = await ctx.db.get("files_transfer_items", itemId);
				const shouldCheck =
					itemId === f.document._id &&
					item?.capture &&
					(step === "prepare"
						? !item.capture.mediaDependencySetId
						: step === "seal"
							? !item.capture.artifact
							: item.state !== "completed");
				const metadata = shouldCheck
					? await files_metadata_maps_db_read(ctx.db, { kind: "capture", id: itemId })
					: null;
				if (shouldCheck)
					await ctx.db.patch("files_transfer_items", itemId, {
						capture: { ...item!.capture!, mediaSourceSet: oldSourceSet },
					});
				const result = await handler(ctx, args);
				if (shouldCheck) {
					const after = await ctx.db.get("files_transfer_items", itemId);
					expect(metadata?.entries, `${step} starts with a full captured map`).toEqual([
						{ key: "keep", value: "copy metadata" },
					]);
					expect(
						await files_metadata_maps_db_read(ctx.db, { kind: "capture", id: itemId }),
						`${step} keeps the exact captured metadata map`,
					).toEqual(metadata);
					expect.soft(after?.capture, `${step} omits the old Copy source set`).not.toHaveProperty("mediaSourceSet");
					expect.soft(after?.capture?.mediaDependencySetId, `${step} keeps the current Copy proof`).toBeDefined();
					activeSetId ??= after?.capture?.mediaDependencySetId;
					expect.soft(after?.capture?.mediaDependencySetId).toBe(activeSetId);
					if (step === "prepare") sawPrepare = true;
					else if (step === "seal") sawSeal = true;
					else sawFinish = true;
				}
				return result;
			});
		await f.t.action(internal.files_nodes_content.copy_transfer_file, {
			itemId: f.document._id,
			attempt: f.document.attempt,
		});
		expect({ sawPrepare, sawSeal, sawFinish }, "all three native Copy paths ran").toEqual({
			sawPrepare: true,
			sawSeal: true,
			sawFinish: true,
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id))).toMatchObject({
			state: "completed",
			capture: { mediaDependencySetId: activeSetId },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", oldSet._id))).toEqual(oldSet);
	});

	test("discard drops the old source set and retires only its current capture set", async () => {
		const f = await copy_fixture();
		if (f.document.source.kind !== "saved") throw new Error("Expected the saved Copy source");
		expect(
			await f.asUser.mutation(api.files_metadata.set_entries, {
				membershipId: f.source.membershipId,
				fileNodeId: f.document.source.id,
				metadataYaml: "keep: captured metadata",
			}),
		).toEqual({ _yay: null });
		await prepare_document_capture(f);
		const metadata = await f.t.run((ctx) =>
			files_metadata_maps_db_read(ctx.db, { kind: "capture", id: f.document._id }),
		);
		expect(metadata?.entries).toEqual([{ key: "keep", value: "captured metadata" }]);
		const before = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		const capture = before!.capture!;
		const activeSetId = capture.mediaDependencySetId!;
		const sourceAsset = await f.t.run((ctx) => ctx.db.get("files_r2_assets", f.media.assetId));
		await f.t.run((ctx) =>
			ctx.db.patch("files_transfer_items", f.document._id, {
				capture: { ...capture, mediaSourceSet: { setId: activeSetId, generation: 0 } },
			}),
		);
		await test_run_with_flush(f.t, (ctx) =>
			files_nodes_content_db_discard_transfer_file_capture(ctx, { itemId: f.document._id }),
		);
		const after = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.document._id));
		expect(after?.capture, "discard omits the old Copy source set").not.toHaveProperty("mediaSourceSet");
		expect(
			await f.t.run((ctx) => files_metadata_maps_db_read(ctx.db, { kind: "capture", id: f.document._id })),
			"discard keeps the exact captured metadata map",
		).toEqual(metadata);
		const { mediaDependencySetId: _setId, ...kept } = capture;
		expect(after?.capture).toEqual({ ...kept, sourceStateId: null, artifact: null });
		expect(await f.t.run((ctx) => ctx.db.get("files_media_dependency_sets", activeSetId))).toMatchObject({
			owner: { kind: "cleanup" },
		});
		expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", f.media.assetId))).toEqual(sourceAsset);
	});
});
