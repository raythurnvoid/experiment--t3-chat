import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_create_yjs_snapshot_update_from_text } from "./files_nodes_content.ts";
import { r2_create_asset_key } from "./r2_client.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { files_INITIAL_CONTENT, files_ROOT_ID, files_get_utf8_byte_size } from "../shared/files.ts";

async function fixture() {
	const t = test_convex();
	const db = await t.run((ctx) => test_mocks_fill_db_with.membership(ctx));
	const asOwner = t.withIdentity({ issuer: "https://clerk.test", external_id: db.userId });
	const member = await t.run(async (ctx) => {
		const userId = await ctx.db.insert("users", { clerkUserId: "finalize_member" });
		const membershipId = await ctx.db.insert("organizations_workspaces_users", {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			userId,
			active: true,
			pendingOrganizationRemoval: false,
			updatedAt: Date.now(),
		});
		await access_control_db_ensure_role_assignment(ctx, { ...db, userId, role: "member", now: Date.now() });
		return { userId, membershipId };
	});
	const scope = { organizationId: db.organizationId, workspaceId: db.workspaceId, userId: member.userId };
	const chunked = await files_chunk_markdown(files_INITIAL_CONTENT);
	if (chunked._nay) throw new Error(chunked._nay.message);
	if (chunked._yay.length !== 1) throw new Error("Expected one initial Markdown chunk");
	const chunk = chunked._yay[0]!;
	const snapshot = files_nodes_create_yjs_snapshot_update_from_text({
		text: files_INITIAL_CONTENT,
		rootKind: "rich_text",
	});
	if (snapshot._nay) throw new Error(snapshot._nay.message);
	const insertAssets = async () => ({
		yjsSnapshotAssetId: await t.mutation(internal.r2.insert_asset, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "yjs_snapshot",
			size: snapshot._yay.byteLength,
			createdBy: member.userId,
		}),
		versionSnapshotAssetId: await t.mutation(internal.r2.insert_asset, {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			kind: "content_snapshot",
			size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
			createdBy: member.userId,
		}),
	});
	const assets = await insertAssets();
	const finalize = (args: { parentId: Id<"files_nodes"> | "root"; path: string }) =>
		t.mutation(internal.files_nodes_content.create_file_node, {
			...scope,
			...args,
			assetId: assets.versionSnapshotAssetId,
			yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
			contentType: "text/markdown;charset=utf-8",
			textContent: files_INITIAL_CONTENT,
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.versionSnapshotAssetId],
		});
	const folder = async (path: string, parentId: Id<"files_nodes"> | "root" = files_ROOT_ID) => {
		const created = await asOwner.mutation(api.files_nodes.create_folder_node, {
			membershipId: db.membershipId,
			parentId,
			path,
		});
		if (created._nay) throw new Error(created._nay.message);
		return created._yay.nodeId;
	};
	const readFileDocs = () =>
		t.run(async (ctx) => ({
			nodes: await ctx.db.query("files_nodes").collect(),
			chunks: await ctx.db.query("files_text_chunks").collect(),
			plainChunks: await ctx.db.query("files_plain_text_chunks").collect(),
			stats: await ctx.db.query("file_stats").collect(),
			yjsSnapshots: await ctx.db.query("files_yjs_snapshots").collect(),
			sequences: await ctx.db.query("files_yjs_docs_last_sequences").collect(),
			updates: await ctx.db.query("files_yjs_updates").collect(),
			snapshots: await ctx.db.query("files_snapshots").collect(),
			metadata: await ctx.db.query("files_metadata_docs").collect(),
			mediaVersions: await ctx.db.query("files_media_validation_versions").collect(),
			updatedBy: await ctx.db.query("files_updated_by_docs").collect(),
		}));
	return {
		t,
		db,
		asOwner,
		member,
		scope,
		chunk,
		assets,
		insertAssets,
		snapshotSize: snapshot._yay.byteLength,
		finalize,
		folder,
		readFileDocs,
	};
}

