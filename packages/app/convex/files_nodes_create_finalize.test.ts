import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { access_control_db_ensure_role_assignment } from "./access_control.ts";
import { files_nodes_create_yjs_snapshot_update_from_text } from "./files_nodes_content.ts";
import { r2_create_asset_key } from "./r2_client.ts";
import { test_convex, test_mocks_fill_db_with } from "./setup.test.ts";
import { files_chunk_markdown } from "../server/files-markdown-chunking-mastra.ts";
import { files_INITIAL_CONTENT, files_ROOT_ID, files_get_utf8_byte_size } from "../shared/files.ts";
import { files_metadata_preflight_frontmatter } from "../shared/files-metadata.ts";

async function fixture(variant: "current" | "split" = "split") {
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
	const assets = await t.mutation(internal.r2_client.insert_file_creation_assets, {
		...scope,
		yjsSnapshotSize: snapshot._yay.byteLength,
		versionSnapshotSize: files_get_utf8_byte_size(files_INITIAL_CONTENT),
	});
	const finalize = (args: { parentId: Id<"files_nodes"> | "root"; path: string }) =>
		variant === "current"
			? t.mutation(internal.files_nodes_content.create_file_node, {
					...scope,
					...args,
					assetId: assets.versionSnapshotAssetId,
					yjsSnapshotAssetId: assets.yjsSnapshotAssetId,
					contentType: "text/markdown;charset=utf-8",
					textContent: files_INITIAL_CONTENT,
					rootKind: "rich_text",
					readOnly: false,
					unpublishedAssetIds: [assets.yjsSnapshotAssetId, assets.versionSnapshotAssetId],
				})
			: t.mutation(internal.files_nodes_create_finalize.finalize_text_node_creation, {
					...scope,
					...assets,
					...args,
					plainTextContent: chunk.plainTextChunk,
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
		}));
	return {
		t,
		db,
		asOwner,
		member,
		scope,
		chunk,
		assets,
		snapshotSize: snapshot._yay.byteLength,
		finalize,
		folder,
		readFileDocs,
	};
}

