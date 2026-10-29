import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { applyUpdate, Doc as YjsDoc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { api, internal } from "./_generated/api.js";
import { files_u8_to_array_buffer, files_YJS_DOC_KEYS } from "../shared/files.ts";
import { test_run_with_flush } from "./setup.test.ts";
import { create_file_fixture, mock_nodes_content_storage, objects } from "./files_nodes_content.setup.test.ts";

beforeEach(mock_nodes_content_storage);

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("get_saved_file_read_source", () => {
	test("keeps the available saved revision until newer editor bytes are published", async () => {
		const { t, db, asUser, scope, nodeId, pointers } = await create_file_fixture();
		const args = {
			...scope,
			subject: { kind: "user" as const, userId: db.userId, plugin: null },
			path: "/restore.txt",
		};
		const before = await t.query(internal.files_nodes_content.get_saved_file_read_source, args);
		expect(before).toMatchObject({ kind: "text", size: 14, target: { kind: "saved", id: nodeId } });
		const yjsKey = await t.run(async (ctx) => {
			const snapshot = (await ctx.db.get("files_yjs_snapshots", pointers.yjsSnapshotId))!;
			return (await ctx.db.get("files_r2_assets", snapshot.assetId))!.r2Key!;
		});
		const editor = new YjsDoc();
		applyUpdate(editor, new Uint8Array(await new Response(objects.get(yjsKey)).arrayBuffer()));
		const state = encodeStateVector(editor);
		const text = editor.getText(files_YJS_DOC_KEYS.plainText);
		text.insert(text.length, "New edit\n");
		const pushed = await asUser.mutation(api.files_nodes.yjs_push_update, {
			membershipId: db.membershipId,
			nodeId,
			expectedYjsLastSequenceId: pointers.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, state)),
			sessionId: "saved-read-editor",
		});
		editor.destroy();
		if (pushed._nay) throw new Error(pushed._nay.message);
		expect(
			await t.query(internal.files_nodes_content.get_saved_file_read_source, args),
			"new editor updates keep the saved read source",
		).toEqual(before);
		expect(
			await t.action(internal.files_nodes_content.materialize_file_content, {
				...scope,
				nodeId,
				targetSequence: pushed._yay.newSequence,
			}),
		).toHaveProperty("_yay");
		const after = await t.query(internal.files_nodes_content.get_saved_file_read_source, args);
		expect(after?.revision).not.toBe(before?.revision);
		expect(after?.size).toBe(23);
		expect(await new Response(objects.get(after!.r2Key)).text()).toBe("Original text\nNew edit\n");
	});

	test("reads the selected content head and keeps the revision when the same asset is reused", async () => {
		const { t, db, scope, nodeId } = await create_file_fixture();
		const args = {
			...scope,
			subject: { kind: "user" as const, userId: db.userId, plugin: null },
			path: "/restore.txt",
		};
		const before = await t.query(internal.files_nodes_content.get_saved_file_read_source, args);
		const headId = await test_run_with_flush(t, async (ctx) => {
			const node = (await ctx.db.get("files_nodes", nodeId))!;
			const {
				_id: _id,
				_creationTime: _time,
				...head
			} = (await ctx.db.get("files_saved_content_heads", node.contentHeadId!))!;
			const id = await ctx.db.insert("files_saved_content_heads", head);
			await ctx.db.patch("files_nodes", nodeId, { contentHeadId: id });
			return id;
		});
		expect(await t.query(internal.files_nodes_content.get_saved_file_read_source, args)).toEqual(before);
		const assetId = await test_run_with_flush(t, async (ctx) => {
			const { _id: _id, _creationTime: _time, ...asset } = (await ctx.db.get("files_r2_assets", before!.assetId))!;
			const id = await ctx.db.insert("files_r2_assets", { ...asset, r2Key: "test/new-saved-source", size: 9 });
			await ctx.db.patch("files_saved_content_heads", headId, { assetId: id, contentByteSize: 9 });
			return id;
		});
		const after = await t.query(internal.files_nodes_content.get_saved_file_read_source, args);
		expect(after).toMatchObject({ assetId, r2Key: "test/new-saved-source", size: 9 });
		expect(after?.revision).not.toBe(before?.revision);
	});

	test("reads a published asset before Review clears its cleanup flag", async () => {
		const { t, db, scope } = await create_file_fixture();
		const args = {
			...scope,
			subject: { kind: "user" as const, userId: db.userId, plugin: null },
			path: "/restore.txt",
		};
		const before = await t.query(internal.files_nodes_content.get_saved_file_read_source, args);
		await t.run((ctx) =>
			ctx.db.patch("files_r2_assets", before!.assetId, { unfinalizedExpiresAt: Date.now() + 60_000 }),
		);
		expect(
			await t.query(internal.files_nodes_content.get_saved_file_read_source, args),
			"published bytes stay readable before cleanup",
		).toEqual(before);
	});

	test("returns an empty saved asset", async () => {
		const { t, db, scope } = await create_file_fixture("plain_text", "");
		expect(
			await t.query(internal.files_nodes_content.get_saved_file_read_source, {
				...scope,
				subject: { kind: "user", userId: db.userId, plugin: null },
				path: "/restore.txt",
			}),
		).toMatchObject({ kind: "text", size: 0 });
	});
});
