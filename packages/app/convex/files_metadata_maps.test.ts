import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
	test_run_with_flush,
	test_save_file_pending_update,
} from "./setup.test.ts";
import {
	create_file_fixture,
	create_private_text_fixture,
	mock_nodes_content_storage,
} from "./files_nodes_content.setup.test.ts";
import {
	files_nodes_content_db_discard_transfer_file_attempt,
	files_nodes_content_db_discard_transfer_file_capture,
} from "./files_transfer_assets_db.ts";
import {
	files_metadata_maps_db_read,
	files_metadata_maps_db_write,
} from "../server/files-metadata-maps.ts";
import { test_create_saved_placement_fixture } from "../server/files-saved-placement.test-fixtures.ts";
import { files_metadata_stringify_entries_yaml, files_metadata_validate_entries } from "../shared/files-metadata.ts";

beforeEach(mock_nodes_content_storage);
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("full metadata maps", () => {
	test("trusted writes reject long values and large maps without changing the old map", async () => {
		const { t, db, nodeId } = await create_file_fixture();
		const owner = { kind: "saved" as const, id: nodeId };
		const entries = [{ key: "description", value: "kept" }];
		await t.run((ctx) => files_metadata_maps_db_write(ctx.db, { ...db, owner, entries }));
		for (const invalid of [
			[{ key: "description", value: "x".repeat(32 * 1024 + 1) }],
			Array.from({ length: 5 }, (_, i) => ({ key: `key${i}`, value: "x".repeat(32 * 1024) })),
		]) {
			await expect(t.run((ctx) => files_metadata_maps_db_write(ctx.db, { ...db, owner, entries: invalid })),
				"Every full-map write refuses an over-limit map").rejects.toThrow(/Metadata/);
			expect((await t.run((ctx) => files_metadata_maps_db_read(ctx.db, owner)))?.entries).toEqual(entries);
		}
	});

	test("Properties saves full values and the table reads only a preview", async () => {
		const { t, db, asUser, nodeId } = await create_file_fixture();
		const entries = [{ key: "description", value: "x".repeat(32 * 1024) }, { key: "checked", value: false }];
		expect(await asUser.mutation(api.files_metadata.set_entries, {
			membershipId: db.membershipId,
			fileNodeId: nodeId,
			metadataYaml: files_metadata_stringify_entries_yaml(entries),
		})).toEqual({ _yay: null });
		expect(await asUser.query(api.files_metadata.get_entries, {
			membershipId: db.membershipId, fileNodeId: nodeId,
		}), "Properties reads the full ordered map").toEqual(entries);
		const stored = await t.run((ctx) => files_metadata_maps_db_read(ctx.db, { kind: "saved", id: nodeId }));
		expect(stored).toMatchObject({ entries, revision: 1 });
		expect(await asUser.query(api.files_metadata.get_field_values, {
			membershipId: db.membershipId,
			target: { kind: "saved", id: nodeId },
			fields: ["metadata.checked", "metadata.description"], afterField: null,
		})).toMatchObject({ values: [
			{ field: "metadata.checked", value: false, isPreview: false },
			{ field: "metadata.description", value: "x".repeat(256), isPreview: true },
		] });
		expect(await asUser.mutation(api.files_metadata.set_entries, {
			membershipId: db.membershipId, fileNodeId: nodeId, metadataYaml: "description: revised",
		})).toEqual({ _yay: null });
		expect(await t.run((ctx) => files_metadata_maps_db_read(ctx.db, { kind: "saved", id: nodeId }))).toMatchObject({
			_id: stored!._id, revision: 2, entries: [{ key: "description", value: "revised" }],
		});
	});

	test("private Save moves full metadata into the new saved owner", async () => {
		const { t, db, asUser, proposal, target } = await create_private_text_fixture(false);
		const entries = Array.from({ length: 4 }, (_, i) => ({ key: `key${i}`, value: "x".repeat(32 * 1024 - 16) }));
		expect(files_metadata_validate_entries(entries)._yay).toBeDefined();
		expect(new TextEncoder().encode(files_metadata_stringify_entries_yaml(entries)).length).toBeGreaterThan(127 * 1024);
		expect(await t.mutation(internal.files_metadata.update_entries_by_path, {
			organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId,
			path: "/private.txt", set: entries, remove: [],
		})).toMatchObject({ _yay: { entries } });
		const current = await t.run((ctx) => ctx.db.get("files_pending_updates", proposal._id));
		expect(current!.createIntent).not.toHaveProperty("metadata");
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: db.membershipId, target, pendingUpdateId: proposal._id, reviewedRevision: current!.revision,
		});
		if (saved._nay || saved._yay.target.kind !== "saved") throw new Error("Expected saved private metadata");
		expect(await asUser.query(api.files_metadata.get_entries, {
			membershipId: db.membershipId, fileNodeId: saved._yay.target.id,
		}), "Private Save preserves the full map").toEqual(entries);
		expect(await t.run((ctx) => files_metadata_maps_db_read(ctx.db, { kind: "pending", id: proposal._id }))).toBeNull();
	});

	test("private folder Save builds the saved table preview", async () => {
		const { t, db, asUser, scope } = await create_file_fixture();
		const created = await t.mutation(internal.files_nodes.create_private_node_by_path, {
			...scope, path: "/private-folder", kind: "folder",
		});
		if (created._nay || !created._yay.pendingUpdateId) throw new Error("Expected private folder");
		expect(await t.mutation(internal.files_metadata.update_entries_by_path, {
			...scope, path: "/private-folder", set: [{ key: "description", value: "folder " + "x".repeat(4000) }], remove: [],
		})).toHaveProperty("_yay");
		const proposal = await t.run((ctx) => ctx.db.get("files_pending_updates", created._yay.pendingUpdateId!));
		const saved = await test_save_file_pending_update(asUser, {
			membershipId: db.membershipId, target: created._yay.target,
			pendingUpdateId: proposal!._id, reviewedRevision: proposal!.revision,
		});
		expect(saved._nay, "Private folder Save needs no content head").toBeUndefined();
		if (saved._nay) throw new Error(saved._nay.message);
		expect(await asUser.query(api.files_metadata.get_field_values, {
			membershipId: db.membershipId, target: saved._yay.target,
			fields: ["metadata.description"], afterField: null,
		}), "Private folder Save publishes a complete saved table field").toMatchObject({ values: [
			{ field: "metadata.description", value: "folder " + "x".repeat(249), isPreview: true },
		] });
	});

	test.each(["completed", "canceled"] as const)(
		"50 %s capture maps clean up under both wrappers with an active Move slot",
		async (state) => {
			vi.useFakeTimers();
			const f = await test_create_saved_placement_fixture({ transactionLimits: true });
			const entries = Array.from({ length: 4 }, (_, i) => ({ key: `k${i}`, value: "x".repeat(32 * 1024 - 16) }));
			expect(files_metadata_validate_entries(entries)._yay).toBeDefined();
			expect(new TextEncoder().encode(files_metadata_stringify_entries_yaml(entries)).length).toBeGreaterThan(127 * 1024);
			const template = await f.t.run((ctx) => ctx.db.get("files_transfer_items", f.itemId));
			if (!template || !f.saved.assetId) throw new Error("Expected native Move fixture");
			const { _id, _creationTime, ...fields } = template;
			const itemIds = [];
			for (let order = 0; order < 50; order++) {
				itemIds.push(await f.t.run(async (ctx) => {
					const itemId = await ctx.db.insert("files_transfer_items", {
						...fields, order: order + 100, state, workId: null, attempt: 1, stagedAssetIds: [],
						cancelReason: state === "canceled" ? "stop" : null,
						attemptExpiresAt: null, preparation: null,
						capture: {
							sourceVersion: { kind: "asset", assetId: f.saved.assetId!, contentType: "text/plain", textKind: "plain_text", collaborationEnabled: false },
							sourceAssetId: f.saved.assetId!, sourceStateId: null, sourceYjsSnapshot: null, artifact: null,
						},
					});
					await files_metadata_maps_db_write(ctx.db, { ...f.db, owner: { kind: "capture", id: itemId }, entries });
					return itemId;
				}));
			}
			// Use the real cleanup helpers and order. Only the 50-item fixture is synthetic.
			const cleanup = test_run_with_flush(f.t, async (ctx) => {
				const items = await ctx.db.query("files_transfer_items")
					.withIndex("by_run_order", (q) => q.eq("runId", template.runId).gt("order", 99)).take(50);
				expect(items).toHaveLength(50);
				for (const { _id: itemId } of items) {
					await files_nodes_content_db_discard_transfer_file_attempt(ctx, { itemId, attempt: 1 });
					await files_nodes_content_db_discard_transfer_file_capture(ctx, { itemId });
					await ctx.db.delete("files_transfer_items", itemId);
				}
				return await ctx.meta.getTransactionMetrics();
			});
			await expect(cleanup, "50 full maps clean up under the enforced transaction limit").resolves.toHaveProperty("bytesRead");
			const metrics = await cleanup;
			console.info("Metadata capture cleanup bytes", { state, bytesRead: metrics.bytesRead.used, bytesWritten: metrics.bytesWritten.used });
			expect(metrics.bytesRead.used, "50 full maps stay below the real read limit without a third body read").toBeLessThan(16 * 1024 * 1024);
			for (const itemId of itemIds) {
				expect(await f.t.run((ctx) => ctx.db.get("files_transfer_items", itemId))).toBeNull();
				expect(await f.t.run((ctx) => files_metadata_maps_db_read(ctx.db, { kind: "capture", id: itemId }))).toBeNull();
			}
		},
	);
});
