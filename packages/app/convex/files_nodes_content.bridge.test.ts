// Remove these old-payload checks after the rollout drain ends.
import { Workpool } from "@convex-dev/workpool";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { applyUpdate, Doc as YjsDoc, encodeStateAsUpdate, encodeStateVector } from "yjs";
import { api, internal } from "./_generated/api.js";
import { fixture } from "./files_pending_overlay.setup.test.ts";
import { mock_nodes_content_storage, objects } from "./files_nodes_content.setup.test.ts";
import { test_create_saved_text_file, test_get_file_yjs_pointers } from "./setup.test.ts";
import { r2_create_asset_key } from "./r2_assets.ts";
import { files_nodes_create_yjs_snapshot_update_from_text } from "./files_nodes_content.ts";
import { files_u8_to_array_buffer, files_YJS_DOC_KEYS } from "../shared/files.ts";

beforeEach(() => {
	vi.useFakeTimers();
	mock_nodes_content_storage();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function create_file() {
	const f = await fixture(true);
	const nodeId = await test_create_saved_text_file(f.t, {
		membershipId: f.db.membershipId,
		path: "/bridge.txt",
		textContent: "Original text\n",
	});
	const pointers = await test_get_file_yjs_pointers(f.t, nodeId);
	const snapshot = await f.t.run((ctx) => ctx.db.query("files_snapshots").first());
	if (!snapshot) throw new Error("Missing created version");
	return { ...f, nodeId, pointers, snapshotId: snapshot._id };
}

async function upload(
	f: Awaited<ReturnType<typeof create_file>>,
	kind: "content_snapshot" | "yjs_snapshot",
	body: string | ArrayBuffer,
) {
	const size = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
	const assetId = await f.t.mutation(internal.r2_assets.insert_asset, {
		organizationId: f.u.organizationId,
		workspaceId: f.u.workspaceId,
		kind,
		size,
		createdBy: f.u.userId,
	});
	const key = r2_create_asset_key({ ...f.u, assetId });
	objects.set(key, body);
	return { assetId, size };
}

async function read_source(f: Awaited<ReturnType<typeof create_file>>) {
	return await f.t.run(async (ctx) => {
		const node = (await ctx.db.get("files_nodes", f.nodeId))!;
		const chunks = await ctx.db.query("files_text_chunks")
			.withIndex("by_contentHead_yjsSeq_chunk", (q) => q.eq("contentHeadId", node.contentHeadId!)).collect();
		return { node, text: chunks.map((chunk) => chunk.textChunk).join("") };
	});
}

test("old Save calls still publish their uploaded source and history", async () => {
	const f = await create_file();
	expect(await f.asU.mutation(api.files_nodes_content.set_file_non_collaborative, {
		membershipId: f.db.membershipId, nodeId: f.nodeId, acknowledgeDropCollaborativeHistory: true,
	})).toHaveProperty("_yay");
	expect(await f.asU.action(api.files_nodes_content.replace_file_content, {
		membershipId: f.db.membershipId, nodeId: f.nodeId, text: "Old editor Save\n",
	})).toHaveProperty("_yay");
	const text = "Already uploaded Save\n";
	const asset = await upload(f, "content_snapshot", text);
	expect(await f.t.mutation(internal.files_nodes_content.finalize_file_content_replacement, {
		...f.u, nodeId: f.nodeId, text, textSize: asset.size, versionSnapshotAssetId: asset.assetId,
	})).toHaveProperty("_yay");
	expect((await read_source(f)).text, "an accepted old Save keeps its source commit").toBe(text);
	expect(await f.t.run((ctx) => ctx.db.query("files_snapshots")
		.withIndex("by_asset", (q) => q.eq("assetId", asset.assetId)).first())).not.toBeNull();
});

test.each(["restore", "repair", "enable"] as const)("an old %s call commits without a prepared source head", async (door) => {
	const f = await create_file();
	if (door === "enable") {
		expect(await f.asU.mutation(api.files_nodes_content.set_file_non_collaborative, {
			membershipId: f.db.membershipId, nodeId: f.nodeId, acknowledgeDropCollaborativeHistory: true,
		})).toHaveProperty("_yay");
		const task = await f.t.run((ctx) => ctx.db.query("files_yjs_cleanup_tasks").first());
		if (task) await f.t.mutation(internal.files_nodes_content.cleanup_file_yjs_task, { taskId: task._id });
	}
	const before = await read_source(f);
	const text = "Original text\n";
	const content = await upload(f, "content_snapshot", text);
	const yjs = files_nodes_create_yjs_snapshot_update_from_text({ rootKind: "plain_text", text });
	if (yjs._nay) throw new Error(yjs._nay.message);
	const snapshot = await upload(f, "yjs_snapshot", yjs._yay);
	if (door === "restore") {
		const current = await upload(f, "content_snapshot", text);
		expect(await f.asU.mutation(internal.files_nodes_content.restore_snapshot, {
			membershipId: f.db.membershipId, nodeId: f.nodeId, snapshotId: f.snapshotId,
			sessionId: "old-restore", snapshotMarkdownContent: text,
			expectedYjsLastSequenceId: f.pointers.yjsLastSequenceId, expectedLastSequence: 0,
			expectedPendingContentVersion: before.node.pendingContentVersion,
			currentSnapshotAssetId: current.assetId, currentSnapshotSize: current.size,
			restoredSnapshotAssetId: content.assetId, restoredSnapshotSize: content.size,
		})).toHaveProperty("_yay");
	} else if (door === "repair") {
		const previousSnapshot = await f.t.run((ctx) => ctx.db.get("files_yjs_snapshots", f.pointers.yjsSnapshotId));
		expect(await f.t.mutation(internal.files_nodes_content.finalize_file_yjs_repair, {
			organizationId: f.u.organizationId, workspaceId: f.u.workspaceId, authorUserId: f.u.userId,
			nodeId: f.nodeId, source: "last_committed", acknowledgeDiscardUnmaterialized: true,
			targetSequence: 0, expectedYjsLastSequenceId: f.pointers.yjsLastSequenceId,
			expectedPendingContentVersion: before.node.pendingContentVersion,
			text, textByteSize: content.size, contentSnapshotAssetId: content.assetId,
			yjsSnapshotAssetId: snapshot.assetId, yjsSnapshotSize: snapshot.size,
			supersededYjsAssetId: previousSnapshot!.assetId,
		})).toHaveProperty("_yay");
	} else {
		expect(await f.asU.mutation(internal.files_nodes_content.finalize_file_collaboration_enable, {
			membershipId: f.db.membershipId, nodeId: f.nodeId, text, textSize: content.size,
			baseAssetId: before.node.assetId!, contentSnapshotAssetId: content.assetId,
			yjsSnapshotAssetId: snapshot.assetId, yjsSnapshotSize: snapshot.size,
		})).toHaveProperty("_yay");
	}
	const after = await read_source(f);
	expect(after.text).toBe(text);
	expect(after.node.assetId).toBe(content.assetId);
	expect(after.node.contentHeadId).not.toBe(before.node.contentHeadId);
});

test.each([false, true])("old materialization queues fresh work without replacing a later job: %s", async (newer) => {
	// Only restore the spies; these methods are not called without their receiver.
	// oxlint-disable-next-line typescript/unbound-method
	vi.mocked(Workpool.prototype.enqueueAction).mockRestore();
	// oxlint-disable-next-line typescript/unbound-method
	vi.mocked(Workpool.prototype.cancel).mockRestore();
	const f = await create_file();
	const stored = await f.t.run(async (ctx) => {
		const snapshot = (await ctx.db.get("files_yjs_snapshots", f.pointers.yjsSnapshotId))!;
		return (await ctx.db.get("files_r2_assets", snapshot.assetId))!;
	});
	const editor = new YjsDoc();
	applyUpdate(editor, new Uint8Array(await new Response(objects.get(stored.r2Key!)!).arrayBuffer()));
	const push = async (addition: string) => {
		const vector = encodeStateVector(editor);
		const text = editor.getText(files_YJS_DOC_KEYS.plainText);
		text.insert(text.length, addition);
		expect(await f.asU.mutation(api.files_nodes.yjs_push_update, {
			membershipId: f.db.membershipId, nodeId: f.nodeId,
			expectedYjsLastSequenceId: f.pointers.yjsLastSequenceId,
			update: files_u8_to_array_buffer(encodeStateAsUpdate(editor, vector)), sessionId: "old-materializer",
		})).toHaveProperty("_yay");
	};
	await push("First edit\n");
	if (newer) await push("Later edit\n");
	const before = await read_source(f);
	const job = await f.t.run((ctx) => ctx.db.query("files_content_materialization_jobs").first());
	if (!job) throw new Error("Missing accepted materializer");
	const content = await upload(f, "content_snapshot", "Stale materialized text\n");
	const snapshot = await upload(f, "yjs_snapshot", new Uint8Array([0, 0]).buffer);
	const cancel = vi.spyOn(Workpool.prototype, "cancel");
	const args = {
		...f.u, nodeId: f.nodeId, expectedYjsLastSequenceId: f.pointers.yjsLastSequenceId,
		expectedYjsSnapshotAssetId: stored._id, sequence: 1, targetSequence: 1, text: "Stale materialized text\n",
		versionSnapshotAssetId: content.assetId, yjsSnapshotAssetId: snapshot.assetId,
		textSize: content.size, yjsSnapshotSize: snapshot.size,
	};
	expect(await f.t.mutation(internal.files_nodes_content.finalize_file_content_materialization, args)).toHaveProperty("_yay");
	expect(await read_source(f), "an old materializer cannot publish its old bytes").toEqual(before);
	expect(cancel, "rollout does not cancel accepted work").not.toHaveBeenCalled();
	const after = await f.t.run((ctx) => ctx.db.query("files_content_materialization_jobs").first());
	if (newer) expect(after, "a later edit keeps its accepted job").toEqual(job);
	else {
		expect(after?._id).toBe(job._id);
		expect(after?.jobId, "old work gets a fresh attempt with current captures").not.toBe(job.jobId);
	}
	expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", content.assetId))).toBeNull();
	expect(await f.t.run((ctx) => ctx.db.get("files_r2_assets", snapshot.assetId))).toBeNull();
	editor.destroy();
});

test("the old field-cap door retries without bringing back its marker", async () => {
	const f = await create_file();
	await f.t.mutation(internal.files_nodes_content.mark_file_content_frontmatter_too_large, {
		...f.u, nodeId: f.nodeId, expectedYjsLastSequenceId: f.pointers.yjsLastSequenceId, targetSequence: 0,
		sequence: 0, fieldCount: 129, indexDocumentCount: 129,
	});
	expect((await read_source(f)).node).toMatchObject({
		contentFrontmatterTooLargeFieldCount: null,
		contentFrontmatterTooLargeIndexDocumentCount: null,
	});
	expect(await f.t.run((ctx) => ctx.db.query("files_content_materialization_jobs").first())).not.toBeNull();
});

test("mixed and incomplete materialization captures fail before changing the file", async () => {
	const f = await create_file();
	const before = await read_source(f);
	const stored = await f.t.run((ctx) => ctx.db.get("files_yjs_snapshots", f.pointers.yjsSnapshotId));
	const args = {
		...f.u, nodeId: f.nodeId, expectedYjsLastSequenceId: f.pointers.yjsLastSequenceId,
		expectedYjsSnapshotAssetId: stored!.assetId, sequence: 0, targetSequence: 0,
		versionSnapshotAssetId: before.node.assetId!, yjsSnapshotAssetId: stored!.assetId,
		textSize: 14, yjsSnapshotSize: 0, expectedContentAssetId: before.node.assetId!,
	};
	await expect(f.t.mutation(internal.files_nodes_content.finalize_file_content_materialization, {
		...args, text: "mixed",
	})).rejects.toThrow("Mixed materialization inputs");
	await expect(f.t.mutation(internal.files_nodes_content.finalize_file_content_materialization, args))
		.rejects.toThrow("Incomplete materialization inputs");
	expect(await read_source(f)).toEqual(before);
	expect(await f.t.run((ctx) => ctx.db.query("files_content_materialization_jobs").first())).toBeNull();
});
