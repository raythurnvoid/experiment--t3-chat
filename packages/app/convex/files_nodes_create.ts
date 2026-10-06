// File and folder creation test: keep upload and content modules out of the runtime imports.
// The existing public functions stay available for the timing comparison.

import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { encodeStateAsUpdate } from "yjs";
import { api, internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { action } from "./_generated/server.js";
import { mutation } from "./functions.ts";
import { server_convex_get_user_fallback_to_anonymous } from "../server/server-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import {
	files_INITIAL_CONTENT,
	files_ROOT_ID,
	files_get_utf8_byte_size,
	files_u8_to_array_buffer,
} from "../shared/files.ts";
import { files_yjs_doc_create_from_text, files_tiptap_markdown_to_plain_text } from "../shared/files-tiptap.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { r2_create_asset_key, r2_put_object } from "./r2_client.ts";
import { files_nodes_create_db_create_node } from "./files_nodes_create_db.ts";
import type { get_create_file_node_write_preflight } from "./files_nodes_content.ts";
import type { finalize_text_node_creation } from "./files_nodes_create_finalize.ts";
import type { files_nodes_get_user_file_write_access_Result } from "./files_nodes.ts";

// Reuse the loaded module for mutations. Actions still load it for every call.
export const experimental_reuseContext = true;

type get_create_file_node_write_preflight_Result =
	typeof get_create_file_node_write_preflight extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

type finalize_text_node_creation_Result =
	typeof finalize_text_node_creation extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const create_text_node = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		const membership = (await ctx.runQuery(api.organizations.get_membership, {
			membershipId: args.membershipId,
		})) as Doc<"organizations_workspaces_users"> | null;
		if (!membership || membership.userId !== userAuth.id) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		const allowed = (await ctx.runQuery(internal.files_nodes.get_user_file_write_access, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			nodeId: args.parentId,
		})) as files_nodes_get_user_file_write_access_Result;
		if (allowed._nay) {
			return allowed;
		}

		const preflight = (await ctx.runQuery(internal.files_nodes_content.get_create_file_node_write_preflight, {
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			userId: userAuth.id,
			parentId: args.parentId,
			path: args.path,
		})) as get_create_file_node_write_preflight_Result;
		if (!preflight) {
			return Result({ _nay: { message: "Not found" } });
		}
		if (!preflight.canWrite) {
			return Result({ _nay: { name: "read_only", message: "This item is read-only." } });
		}
		if (preflight.targetNodeId !== null) {
			return Result({ _nay: { name: "nay", message: "This file already exists." } });
		}

		const plainText = files_tiptap_markdown_to_plain_text({ markdown: files_INITIAL_CONTENT });
		if (plainText._nay) {
			return plainText;
		}

		// New file always starts as Markdown, even when its name has another extension.
		const yjsDoc = files_yjs_doc_create_from_text({ text: files_INITIAL_CONTENT, rootKind: "rich_text" });
		if ("_nay" in yjsDoc) {
			return yjsDoc;
		}
		const snapshotUpdate = files_u8_to_array_buffer(encodeStateAsUpdate(yjsDoc));
		yjsDoc.destroy();

		const { yjsSnapshotAssetId, versionSnapshotAssetId } = await ctx.runMutation(
			internal.r2_client.insert_file_creation_assets,
			{
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				userId: userAuth.id,
				yjsSnapshotSize: snapshotUpdate.byteLength,
				versionSnapshotSize: files_get_utf8_byte_size(files_INITIAL_CONTENT),
			},
		);
		const assetIds = [yjsSnapshotAssetId, versionSnapshotAssetId];
		const yjsSnapshotR2Key = r2_create_asset_key({
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			assetId: yjsSnapshotAssetId,
		});
		const versionSnapshotR2Key = r2_create_asset_key({
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			assetId: versionSnapshotAssetId,
		});

		const putResults = await Promise.allSettled([
			r2_put_object(ctx, {
				key: yjsSnapshotR2Key,
				body: snapshotUpdate,
				contentType: "application/octet-stream",
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: files_INITIAL_CONTENT,
				contentType: "text/markdown;charset=utf-8",
			}),
		]);
		const failedPut = putResults.find((result) => result.status === "rejected");
		if (failedPut?.status === "rejected") {
			// Wait for both PUTs before cleanup, so a late PUT cannot recreate a deleted object.
			await ctx.runMutation(internal.files_nodes_content.cleanup_file_node_creation_assets, {
				assetIds,
				r2Keys: [yjsSnapshotR2Key, versionSnapshotR2Key],
				durableTenantScope: {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
				},
			});
			console.error("Failed to write initial file content assets", {
				error: failedPut.reason,
				yjsSnapshotAssetId,
				versionSnapshotAssetId,
			});
			return Result({ _nay: { message: "Failed to create file" } });
		}

		const created = (await ctx.runMutation(internal.files_nodes_create_finalize.finalize_text_node_creation, {
			userId: userAuth.id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId: args.parentId,
			path: args.path,
			yjsSnapshotAssetId,
			versionSnapshotAssetId,
			plainTextContent: plainText._yay,
		})) as finalize_text_node_creation_Result;
		return created;
	},
});

// The temporary file and folder paths share their ordinary node writes.
export const create_folder_node = mutation({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		path: v.string(),
	},
	returns: v_result({ _yay: v.object({ nodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		const userAuthPromise = server_convex_get_user_fallback_to_anonymous(ctx);
		const membershipPromise = ctx.db.get("organizations_workspaces_users", args.membershipId);
		const userAuth = await userAuthPromise;
		if (!userAuth) {
			await membershipPromise;
			return Result({ _nay: { message: "Unauthenticated" } });
		}
		const [rateLimit, membership] = await Promise.all([
			rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: userAuth.id }),
			membershipPromise,
		]);
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}
		if (!membership || membership.userId !== userAuth.id || membership.active === false) {
			return Result({ _nay: { message: "Unauthorized" } });
		}

		return await files_nodes_create_db_create_node(ctx, {
			membership,
			parentId: args.parentId,
			path: args.path,
			kind: "folder",
		});
	},
});
