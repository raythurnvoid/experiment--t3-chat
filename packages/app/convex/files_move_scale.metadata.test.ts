// Use the public Move intake and its scheduled workers. Measure only Move, after fixture setup.
// These tests check the Move byte budgets with large metadata.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { files_ROOT_ID } from "../server/files.ts";
import { r2_create_asset_key } from "./r2_client.ts";
import { files_NAME_MAX_LENGTH, files_PATH_MAX_LENGTH } from "../shared/files.ts";
import {
	files_metadata_MAX_FRONTMATTER_FIELDS,
	files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS,
} from "../shared/files-metadata.ts";
import {
	create_fixture,
	create_folder,
	finish_move,
	measure_move,
	metadata_payload,
	mock_move_scale_storage,
	read_metadata,
	start_move,
} from "./files_move_scale.setup.test.ts";

beforeEach(mock_move_scale_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("public Move scale", () => {
	test.each([false, true])(
		"keeps the largest capped native metadata below 75% of each Move byte budget (pending draft: %s)",
		async (hasDraft) => {
			const fixture = await create_fixture();
			const { t, db, asUser } = fixture;
			// A key over 160 characters gets no index docs and values are cut to 1,025 characters, so one
			// metadata doc stays small. Make the most docs one file can have, each with two 1,024-character
			// paths, before and after the Move. Public names keep only ASCII letters, digits, `-` and `_`.
			const create_deep_folder = async (letters: string[]) => {
				let parentId: Id<"files_nodes"> | "root" = files_ROOT_ID;
				let folder: Doc<"files_nodes"> | null = null;
				for (const letter of letters) {
					folder = await create_folder(fixture, letter.repeat(files_NAME_MAX_LENGTH), parentId);
					parentId = folder._id;
				}
				return folder!;
			};
			const source = await create_deep_folder(["a", "b", "c"]);
			const target = await create_deep_folder(["d", "e", "f"]);
			const name = `${"n".repeat(files_NAME_MAX_LENGTH - 3)}.md`;
			expect(`${target.path}/${name}`).toHaveLength(files_PATH_MAX_LENGTH);
			// 128 fields with 3 values each: 512 index docs, the cap for one file.
			const fields = Array.from({ length: files_metadata_MAX_FRONTMATTER_FIELDS }, (_, index) => {
				const values = [0, 1, 2].map((value) => `"${`v${index}_${value}_`.padEnd(740, "値")}"`);
				return `${`f${index}-`.padEnd(148, "k")}: [${values.join(", ")}]\n`;
			});
			const text = `---\n${fields.join("")}---\nBody.\n`;
			const size = new TextEncoder().encode(text).byteLength;
			expect(size, "the uploaded text fits the native content cap").toBeLessThanOrEqual(900_000);
			const uploaded = await asUser.mutation(api.files_nodes.create_upload_nodes, {
				membershipId: db.membershipId,
				parentId: source._id,
				onConflict: "skip",
				items: [
					{
						relativePath: name,
						size,
						contentType: "text/markdown",
					},
				],
			});
			if (uploaded._nay) throw new Error(uploaded._nay.message);
			expect(uploaded._yay.created).toHaveLength(1);
			expect(uploaded._yay.skipped).toHaveLength(0);
			const item = uploaded._yay.created[0]!;
			expect(await fetch(item.url, { method: "PUT", body: text })).toHaveProperty("status", 200);
			expect(
				await t.mutation(internal.r2.process_uploaded_asset_event, {
					assetId: item.assetId,
					r2Key: r2_create_asset_key({ ...db, assetId: item.assetId }),
					size,
					eventId: `move-scale-${item.assetId}`,
				}),
			).toEqual({ _yay: null });
			await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
			const node = (await t.run((ctx) => ctx.db.get("files_nodes", item.nodeId)))!;
			expect(node, "the native upload publishes a saved editable file before Move").toMatchObject({
				path: `${source.path}/${name}`,
				kind: "file",
				textKind: "rich_text",
			});
			expect(node.yjsSnapshotId, "the native upload finishes its text conversion before Move").toBeTruthy();
			expect(node.yjsLastSequenceId, "the native upload publishes its content sequence before Move").toBeTruthy();
			const before = await read_metadata(fixture, item.nodeId);
			// The upload also adds 3 small `metadata.*` fields.
			const frontmatter = before.filter((doc) => doc.fieldPath.startsWith("frontmatter."));
			expect(frontmatter, "the native producer stores 128 fields and 384 values").toHaveLength(
				files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS,
			);
			for (const doc of before) expect(doc.sourceKind).toBe("committed");
			for (const doc of frontmatter) expect(doc.fieldPath).toHaveLength(160);
			console.info(
				"Move scale capped metadata fixture",
				JSON.stringify({ textBytes: size, metadataDocs: before.length }),
			);
			let pendingUpdate: Doc<"files_pending_updates"> | null = null;
			if (hasDraft) {
				const batch = await asUser.mutation(api.files_pending_updates.create_file_pending_update_operation_batch, {
					membershipId: db.membershipId,
					target: { kind: "saved", id: item.nodeId },
				});
				if (batch._nay) throw new Error(batch._nay.message);
				expect(
					await asUser.mutation(api.files_pending_updates.stage_file_pending_update_text_input, {
						membershipId: db.membershipId,
						operationBatchId: batch._yay.operationBatchId,
						role: "unstaged",
						text: "Owner draft.\n",
					}),
				).toEqual({ _yay: null });
				const updated = await asUser.action(api.files_pending_updates.upsert_file_pending_update, {
					membershipId: db.membershipId,
					target: { kind: "saved", id: item.nodeId },
					operationBatchId: batch._yay.operationBatchId,
				});
				if (updated._nay) throw new Error(updated._nay.message);
				pendingUpdate = updated._yay.pendingUpdate;
				expect(pendingUpdate?.content, "the public draft producer stores content before Move").toBeTruthy();
				// The agent move door creates the owner's path and its metadata field joins.
				const pendingMove = await t.mutation(internal.files_pending_updates.upsert_file_pending_move_in_db, {
					organizationId: db.organizationId,
					workspaceId: db.workspaceId,
					userId: db.userId,
					target: { kind: "saved", id: item.nodeId },
					destParent: { kind: "root" },
					destName: "draft-metadata.md",
				});
				expect(pendingMove._nay).toBeUndefined();
				expect(
					await t.run((ctx) =>
						ctx.db
							.query("files_pending_places")
							.withIndex("by_pendingUpdate", (q) =>
								q
									.eq("pendingUpdateId", pendingUpdate!._id)
									.eq("moveView.cohortId", undefined)
									.eq("moveView.view", undefined)
							)
							.unique()
					),
					"the pending move creates an owner place before Move"
				).not.toBeNull();
				// Run ready overlay work. Running all future timers would expire the draft before Move.
				vi.advanceTimersByTime(0);
				await t.finishInProgressScheduledFunctions();
			}
			const fieldPages = new Set<string>();
			const peaks = measure_move(0.75, hasDraft ? { userId: db.userId, nodeId: item.nodeId, fieldPages } : undefined);
			await finish_move(fixture, await start_move(fixture, [item.nodeId], target._id), 1);
			if (pendingUpdate) {
				const afterDraft = await asUser.query(api.files_pending_target.get_file_pending_update, {
					membershipId: db.membershipId,
						target: { kind: "saved", id: item.nodeId },
				});
				expect(afterDraft, "Move keeps the owner's content branch").toMatchObject({
					_id: pendingUpdate._id,
					content: {
						stagedStateId: pendingUpdate.content?.stagedStateId,
						unstagedStateId: pendingUpdate.content?.unstagedStateId,
					},
				});
				expect(fieldPages.size, "the owner uses non-final metadata field pages").toBeGreaterThan(0);
				await t.run(async (ctx) => {
					const place = await ctx.db
						.query("files_pending_places")
						.withIndex("by_pendingUpdate", (q) =>
							q
								.eq("pendingUpdateId", pendingUpdate!._id)
								.eq("moveView.cohortId", undefined)
								.eq("moveView.view", undefined)
						)
						.unique();
					expect(place, "the owner keeps its pending path after Move").toMatchObject({
						ownerTreePath: "/draft-metadata.md",
					});
					if (!place) throw new Error("Expected the owner place after Move");
					const fields = await ctx.db
						.query("files_pending_place_fields")
						.withIndex("by_place", (q) =>
							q
								.eq("placeId", place._id)
								.eq("moveView.cohortId", undefined)
								.eq("moveView.view", undefined)
						)
						.collect();
					expect(fields, "the owner keeps every metadata field join").toHaveLength(before.length);
				});
			}
			const after = await read_metadata(fixture, item.nodeId);
			expect(after, "all native metadata docs survive the Move").toHaveLength(before.length);
			expect(
				after.map((doc) => JSON.stringify(metadata_payload(doc))).sort(),
				"every upload metadata payload survives the Move",
			).toEqual(before.map((doc) => JSON.stringify(metadata_payload(doc))).sort());
			for (const doc of after) {
				expect(doc.path).toBe(`${target.path}/${name}`);
				expect(doc.treePath).toBe(doc.path);
				expect(doc.moveView).toBeUndefined();
			}
			expect(
				peaks.get("cohort/sides")!.cost.documentsWritten,
				"a side step copies one page of metadata, not the whole file",
			).toBeLessThan(files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS);
			console.info("Move scale capped metadata", JSON.stringify(Object.fromEntries(peaks)));
		},
		7_200_000
	);
});
