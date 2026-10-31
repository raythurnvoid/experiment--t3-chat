import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { add_member } from "./files_archive_runs.setup.test.ts";
import { insert_tree_node } from "./files_nodes.setup.test.ts";
import { mock_nodes_content_storage } from "./files_nodes_content.setup.test.ts";
import { files_purge_db_delete_asset, files_purge_db_drain_node_batch } from "./files_purge_db.ts";
import { quotas_db_ensure } from "./quotas.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_mocks_fill_db_with,
	test_run_with_flush,
} from "./setup.test.ts";
import { files_archive_operation_id_new } from "../shared/files.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function fixture() {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId };
	// The drain only stamps the run id on the node, so any run doc works here.
	const runId = await t.run((ctx) =>
		ctx.db.insert("files_archive_runs", {
			...scope,
			userId: db.userId,
			force: false,
			kind: "archive",
			archiveOperationId: files_archive_operation_id_new(Date.now()),
			rootNodeIds: [],
			phase: "apply",
			checkCursor: { rootIndex: 0, treePath: "" },
			discoverTreePaths: [],
			applyRootIndex: 0,
			active: false,
			skipOperationId: null,
			conflict: null,
			choice: null,
			applyToRemaining: { file: null, folder: null },
			revision: 0,
			requestFirstRunId: null,
			checkNamedItem: null,
			refusedItems: [],
		}),
	);
	const drain = (nodeId: Id<"files_nodes">) =>
		test_run_with_flush(t, async (ctx) => {
			const node = (await ctx.db.get("files_nodes", nodeId))!;
			return (await files_purge_db_drain_node_batch(ctx, { ...scope, node, runId })).kind;
		});
	// Call the drain until it stops, like the purge run does.
	const drain_until_done = async (nodeId: Id<"files_nodes">) => {
		const kinds = [];
		for (let call = 0; call < 200; call++) {
			const kind = await drain(nodeId);
			kinds.push(kind);
			if (kind !== "more") return kinds;
		}
		throw new Error("The drain did not finish");
	};
	return { t, db, asOwner, scope, runId, drain, drain_until_done };
}

