// Use the public Move intake and its scheduled workers. Measure only Move, after fixture setup.
// These tests check the Move byte budgets with large metadata.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { test_create_saved_text_file } from "./setup.test.ts";
import { files_ROOT_ID } from "../server/files.ts";
import { r2_create_asset_key } from "./r2_client.ts";
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
	test("pages 896 native metadata docs when repeated destination paths exceed 16 MiB", async () => {
		const fixture = await create_fixture();
		const { t, db, asUser } = fixture;
		const dates = Array.from({ length: 128 }, (_, index) =>
			new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10));
		const frontmatter = ["---", ...dates.map((date, index) =>
			`field${index}: ["distinct-${index}", "${date}"]`), "---", "", "Body.", ""].join("\n");
		const nodeId = await test_create_saved_text_file(t, {
			membershipId: db.membershipId,
			path: "/heavy.md",
			textContent: frontmatter,
		});
		expect(
			await asUser.mutation(api.files_metadata.set_entries, {
				membershipId: db.membershipId,
				fileNodeId: nodeId,
				metadataYaml: dates.map((date, index) => `key${index}: "${date}"`).join("\n"),
			}),
		).toEqual({ _yay: null });
		// The public saved folder door has no name length cap.
		const target = await create_folder(fixture, "d".repeat(12_000));
		await t.finishAllScheduledFunctions(vi.runAllTimers, 10_000);
		const before = await read_metadata(fixture, nodeId);
		expect(before.filter((doc) => doc.fieldPath.startsWith("frontmatter."))).toHaveLength(512);
		expect(before.filter((doc) => doc.fieldPath.startsWith("metadata."))).toHaveLength(384);
		expect(before).toHaveLength(896);
		const path = `${target.path}/heavy.md`;
		const repeatedPathBytes = new TextEncoder().encode(path).byteLength * 2 * before.length;
		expect(repeatedPathBytes, "whole-file path copies alone exceed one transaction's write bytes")
			.toBeGreaterThan(16 * 1024 * 1024);
		const peaks = measure_move();
		await finish_move(fixture, await start_move(fixture, [nodeId], target._id), 1);
		expect(await t.run((ctx) => ctx.db.get("files_nodes", nodeId))).toMatchObject({
			path,
			treePath: path,
			parentId: target._id,
		});
		const after = await read_metadata(fixture, nodeId);
		expect(after, "all 896 native metadata docs survive the long-path Move").toHaveLength(896);
		// Value docs share a field key. New doc IDs may change their order within that key.
		expect(
			after.map((doc) => JSON.stringify(metadata_payload(doc))).sort(),
			"every native metadata field and value survives Move",
		).toEqual(before.map((doc) => JSON.stringify(metadata_payload(doc))).sort());
		for (const doc of after) {
			expect(doc.path, "every native metadata doc has the long destination path").toBe(path);
			expect(doc.treePath).toBe(path);
			expect(doc.moveView).toBeUndefined();
			if (doc.docKind === "field") expect(doc.parentId).toBe(target._id);
		}
		expect(peaks.get("cohort/sides")!.calls, "metadata uses several side pages").toBeGreaterThan(1);
		console.info("Move scale long path", JSON.stringify({ repeatedPathBytes, phases: Object.fromEntries(peaks) }));
	}, 7_200_000);

	test.each([false, true])(
		"keeps a native large frontmatter key below 75% of each Move byte budget (pending draft: %s)",
		async (hasDraft) => {
			const fixture = await create_fixture();
			const { t, db, asUser } = fixture;
			const target = await create_folder(fixture, "target");
			const key = "k".repeat(890_000);
			// Explicit YAML keys may be longer than the 1024-character limit on implicit keys.
			const extraFields = hasDraft
				? Array.from({ length: 46 }, (_, index) => `a${index}: value${index}\n`).join("")
				: "";
			const text = `---\n${extraFields}? ${key}\n: ["v0", "v1", "v2", "v3", "v4", "v5", "v6"]\n---\nBody.\n`;
			const size = new TextEncoder().encode(text).byteLength;
			expect(size, "the uploaded text fits the native content cap").toBeLessThanOrEqual(900_000);
			const uploaded = await asUser.mutation(api.files_nodes.create_upload_nodes, {
				membershipId: db.membershipId,
				parentId: files_ROOT_ID,
				onConflict: "skip",
				items: [
					{
						relativePath: "large-key.md",
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
				path: "/large-key.md",
				kind: "file",
				textKind: "rich_text",
			});
			expect(node.yjsSnapshotId, "the native upload finishes its text conversion before Move").toBeTruthy();
			expect(node.yjsLastSequenceId, "the native upload publishes its content sequence before Move").toBeTruthy();
			const before = await read_metadata(fixture, item.nodeId);
			const frontmatter = before.filter((doc) => doc.fieldPath === `frontmatter.${key}`);
			expect(frontmatter, "the native producer stores one large field and seven distinct values").toHaveLength(8);
			for (const doc of before) {
				expect(doc.sourceKind).toBe("committed");
			}
			for (const doc of frontmatter) {
				expect(doc.fieldPath).toBe(`frontmatter.${key}`);
			}
			expect(frontmatter.filter((doc) => doc.docKind === "value").map((doc) => doc.stringValue).sort())
				.toEqual(["v0", "v1", "v2", "v3", "v4", "v5", "v6"]);
			console.info(
				"Move scale large key fixture",
				JSON.stringify({
					textBytes: size,
					metadataDocs: before.length,
					frontmatterDocs: frontmatter.length,
					fieldPathBytes: new TextEncoder().encode(frontmatter[0]!.fieldPath).byteLength,
				}),
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
					destName: "draft-large-key.md",
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
				const afterDraft = await asUser.query(api.files_pending_updates.get_file_pending_update, {
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
						ownerTreePath: "/draft-large-key.md",
					});
					if (!place) throw new Error("Expected the owner place after Move");
					// This one native fixture has 106 metadata docs, below a transaction's read bytes.
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
					expect(
						fields.filter((doc) => doc.fieldPath === `frontmatter.${key}`),
						"the owner keeps all large-key field and value joins"
					).toHaveLength(8);
				});
			}
			const after = await read_metadata(fixture, item.nodeId);
			expect(after, "all native metadata docs survive the large-key Move").toHaveLength(before.length);
			expect(
				after.map((doc) => JSON.stringify(metadata_payload(doc))).sort(),
				"every upload metadata payload survives the large-key Move",
			).toEqual(before.map((doc) => JSON.stringify(metadata_payload(doc))).sort());
			for (const doc of after) {
				expect(doc.path).toBe("/target/large-key.md");
				expect(doc.treePath).toBe("/target/large-key.md");
				expect(doc.moveView).toBeUndefined();
			}
			const movedFrontmatter = after.filter((doc) => doc.fieldPath === `frontmatter.${key}`);
			expect(movedFrontmatter, "all eight native large-key frontmatter docs survive Move").toHaveLength(8);
			for (const doc of movedFrontmatter) expect(doc.fieldPath).toBe(`frontmatter.${key}`);
			expect(movedFrontmatter.filter((doc) => doc.docKind === "value").map((doc) => doc.stringValue).sort())
				.toEqual(["v0", "v1", "v2", "v3", "v4", "v5", "v6"]);
			console.info("Move scale large key", JSON.stringify(Object.fromEntries(peaks)));
		},
		7_200_000
	);
});