describe("create_file_node", () => {
	test("publishes the full initial file state", async () => {
		const { t, db, member, chunk, assets, snapshotSize, finalize, readFileDocs } = await fixture();
		const created = await finalize({ parentId: files_ROOT_ID, path: "note.md" });
		if (created._nay) throw new Error(created._nay.message);
		const state = await readFileDocs();
		expect(state.nodes).toHaveLength(1);
		const node = state.nodes[0]!;
		expect(node).toMatchObject({
			_id: created._yay.nodeId,
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			parentId: files_ROOT_ID,
			name: "note.md",
			kind: "file",
			path: "/note.md",
			treePath: "/note.md",
			pathDepth: 1,
			lowercaseExtension: "md",
			contentType: "text/markdown;charset=utf-8",
			contentByteSize: files_get_utf8_byte_size(files_INITIAL_CONTENT),
			textKind: "rich_text",
			collaborationEnabled: true,
			assetId: assets.versionSnapshotAssetId,
			createdBy: member.userId,
			updatedBy: member.userId,
			writePolicy: null,
			newChildWritePolicy: null,
			restrictedScopeNodeId: null,
			isRestrictedScopeRoot: false,
			archiveOperationId: null,
			contentTooLargeByteSize: null,
			contentShapeMismatchAt: null,
			contentYjsStateTooLargeByteSize: null,
			contentFrontmatterTooLargeFieldCount: null,
			contentFrontmatterTooLargeIndexDocumentCount: null,
		});
		expect(state.chunks).toHaveLength(1);
		expect(state.plainChunks).toHaveLength(1);
		const { plainTextChunk, ...markdownChunk } = chunk;
		const contentScope = {
			organizationId: db.organizationId,
			workspaceId: db.workspaceId,
			fileNodeId: node._id,
			sourceKind: "committed",
			yjsSequence: 0,
		};
		expect(state.chunks[0]).toMatchObject({ ...contentScope, ...markdownChunk });
		expect(state.plainChunks[0]).toMatchObject({
			...contentScope,
			...chunk,
			plainTextChunk,
			textChunkId: state.chunks[0]!._id,
			path: "/note.md",
			hasChunkAbove: false,
			hasChunkBelow: false,
		});
		expect(state.stats).toHaveLength(1);
		expect(state.stats[0]).toMatchObject({
			_id: node.statsId,
			fileNodeId: node._id,
			lineCount: 2,
			wordCount: 9,
			charCount: files_INITIAL_CONTENT.length,
		});
		expect(state.yjsSnapshots).toHaveLength(1);
		expect(state.yjsSnapshots[0]).toMatchObject({
			_id: node.yjsSnapshotId,
			fileNodeId: node._id,
			sequence: 0,
			assetId: assets.yjsSnapshotAssetId,
			createdBy: member.userId,
			updatedBy: member.userId,
		});
		expect(state.sequences).toHaveLength(1);
		expect(state.sequences[0]).toMatchObject({
			_id: node.yjsLastSequenceId,
			fileNodeId: node._id,
			lastSequence: 0,
			unmaterializedUpdateCount: 0,
			unmaterializedUpdateBytes: 0,
			lineageGeneration: 0,
		});
		expect(state.updates).toEqual([]);
		expect(state.metadata).toEqual([]);
		expect(state.snapshots).toHaveLength(1);
		expect(state.snapshots[0]).toMatchObject({
			fileNodeId: node._id,
			assetId: assets.versionSnapshotAssetId,
			createdBy: member.userId,
			archivedAt: -1,
			contentType: node.contentType,
			yjsRootKind: "rich_text",
			collaborationEnabled: true,
		});
		const published = await t.run(async (ctx) => ({
			yjs: await ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId),
			version: await ctx.db.get("files_r2_assets", assets.versionSnapshotAssetId),
			jobs: await ctx.db.query("files_r2_object_deletion_jobs").collect(),
		}));
		expect(published.yjs).toMatchObject({
			kind: "yjs_snapshot",
			size: snapshotSize,
			r2Key: r2_create_asset_key({ ...db, assetId: assets.yjsSnapshotAssetId }),
		});
		expect(published.version).toMatchObject({
			kind: "content_snapshot",
			size: files_get_utf8_byte_size(files_INITIAL_CONTENT),
			r2Key: r2_create_asset_key({ ...db, assetId: assets.versionSnapshotAssetId }),
		});
		expect(published.yjs?.unfinalizedExpiresAt).toBeUndefined();
		expect(published.version?.unfinalizedExpiresAt).toBeUndefined();
		expect(published.jobs).toEqual([]);
	});

	test("creates nested folders and inherits their default", async () => {
		const { t, db, asOwner, member, finalize, folder, readFileDocs } = await fixture();
		const parentId = await folder("docs");
		await t.run((ctx) =>
			ctx.db.patch("files_nodes", parentId, {
				writePolicy: { mode: "writer", writers: [{ kind: "user", userId: member.userId }] },
			}),
		);
		const defaultChanged = await asOwner.mutation(api.files_nodes.set_node_new_child_write_policy, {
			membershipId: db.membershipId,
			nodeId: parentId,
			newChildWritePolicy: { mode: "read_only" },
		});
		expect(defaultChanged._nay).toBeUndefined();
		const created = await finalize({ parentId, path: "a/b/note.md" });
		if (created._nay) throw new Error(created._nay.message);
		const state = await readFileDocs();
		expect(state.nodes.map((node) => node.path)).toEqual(["/docs", "/docs/a", "/docs/a/b", "/docs/a/b/note.md"]);
		for (const node of state.nodes.slice(1)) {
			expect(node.writePolicy).toEqual({ mode: "read_only" });
			expect(node.newChildWritePolicy).toEqual(node.kind === "folder" ? { mode: "read_only" } : null);
		}
		expect(state.plainChunks[0]?.path).toBe("/docs/a/b/note.md");
		expect(state.snapshots[0]?.fileNodeId).toBe(created._yay.nodeId);
	});

	test("checks the destination lock before an occupied target", async () => {
		const { t, db, scope, assets, finalize, folder, readFileDocs } = await fixture();
		const parentId = await folder("docs");
		const destination = { parentId, path: "note.md" };
		expect(
			await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, { ...scope, ...destination }),
		).toEqual({ canWrite: true, targetNodeId: null });
		await folder("note.md", parentId);
		await t.run((ctx) => ctx.db.patch("files_nodes", parentId, { writePolicy: { mode: "read_only" } }));
		const before = await readFileDocs();
		const refused = await finalize(destination);
		expect(refused._nay).toMatchObject({ name: "read_only", message: "This item is read-only." });
		expect(await readFileDocs()).toEqual(before);
		const cleanup = await t.run(async (ctx) => ({
			assets: await ctx.db.query("files_r2_assets").collect(),
			jobs: await ctx.db.query("files_r2_object_deletion_jobs").collect(),
		}));
		expect(cleanup.assets).toEqual([]);
		expect(cleanup.jobs.map((job) => job.r2Key).sort()).toEqual(
			[assets.yjsSnapshotAssetId, assets.versionSnapshotAssetId]
				.map((assetId) => r2_create_asset_key({ ...db, assetId }))
				.sort(),
		);
		expect(cleanup.jobs.map((job) => job.reason)).toEqual(["read_only_create", "read_only_create"]);
	});

	test("refuses a file that appeared at an intermediate path", async () => {
		const { t, db, scope, assets, insertAssets, finalize, folder, readFileDocs } = await fixture();
		const parentId = await folder("docs");
		const destination = { parentId, path: "block.md/a/note.md" };
		expect(
			await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, { ...scope, ...destination }),
		).toEqual({ canWrite: true, targetNodeId: null });
		const existingAssets = await insertAssets();
		const existing = await t.mutation(internal.files_nodes_content.create_file_node, {
			...scope,
			parentId,
			path: "block.md",
			assetId: existingAssets.versionSnapshotAssetId,
			yjsSnapshotAssetId: existingAssets.yjsSnapshotAssetId,
			contentType: "text/markdown;charset=utf-8",
			textContent: files_INITIAL_CONTENT,
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: [existingAssets.yjsSnapshotAssetId, existingAssets.versionSnapshotAssetId],
		});
		if (existing._nay) throw new Error(existing._nay.message);
		const before = await readFileDocs();
		const assetsBefore = await t.run(async (ctx) => [
			await ctx.db.get("files_r2_assets", existingAssets.yjsSnapshotAssetId),
			await ctx.db.get("files_r2_assets", existingAssets.versionSnapshotAssetId),
		]);
		const refused = await finalize(destination);
		expect(refused._nay?.message).toBe("This folder already exists.");
		expect(await readFileDocs()).toEqual(before);
		const cleanup = await t.run(async (ctx) => ({
			assets: await ctx.db.query("files_r2_assets").collect(),
			jobs: await ctx.db.query("files_r2_object_deletion_jobs").collect(),
		}));
		expect(cleanup.assets).toEqual(assetsBefore);
		expect(cleanup.jobs.map((job) => job.r2Key).sort()).toEqual(
			[assets.yjsSnapshotAssetId, assets.versionSnapshotAssetId]
				.map((assetId) => r2_create_asset_key({ ...db, assetId }))
				.sort(),
		);
		expect(cleanup.jobs.map((job) => job.reason)).toEqual(["read_only_create", "read_only_create"]);
	});
});