describe("files_purge_db_drain_node_batch", () => {
	test("deletes the file, its history, and other people's drafts in the folder, over several calls", async () => {
		const f = await fixture();
		const fileId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/gone/notes.md",
			textContent: "# Notes\n\nSome text",
		});
		const keptId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/kept.md",
			textContent: "Kept",
		});
		const other = await add_member({ t: f.t, db: f.db, asOwner: f.asOwner });
		const { folderId, file, logOwnerHeadId } = await test_run_with_flush(f.t, async (ctx) => {
			const file = (await ctx.db.get("files_nodes", fileId))!;
			// An exact-text save makes a new head that keeps the old head as the owner of the live Yjs
			// log (`files_nodes_content.ts`).
			const {
				_id: logOwnerHeadId,
				_creationTime,
				...head
			} = (await ctx.db.get("files_saved_content_heads", file.contentHeadId!))!;
			const headId = await ctx.db.insert("files_saved_content_heads", head);
			await ctx.db.patch("files_nodes", fileId, { contentHeadId: headId });
			// More Yjs updates than one call deletes, so the file needs several calls.
			for (let sequence = 1; sequence <= 20; sequence++) {
				await ctx.db.insert("files_yjs_updates", {
					...f.scope,
					fileNodeId: fileId,
					sequence,
					update: new ArrayBuffer(8),
					origin: { type: "USER_EDIT", sessionId: "purge-test" },
					createdBy: f.db.userId,
					createdAt: Date.now(),
				});
			}
			return { folderId: file.parentId as Id<"files_nodes">, file, logOwnerHeadId };
		});
		// Another person drafted a folder with a file inside the folder that is being deleted.
		const draft = await f.t.mutation(internal.files_nodes.create_private_node_by_path, {
			...f.scope,
			userId: other.userId,
			path: "/gone/drafts/draft.md",
			kind: "file",
		});
		expect(draft._nay).toBeUndefined();

		const fileKinds = await f.drain_until_done(fileId);
		expect(fileKinds.at(-1)).toBe("deleted");
		expect(fileKinds.length).toBeGreaterThan(3);
		expect(await f.drain_until_done(folderId)).toContain("deleted");
		// Run the head discards the drain scheduled, by hand: the R2 delete jobs retry forever here,
		// because tests block the network.
		const discardJobs = (await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((job) =>
			job.name.endsWith("files_content_saves:discard"),
		);
		const discardedHeadIds = discardJobs.map(
			(job) => (job.args[0] as { headId: Id<"files_saved_content_heads"> }).headId,
		);
		expect(discardedHeadIds).toContain(logOwnerHeadId);
		for (const headId of discardedHeadIds) await f.t.mutation(internal.files_content_saves.discard, { headId });

		await f.t.run(async (ctx) => {
			expect(await ctx.db.get("files_nodes", fileId)).toBeNull();
			expect(await ctx.db.get("files_nodes", folderId)).toBeNull();
			const is_left = (doc: object) => "fileNodeId" in doc && doc.fileNodeId === fileId;
			const left = {
				yjsUpdates: (await ctx.db.query("files_yjs_updates").collect()).filter(is_left),
				yjsSnapshots: (await ctx.db.query("files_yjs_snapshots").collect()).filter(is_left),
				lastSequences: (await ctx.db.query("files_yjs_docs_last_sequences").collect()).filter(is_left),
				textChunks: (await ctx.db.query("files_text_chunks").collect()).filter(is_left),
				plainTextChunks: (await ctx.db.query("files_plain_text_chunks").collect()).filter(is_left),
				metadataDocs: (await ctx.db.query("files_metadata_docs").collect()).filter(is_left),
				stats: (await ctx.db.query("file_stats").collect()).filter(is_left),
				heads: (await ctx.db.query("files_saved_content_heads").collect()).filter((head) => head.fileNodeId === fileId),
			};
			expect(left).toEqual({
				yjsUpdates: [],
				yjsSnapshots: [],
				lastSequences: [],
				textChunks: [],
				plainTextChunks: [],
				metadataDocs: [],
				stats: [],
				heads: [],
			});

			// The other person's drafts are closed, and the file's R2 object is queued for delete.
			const drafts = (await ctx.db.query("files_pending_nodes").collect()).filter(
				(node) => node.userId === other.userId,
			);
			expect(drafts.map((node) => node.state)).toEqual(["discarded", "discarded"]);
			expect(file.assetId && (await ctx.db.get("files_r2_assets", file.assetId))).toBeNull();
			const jobs = await ctx.db.query("files_r2_object_deletion_jobs").collect();
			expect(jobs.filter((job) => job.reason === "permanent_delete").length).toBeGreaterThan(0);

			// A file outside the folder keeps everything.
			const kept = (await ctx.db.get("files_nodes", keptId))!;
			expect(kept.contentHeadId && (await ctx.db.get("files_saved_content_heads", kept.contentHeadId))).toBeTruthy();
			expect(kept.assetId && (await ctx.db.get("files_r2_assets", kept.assetId))).toBeTruthy();
		});
	});

	test("refuses a Yjs edit once the purge has started", async () => {
		const f = await fixture();
		const fileId = await test_create_saved_text_file(f.t, {
			membershipId: f.db.membershipId,
			path: "/half.md",
			textContent: "Half",
		});

		expect(await f.drain(fileId)).toBe("more");
		const lastSequenceId = await f.t.run(async (ctx) => (await ctx.db.get("files_nodes", fileId))!.yjsLastSequenceId!);
		const pushed = await f.asOwner.mutation(api.files_nodes.yjs_push_update, {
			membershipId: f.db.membershipId,
			nodeId: fileId,
			update: new ArrayBuffer(8),
			sessionId: "late-editor",
			expectedYjsLastSequenceId: lastSequenceId,
		});
		expect(pushed._nay).toEqual({ name: "deleting", message: "This item is being deleted." });
	});
});

describe("files_purge_db_delete_asset", () => {
	test("gives back the stored bytes once, and nothing for an asset without a byte count", async () => {
		const f = await fixture();
		const owner = { ...f.scope, userId: f.db.userId };
		const { quotaId, nodeIds, assetIds } = await test_run_with_flush(f.t, async (ctx) => {
			const insert_asset = (storedFileBytes: number | undefined) =>
				ctx.db.insert("files_r2_assets", {
					...f.scope,
					kind: "upload",
					r2Bucket: "test",
					size: 100,
					createdBy: f.db.userId,
					updatedAt: Date.now(),
					storedFileBytes,
				});
			const assetIds = [await insert_asset(100), await insert_asset(undefined)];
			const nodeIds = [];
			for (const [index, assetId] of assetIds.entries()) {
				const nodeId = await insert_tree_node({
					ctx,
					owner,
					parentId: "root",
					path: `/upload-${index}.bin`,
					kind: "file",
				});
				await ctx.db.patch("files_nodes", nodeId, { assetId });
				nodeIds.push(nodeId);
			}
			const quotaId = await quotas_db_ensure(ctx, { ...f.scope, quotaName: "stored_file_bytes", now: Date.now() });
			await ctx.db.patch("quotas", quotaId, { usedCount: 150 });
			return { quotaId, nodeIds, assetIds };
		});

		for (const nodeId of nodeIds) expect((await f.drain_until_done(nodeId)).at(-1)).toBe("deleted");
		// A second delete of the same asset must not give the bytes back again.
		await test_run_with_flush(f.t, (ctx) => files_purge_db_delete_asset(ctx, { ...f.scope, assetId: assetIds[0]! }));

		await f.t.run(async (ctx) => {
			expect((await ctx.db.get("quotas", quotaId))?.usedCount).toBe(50);
			const assets: (Doc<"files_r2_assets"> | null)[] = await Promise.all(
				assetIds.map((assetId) => ctx.db.get("files_r2_assets", assetId)),
			);
			expect(assets).toEqual([null, null]);
		});
	});
});
