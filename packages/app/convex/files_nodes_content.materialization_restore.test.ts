import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyUpdate, Doc as YjsDoc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { api, internal } from "./_generated/api.js";
import { files_u8_to_array_buffer, files_YJS_DOC_KEYS } from "../shared/files.ts";
import { mock_nodes_content_storage, objects, expect_retired_uploads } from "./files_nodes_content.setup.test.ts";
import {
	test_convex,
	test_create_saved_text_file,
	test_get_file_yjs_pointers,
	test_mocks_fill_db_with,
} from "./setup.test.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("a paused materializer cannot replace a same-shape version Restore", async () => {
	const t = test_convex({ transactionLimits: true });
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asUser = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: db.userId };
	const nodeId = await test_create_saved_text_file(t, {
		membershipId: db.membershipId,
		path: "/restored.txt",
		textContent: "Original\n",
	});
	const pointers = await test_get_file_yjs_pointers(t, nodeId);
	const original = await t.run(async (ctx) => {
		const snapshot = (await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId))!;
		return {
			node: (await ctx.db.get("files_nodes", nodeId))!,
			yjsAsset: (await ctx.db.get("files_r2_assets", snapshot.assetId))!,
			version: (await ctx.db.query("files_snapshots").first())!,
		};
	});
	const editor = new YjsDoc();
	applyUpdate(editor, new Uint8Array(await new Response(objects.get(original.yjsAsset.r2Key!)).arrayBuffer()));
	const vector = encodeStateVector(editor);
	const text = editor.getText(files_YJS_DOC_KEYS.plainText);
	text.insert(text.length, "Edit before Restore\n");
	const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
		membershipId: db.membershipId,
		nodeId,
		expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
		update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, vector)),
		sessionId: "before-restore",
	});
	if (pushed._nay) throw new Error(pushed._nay.message);
	const entered = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	const capturedFetch = fetch;
	let paused = false;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			if (!paused && init?.method === "PUT" && init.body === "Original\nEdit before Restore\n") {
				paused = true;
				entered.resolve();
				await resume.promise;
			}
			return await capturedFetch(input, init);
		}),
	);
	const materializing = t.action(internal.files_nodes_content.materialize_file_content, {
		...scope,
		nodeId,
		targetSequence: pushed._yay.newSequence,
	});
	await Promise.race([
		entered.promise,
		materializing.then((result) => {
			throw new Error(`The materializer ended before its source upload: ${JSON.stringify(result)}`);
		}),
	]);
	try {
		expect(
			await asUser.action(api.files_nodes_content.restore_snapshot_r2, {
				membershipId: db.membershipId,
				nodeId,
				snapshotId: original.version._id,
				sessionId: "same-shape-restore",
			}),
		).toHaveProperty("_yay");
		const restored = await t.run(async (ctx) => ({
			node: (await ctx.db.get("files_nodes", nodeId))!,
			snapshot: (await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId))!,
			sequence: (await ctx.db.get("files_yjs_docs_last_sequences", pointers.yjsLastSequenceId))!,
			heads: await ctx.db
				.query("files_saved_content_heads")
				.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
				.collect(),
		}));
		expect(restored.node.assetId, "Restore changes the exact saved source").not.toBe(original.node.assetId);
		expect(restored.node.yjsLastSequenceId, "Restore keeps the same editor lineage").toBe(pointers.yjsLastSequenceId);
		expect(restored.snapshot.assetId, "Restore keeps the snapshot asset captured by the paused worker").toBe(
			original.yjsAsset._id,
		);
		expect(
			restored.sequence.lastSequence,
			"the paused worker still passes the later-update sequence fence",
		).toBeGreaterThan(pushed._yay.newSequence);
		resume.resolve();
		expect(await materializing).toHaveProperty("_yay");
		const current = (await t.run((ctx) => ctx.db.get("files_nodes", nodeId)))!;
		expect(current.assetId, "the paused materializer keeps the restored source asset").toBe(restored.node.assetId);
		expect(current.contentHeadId, "the paused materializer keeps the restored exact-text owner").toBe(
			restored.node.contentHeadId,
		);
		const asset = (await t.run((ctx) => ctx.db.get("files_r2_assets", current.assetId!)))!;
		expect(objects.get(asset.r2Key!), "downloads keep the restored bytes").toBe("Original\n");
		const read = await t.action(internal.files_nodes_content.get_file_last_available_text_content_by_path, {
			...scope,
			subject: { kind: "user", userId: db.userId, plugin: null },
			path: "/restored.txt",
			includePending: false,
		});
		expect(read?.content, "opening the file keeps the restored text").toBe("Original\n");
		const knownHeads = new Set(restored.heads.map((head) => head._id));
		const prepared = await t.run(async (ctx) =>
			(
				await ctx.db
					.query("files_saved_content_heads")
					.withIndex("by_fileNode", (q) => q.eq("fileNodeId", nodeId))
					.collect()
			).filter((head) => !knownHeads.has(head._id)),
		);
		expect(prepared, "the stale worker prepared one unused exact source").toHaveLength(1);
		await expect_retired_uploads(t, 2);
		expect(
			await t.run((ctx) => ctx.db.get("files_saved_content_heads", prepared[0]!._id)),
			"the stale prepared source retires",
		).toBeNull();
	} finally {
		resume.resolve();
		await materializing;
		editor.destroy();
	}
});