describe("finalize_text_node_creation", () => {
	test("the fixed template needs one whole Markdown chunk and no frontmatter", async () => {
		const chunked = await files_chunk_markdown(files_INITIAL_CONTENT);
		if (chunked._nay) throw new Error(chunked._nay.message);
		expect(chunked._yay).toEqual([
			{
				chunkIndex: 0,
				textChunk: files_INITIAL_CONTENT,
				plainTextChunk: "Welcome\n\nYou can start editing your document here.",
				startIndex: 0,
				endIndex: files_INITIAL_CONTENT.length,
				lineStart: 1,
				lineEnd: 3,
				chunkFlags: 0,
			},
		]);
		const frontmatter = files_metadata_preflight_frontmatter(files_INITIAL_CONTENT);
		expect(frontmatter).toEqual({
			_yay: { metadata: { fields: [], values: [] }, fieldCount: 0, indexDocumentCount: 0 },
		});
	});

	test.each(["current", "split"] as const)("%s finalizer publishes the full initial file state", async (variant) => {
		const { t, db, member, chunk, assets, snapshotSize, finalize, readFileDocs } = await fixture(variant);
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

	test.each(["current", "split"] as const)(
		"%s finalizer creates nested folders and inherits their default",
		async (variant) => {
			const { t, db, asOwner, member, finalize, folder, readFileDocs } = await fixture(variant);
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
		},
	);

	test.each(["current", "split"] as const)(
		"%s finalizer checks the destination lock before an occupied target",
		async (variant) => {
			const { t, db, scope, assets, finalize, folder, readFileDocs } = await fixture(variant);
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
		},
	);

	test.each(["current", "split"] as const)(
		"%s finalizer refuses a file that appeared at an intermediate path",
		async (variant) => {
			const { t, db, scope, assets, snapshotSize, finalize, folder, readFileDocs } = await fixture(variant);
			const parentId = await folder("docs");
			const destination = { parentId, path: "block.md/a/note.md" };
			expect(
				await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, { ...scope, ...destination }),
			).toEqual({ canWrite: true, targetNodeId: null });
			const existingAssets = await t.mutation(internal.r2_client.insert_file_creation_assets, {
				...scope,
				yjsSnapshotSize: snapshotSize,
				versionSnapshotSize: files_get_utf8_byte_size(files_INITIAL_CONTENT),
			});
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
		},
	);

	test.each([
		"inactive member",
		"pending removal",
		"lost permission",
		"missing parent",
		"archived parent",
		"file parent",
		"locked parent",
		"other writer",
		"occupied target",
	] as const)("refuses a changed destination: %s", async (change) => {
		const { t, db, member, scope, assets, finalize, folder, readFileDocs } = await fixture();
		const parentId = await folder("docs");
		const destination = { parentId, path: "a/note.md" };
		const captured = await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, {
			...scope,
			...destination,
		});
		expect(captured).toEqual({ canWrite: true, targetNodeId: null });
		await t.run(async (ctx) => {
			if (change === "inactive member") {
				await ctx.db.patch("organizations_workspaces_users", member.membershipId, { active: false });
			}
			if (change === "pending removal") {
				await ctx.db.patch("organizations_workspaces_users", member.membershipId, { pendingOrganizationRemoval: true });
			}
			if (change === "lost permission") {
				const role = await ctx.db
					.query("access_control_role_assignments")
					.withIndex("by_organization_workspace_user", (q) =>
						q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("userId", member.userId),
					)
					.first();
				if (!role) throw new Error("Expected member role");
				await ctx.db.patch("access_control_role_assignments", role._id, { role: "viewer" });
			}
			if (change === "missing parent") {
				await ctx.db.delete("files_nodes", parentId);
			}
			if (change === "archived parent") {
				await ctx.db.patch("files_nodes", parentId, { archiveOperationId: "changed-parent" });
			}
			if (change === "file parent") {
				await ctx.db.patch("files_nodes", parentId, { kind: "file", treePath: "/docs" });
			}
			if (change === "locked parent") {
				await ctx.db.patch("files_nodes", parentId, { writePolicy: { mode: "read_only" } });
			}
			if (change === "other writer") {
				await ctx.db.patch("files_nodes", parentId, {
					writePolicy: { mode: "writer", writers: [{ kind: "user", userId: db.userId }] },
				});
			}
		});
		if (change === "occupied target") await folder("a/note.md", parentId);
		const before = await readFileDocs();
		const refused = await finalize(destination);
		expect(refused._nay?.message).toBe(
			change === "archived parent" || change === "file parent"
				? "Not found"
				: change === "locked parent" || change === "other writer"
					? "This item is read-only."
					: change === "occupied target"
						? "This file already exists."
						: "Permission denied",
		);
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

	test("a newly hidden prefix refuses before exposing its lock or adding folders", async () => {
		const { t, db, asOwner, scope, assets, finalize, folder, readFileDocs } = await fixture();
		const parentId = await folder("docs");
		const hiddenId = await folder("hidden", parentId);
		const destination = { parentId, path: "hidden/a/note.md" };
		expect(
			await t.query(internal.files_nodes_content.get_create_file_node_write_preflight, { ...scope, ...destination }),
		).toEqual({ canWrite: true, targetNodeId: null });
		const restricted = await asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: db.membershipId,
			nodeId: hiddenId,
		});
		expect(restricted._nay).toBeUndefined();
		await t.run((ctx) => ctx.db.patch("files_nodes", hiddenId, { writePolicy: { mode: "read_only" } }));
		const before = await readFileDocs();
		const refused = await finalize(destination);
		expect(refused._nay).toMatchObject({ message: "Permission denied" });
		expect(refused._nay?.name).not.toBe("read_only");
		expect(await readFileDocs()).toEqual(before);
		const jobs = await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs.map((job) => job.r2Key).sort()).toEqual(
			[assets.yjsSnapshotAssetId, assets.versionSnapshotAssetId]
				.map((assetId) => r2_create_asset_key({ ...db, assetId }))
				.sort(),
		);
	});

	test("a folder grant allows a viewer to publish nested content in that scope", async () => {
		const { t, db, asOwner, member, finalize, folder, readFileDocs } = await fixture();
		const parentId = await folder("shared");
		await t.run(async (ctx) => {
			const role = await ctx.db
				.query("access_control_role_assignments")
				.withIndex("by_organization_workspace_user", (q) =>
					q.eq("organizationId", db.organizationId).eq("workspaceId", db.workspaceId).eq("userId", member.userId),
				)
				.first();
			if (!role) throw new Error("Expected member role");
			await ctx.db.patch("access_control_role_assignments", role._id, { role: "viewer" });
		});
		const restricted = await asOwner.mutation(api.files_sharing.restrict_node, {
			membershipId: db.membershipId,
			nodeId: parentId,
		});
		expect(restricted._nay).toBeUndefined();
		const granted = await asOwner.mutation(api.files_sharing.set_node_share_grant, {
			membershipId: db.membershipId,
			nodeId: parentId,
			principal: { kind: "user", userId: member.userId },
			level: "write",
		});
		expect(granted._nay).toBeUndefined();
		const created = await finalize({ parentId, path: "a/note.md" });
		if (created._nay) throw new Error(created._nay.message);
		const state = await readFileDocs();
		for (const node of state.nodes.filter((node) => node.path.startsWith("/shared/"))) {
			expect(node.restrictedScopeNodeId).toBe(parentId);
			expect(node.isRestrictedScopeRoot).toBe(false);
		}
		expect(state.snapshots[0]?.fileNodeId).toBe(created._yay.nodeId);
	});

	test("refusal leaves an already published asset and deletes only the other upload", async () => {
		const { t, db, assets, finalize, folder, readFileDocs } = await fixture();
		const parentId = await folder("docs");
		await t.run(async (ctx) => {
			await ctx.db.patch("files_nodes", parentId, { writePolicy: { mode: "read_only" } });
			await ctx.db.patch("files_r2_assets", assets.yjsSnapshotAssetId, {
				r2Key: r2_create_asset_key({ ...db, assetId: assets.yjsSnapshotAssetId }),
				unfinalizedExpiresAt: undefined,
			});
		});
		const publishedBefore = await t.run((ctx) => ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId));
		const before = await readFileDocs();
		expect((await finalize({ parentId, path: "a/note.md" }))._nay?.name).toBe("read_only");
		expect(await readFileDocs()).toEqual(before);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId))).toEqual(publishedBefore);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", assets.versionSnapshotAssetId))).toBeNull();
		const jobs = await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect());
		expect(jobs.map((job) => job.r2Key)).toEqual([
			r2_create_asset_key({ ...db, assetId: assets.versionSnapshotAssetId }),
		]);
	});

	test("a missing version asset at the late guard rolls back folders and every content write", async () => {
		const { t, assets, finalize, readFileDocs } = await fixture();
		await t.run((ctx) => ctx.db.delete("files_r2_assets", assets.versionSnapshotAssetId));
		const before = await readFileDocs();
		const assetBefore = await t.run((ctx) => ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId));
		await expect(finalize({ parentId: files_ROOT_ID, path: "a/b/note.md" })).rejects.toThrow(
			"Editable file creation asset id points to a missing files_r2_assets doc",
		);
		expect(await readFileDocs()).toEqual(before);
		expect(await t.run((ctx) => ctx.db.get("files_r2_assets", assets.yjsSnapshotAssetId))).toEqual(assetBefore);
		expect(await t.run((ctx) => ctx.db.query("files_r2_object_deletion_jobs").collect())).toEqual([]);
	});
});
