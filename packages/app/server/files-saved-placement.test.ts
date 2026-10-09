import { R2 } from "@convex-dev/r2";
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import app_convex_schema from "../convex/schema.ts";
import { api } from "../convex/_generated/api.js";
import { test_convex, test_mocks_fill_db_with } from "../convex/setup.test.ts";
import { test_create_saved_placement_fixture as fixture } from "./files-saved-placement.test-fixtures.ts";
import {
	files_saved_placement_db_get_node,
	files_saved_placement_db_get_path,
	files_saved_placement_db_get_proposal,
	files_saved_placement_db_get_publish_receipt,
	files_saved_placement_db_get_publish_receipt_by_saved_node,
	files_saved_placement_db_get_sequence,
	files_saved_placement_db_get_slot,
	files_saved_placement_db_get_view,
	files_saved_placement_db_resolve_read_target,
} from "./files-saved-placement.ts";

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(Workpool.prototype, "enqueueAction").mockResolvedValue("saved-placement-test-work" as never);
	vi.spyOn(Workpool.prototype, "cancel").mockResolvedValue(undefined as never);
	vi.spyOn(R2.prototype, "generateUploadUrl").mockImplementation(async (key = "") => ({
		key,
		url: "https://r2.test/upload",
	}));
	vi.spyOn(R2.prototype, "syncMetadata").mockResolvedValue(undefined);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("saved placement foundation", () => {
	test("keeps the old saved identity and content at the normal name before publication", async () => {
		const f = await fixture();
		// A cleanup write may already hold the other header. The selected candidate is authoritative.
		await f.t.run((ctx) =>
			ctx.db.patch("files_nodes", f.nodeId, {
				name: f.after.name,
				path: f.after.path,
				ancestor1: f.parentId,
				contentTooLargeByteSize: 99,
			}),
		);
		const before = await f.t.run((ctx) => files_saved_placement_db_get_node(ctx.db, f.nodeId));
		expect(before, "the old saved identity and content stay at the normal name before publication").toMatchObject({
			_id: f.nodeId,
			_creationTime: f.saved._creationTime,
			name: "old.txt",
			path: "/old.txt",
			contentTooLargeByteSize: null,
			yjsSnapshotId: f.saved.yjsSnapshotId,
		});
		expect(before?.ancestor1).toBeUndefined();
		await f.publish();
		expect(await f.t.run((ctx) => files_saved_placement_db_get_node(ctx.db, f.nodeId))).toMatchObject({
			_id: f.nodeId,
			_creationTime: f.saved._creationTime,
			name: "new.txt",
			path: "/target/new.txt",
			ancestor1: f.parentId,
			contentTooLargeByteSize: 1,
			contentShapeMismatchAt: 2,
			contentYjsStateTooLargeByteSize: 3,
			contentFrontmatterTooLargeFieldCount: 4,
			contentFrontmatterTooLargeIndexDocumentCount: 5,
		});
	});

	test("uses exact slot claims for both paths and never fills a claimed empty slot", async () => {
		const f = await fixture();
		const read = (path: string, view: "before" | "after") =>
			f.t.run((ctx) => files_saved_placement_db_get_path(ctx.db, { ...f.db, path }, { cohortId: f.cohortId, view }));
		expect((await read("/old.txt", "before"))?._id).toBe(f.nodeId);
		expect(await read("/target/new.txt", "before")).toBeNull();
		expect(await read("/old.txt", "after")).toBeNull();
		expect((await read("/target/new.txt", "after"))?._id).toBe(f.nodeId);
		expect(await read("/target/new.txt/child", "after")).toBeNull();
		expect(await read("/", "after")).toBeNull();
		await f.publish();
		expect(
			await f.t.run((ctx) => files_saved_placement_db_get_slot(ctx.db, { ...f.db, parentId: "root", name: "old.txt" })),
		).toBeNull();
	});

	test("hides allocated after-only nodes and refuses a missing original before candidate", async () => {
		const f = await fixture();
		await f.t.run(async (ctx) => {
			const record = await ctx.db.get("files_move_cohort_nodes", f.recordId);
			if (!record?.beforePlaceId) throw new Error("Expected before candidate");
			await ctx.db.delete("files_saved_places", record.beforePlaceId);
		});
		await expect(f.t.run((ctx) => files_saved_placement_db_get_node(ctx.db, f.nodeId))).rejects.toThrow(
			"Saved placement candidate is missing",
		);
		await f.t.run((ctx) =>
			ctx.db.patch("files_move_cohort_nodes", f.recordId, { role: "allocated", beforePlaceId: null }),
		);
		expect(await f.t.run((ctx) => files_saved_placement_db_get_node(ctx.db, f.nodeId))).toBeNull();
		await f.publish();
		expect((await f.t.run((ctx) => files_saved_placement_db_get_node(ctx.db, f.nodeId)))?._id).toBe(f.nodeId);
	});

	test("uses the full after proposal and hides a fully accepted proposal", async () => {
		const f = await fixture();
		const { _id, _creationTime, moveCohortId: _marker, pendingMove: _move, ...afterProposal } = f.proposal;
		const itemId = await f.t.run(async (ctx) => {
			await ctx.db.patch("files_pending_updates", _id, { moveCohortId: f.cohortId });
			return await ctx.db.insert("files_move_cohort_items", {
				cohortId: f.cohortId,
				order: 0,
				origin: { kind: "transfer", itemId: f.itemId },
				pendingUpdateId: _id,
				reviewedRevision: f.proposal.revision,
				selectedContentStateId: null,
				target: f.proposal.target,
				privateVersion: null,
				mediaDependencySet: null,
				nodeRecordId: f.recordId,
				afterProposal: { ...afterProposal, revision: afterProposal.revision + 1 },
				contentId: null,
				replacementItemId: null,
				status: "staged",
				validatedEpoch: null,
				billingState: "none",
			});
		});
		expect((await f.t.run((ctx) => files_saved_placement_db_get_proposal(ctx.db, _id)))?.pendingMove).toEqual(
			f.proposal.pendingMove,
		);
		await f.publish();
		const after = await f.t.run((ctx) => files_saved_placement_db_get_proposal(ctx.db, _id));
		expect(after).toMatchObject({ _id, _creationTime, revision: f.proposal.revision + 1 });
		expect(after?.pendingMove).toBeUndefined();
		await f.t.run((ctx) => ctx.db.patch("files_move_cohort_items", itemId, { afterProposal: null }));
		expect(await f.t.run((ctx) => files_saved_placement_db_get_proposal(ctx.db, _id))).toBeNull();
	});

	test("selects owner receipts and checks their private generation", async () => {
		const f = await fixture();
		const receipt = await f.t.run((ctx) =>
			ctx.db
				.query("files_pending_node_publish_receipts")
				.withIndex("by_savedNode", (q) => q.eq("savedNodeId", f.nodeId))
				.unique(),
		);
		if (!receipt) throw new Error("Expected the public Save receipt");
		await f.t.run((ctx) =>
			ctx.db.patch("files_pending_node_publish_receipts", receipt._id, {
				moveView: { cohortId: f.cohortId, view: "after" },
			}),
		);
		const args = { ...f.db, privateNodeId: receipt.privateNodeId };
		expect(await f.t.run((ctx) => files_saved_placement_db_get_publish_receipt(ctx.db, args))).toBeNull();
		await f.publish();
		expect((await f.t.run((ctx) => files_saved_placement_db_get_publish_receipt(ctx.db, args)))?._id).toBe(receipt._id);
		expect(
			(
				await f.t.run((ctx) =>
					files_saved_placement_db_get_publish_receipt_by_saved_node(ctx.db, { ...f.db, savedNodeId: f.nodeId }),
				)
			)?._id,
		).toBe(receipt._id);
		expect(
			await f.t.run((ctx) =>
				files_saved_placement_db_resolve_read_target(ctx.db, {
					...f.db,
					target: { kind: "private", id: receipt.privateNodeId },
				}),
			),
		).toEqual({ kind: "saved", id: f.nodeId });
		await f.t.run(async (ctx) => {
			const node = await ctx.db.get("files_pending_nodes", receipt.privateNodeId);
			if (!node) throw new Error("Expected published private source");
			await ctx.db.patch("files_pending_nodes", node._id, { creationGeneration: node.creationGeneration + 1 });
		});
		expect(await f.t.run((ctx) => files_saved_placement_db_get_publish_receipt(ctx.db, args))).toBeNull();
	});

	test("a partial private proposal can only target its exact allocated saved output", async () => {
		const f = await fixture();
		const itemId = await f.t.run(async ctx => {
			const receipt = await ctx.db.query("files_pending_node_publish_receipts")
				.withIndex("by_savedNode", q => q.eq("savedNodeId", f.nodeId)).unique();
			if (!receipt) throw new Error("Expected the public Save receipt");
			const { _id, _creationTime, moveCohortId: _marker, ...header } = f.proposal;
			const target = { kind: "private" as const, id: receipt.privateNodeId };
			await ctx.db.patch("files_pending_updates", _id, { target, moveCohortId: f.cohortId });
			const itemId = await ctx.db.insert("files_move_cohort_items", {
				cohortId: f.cohortId, order: 0, origin: { kind: "transfer", itemId: f.itemId },
				pendingUpdateId: _id, reviewedRevision: header.revision, selectedContentStateId: null,
				target, privateVersion: null, mediaDependencySet: null, nodeRecordId: f.recordId,
				afterProposal: { ...header, target: { kind: "saved", id: f.nodeId }, revision: header.revision + 1 },
				contentId: null, replacementItemId: null, status: "staged", validatedEpoch: null, billingState: "none",
			});
			await ctx.db.patch("files_move_cohort_nodes", f.recordId, { itemId, role: "allocated", beforePlaceId: null });
			return itemId;
		});
		await f.publish();
		expect((await f.t.run(ctx => files_saved_placement_db_get_proposal(ctx.db, f.proposal._id)))?.target,
			"private partial content follows its exact allocated output").toEqual({ kind: "saved", id: f.nodeId });
		await f.t.run(async ctx => {
			const item = (await ctx.db.get("files_move_cohort_items", itemId))!;
			await ctx.db.patch("files_move_cohort_items", itemId, {
				afterProposal: { ...item.afterProposal!, target: { kind: "saved", id: f.parentId } },
			});
		});
		await expect(f.t.run(ctx => files_saved_placement_db_get_proposal(ctx.db, f.proposal._id)),
			"another saved target cannot replace the allocated output").rejects.toThrow("Saved after proposal changes its owner or target");
	});

	test("reads the staged sequence head without changing the physical head", async () => {
		const f = await fixture();
		const sequenceId = f.saved.yjsLastSequenceId;
		if (!sequenceId) throw new Error("Expected the public Save sequence");
		const sequence = await f.t.run((ctx) => ctx.db.get("files_yjs_docs_last_sequences", sequenceId));
		if (!sequence) throw new Error("Expected sequence head");
		await f.t.run(async (ctx) => {
			const itemId = await ctx.db.insert("files_move_cohort_items", {
				cohortId: f.cohortId, order: 0, origin: { kind: "transfer", itemId: f.itemId },
				pendingUpdateId: f.proposal._id, reviewedRevision: f.proposal.revision, selectedContentStateId: null,
				target: f.proposal.target, privateVersion: null, mediaDependencySet: null, nodeRecordId: f.recordId,
				afterProposal: null, contentId: null, replacementItemId: null, status: "staged", validatedEpoch: null,
				billingState: "none",
			});
			return await ctx.db.insert("files_move_cohort_content", {
				cohortId: f.cohortId,
				itemId,
				operationBatchId: null,
				phase: "sealed", phaseCursor: null, nextChunkIndex: 0, acceptedTextInputId: null,
				unstagedTextInputId: null, acceptedTextDigest: null, sourceSnapshotSequence: null,
				afterYjsSnapshotAssetId: null, preparationFence: 1, storageBytes: 0, storageResourceCount: 0,
				privateByteDelta: 0, privateNodeDelta: 0, privateAccountingAdded: false, storedByteDelta: 0, storedUpload: false, preparedMediaSet: null,
				previousVersion: null, acceptedVersion: null, previousVersionSnapshotId: null, acceptedVersionSnapshotId: null,
				nodeId: f.nodeId,
				pendingUpdateId: f.proposal._id,
				reviewedRevision: f.proposal.revision,
				selectedContentStateId: null,
				prepared: {
					kind: "saved_yjs",
					membershipId: f.db.membershipId,
					pendingUpdateId: f.proposal._id,
					reviewedRevision: f.proposal.revision,
					billedUserId: f.db.userId,
					operationBatchIds: [],
					nodeId: f.nodeId,
					baseYjsSequence: sequence.lastSequence,
					baseLineageGeneration: sequence.lineageGeneration,
					expectedYjsLastSequenceId: sequence._id,
				},
				beforeContentVersion: null,
				afterContentVersion: null,
				afterSnapshotId: f.saved.yjsSnapshotId,
				afterStatsId: f.saved.statsId,
				afterAssetId: f.saved.assetId,
				trustedStageId: null,
				nextSequence: 7,
				partialFamily: null,
				sealed: true,
				proofEpoch: 1,
				costCents: 0,
				afterSequence: {
					lastSequenceId: sequence._id,
					lastSequence: 7,
					lineageGeneration: sequence.lineageGeneration,
					unmaterializedUpdateCount: 1,
					unmaterializedUpdateBytes: 20,
				},
				mediaProof: null,
			});
		});
		const read = () =>
			f.t.run(async (ctx) => {
				const node = await files_saved_placement_db_get_node(ctx.db, f.nodeId);
				if (!node) throw new Error("Expected effective source");
				return await files_saved_placement_db_get_sequence(ctx.db, node);
			});
		expect((await read())?.lastSequence).toBe(sequence.lastSequence);
		await f.publish();
		expect(await read()).toMatchObject({
			_id: sequence._id,
			lastSequence: 7,
			lineageGeneration: sequence.lineageGeneration,
			unmaterializedUpdateCount: 1,
			unmaterializedUpdateBytes: 20,
		});
		expect(await f.asUser.query(api.files_nodes.get_file_last_yjs_sequence, {
			membershipId: f.db.membershipId, nodeId: f.nodeId,
		}), "the editor sees the selected sequence head").toEqual({ yjsLastSequenceId: sequence._id, lastSequence: 7 });
		expect((await f.t.run((ctx) => ctx.db.get("files_yjs_docs_last_sequences", sequence._id)))?.lastSequence).toBe(
			sequence.lastSequence,
		);
	});

	test("leaves a workspace without a slot on its normal saved view", async () => {
		const t = test_convex();
		const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
		expect(await t.run((ctx) => files_saved_placement_db_get_view(ctx.db, db))).toEqual({
			cohortId: null,
			view: null,
			generation: 0,
			searchGeneration: 0,
			migrationDirection: null,
		});
		expect(await t.run((ctx) => ctx.db.query("files_move_workspace_slots").collect())).toEqual([]);
	});

	test("keeps foundation and planned serving indexes within Convex limits", () => {
		const schema = JSON.parse((app_convex_schema as unknown as { export: () => string }).export()) as {
			tables: Array<{
				tableName: string;
				indexes: Array<{ indexDescriptor: string; fields: string[] }>;
				searchIndexes: Array<{ indexDescriptor: string; filterFields: string[] }>;
				vectorIndexes: Array<{ indexDescriptor: string }>;
			}>;
		};
		const plannedExtra = new Set([
			"files_metadata_docs",
			"files_updated_by_docs",
			"files_share_rows",
			"files_text_chunks",
			"files_plain_text_chunks",
			"files_yjs_updates",
			"files_pending_hides",
			"files_pending_places",
			"files_pending_place_fields",
			"files_pending_list_rows",
			"files_pending_list_keys",
			"files_pending_node_publish_receipts",
			"files_share_links",
		]);
		for (const table of schema.tables) {
			const plannedView = plannedExtra.has(table.tableName);
			const count =
				table.indexes.length +
				table.searchIndexes.length +
				table.vectorIndexes.length +
				(plannedView && !table.indexes.some((index) => index.indexDescriptor === "by_move_view") ? 1 : 0);
			expect(count, table.tableName).toBeLessThanOrEqual(32);
			for (const index of table.searchIndexes) {
				const extraFields = plannedView && !index.filterFields.includes("moveView.cohortId") ? 2 : 0;
				expect(
					index.filterFields.length + extraFields,
					`${table.tableName}.${index.indexDescriptor}`,
				).toBeLessThanOrEqual(16);
			}
			for (const index of table.indexes) {
				const extraFields = plannedView && !index.fields.includes("moveView.cohortId") ? 2 : 0;
				expect(index.fields.length + extraFields, `${table.tableName}.${index.indexDescriptor}`).toBeLessThanOrEqual(
					16,
				);
				expect(index.indexDescriptor.length, `${table.tableName}.${index.indexDescriptor}`).toBeLessThanOrEqual(64);
			}
		}
		expect(
			schema.tables
				.find((table) => table.tableName === "files_saved_places")
				?.searchIndexes.find((index) => index.indexDescriptor === "search_name")?.filterFields,
		).toHaveLength(16);
		expect(schema.tables.some((table) => table.tableName === "files_pending_update_plan_components")).toBe(true);
	});
});
