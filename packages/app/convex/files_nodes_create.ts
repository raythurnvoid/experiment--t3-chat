// File and folder creation test: keep upload and content modules out of the runtime imports.
// The existing public functions stay available for the timing comparison.

import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { Result } from "common/errors-as-values-utils.ts";
import { encodeStateAsUpdate } from "yjs";
import { api, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { action, mutation, type MutationCtx } from "./_generated/server.js";
import {
	server_convex_get_user_fallback_to_anonymous,
	path_extract_segments_from,
	path_join,
} from "../server/server-utils.ts";
import { v_result } from "../server/convex-utils.ts";
import {
	files_INITIAL_CONTENT,
	files_ROOT_ID,
	files_get_utf8_byte_size,
	files_u8_to_array_buffer,
} from "../shared/files.ts";
import { files_yjs_doc_create_from_text } from "../shared/files-tiptap.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_sort_text_key } from "../shared/files-sort.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_authorize_node,
	access_control_db_can_act_on_file_node,
} from "./access_control.ts";
import { files_media_validation_db_advance_version } from "./files_media_validation.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { r2_create_asset_key, r2_put_object } from "./r2_client.ts";
import type { create_file_node, get_create_file_node_write_preflight } from "./files_nodes_content.ts";
import type { files_nodes_get_user_file_write_access_Result } from "./files_nodes.ts";

// Reuse the loaded module for mutations. Actions still load it for every call.
export const experimental_reuseContext = true;

type get_create_file_node_write_preflight_Result =
	typeof get_create_file_node_write_preflight extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

type create_file_node_Result =
	typeof create_file_node extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
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

		// Keep the current transaction. It rechecks access and publishes every file doc together.
		const created = (await ctx.runMutation(internal.files_nodes_content.create_file_node, {
			userId: userAuth.id,
			organizationId: membership.organizationId,
			workspaceId: membership.workspaceId,
			parentId: args.parentId,
			path: args.path,
			contentType: "text/markdown;charset=utf-8",
			assetId: versionSnapshotAssetId,
			yjsSnapshotAssetId,
			textContent: files_INITIAL_CONTENT,
			rootKind: "rich_text",
			readOnly: false,
			unpublishedAssetIds: assetIds,
		})) as create_file_node_Result;
		return created;
	},
});

async function db_has_folder_write_permission(
	ctx: MutationCtx,
	args: { membership: Doc<"organizations_workspaces_users">; node: Doc<"files_nodes"> | null },
) {
	const membership = await ctx.db
		.query("organizations_workspaces_users")
		.withIndex("by_active_user_organization_workspace", (q) =>
			q
				.eq("active", true)
				.eq("userId", args.membership.userId)
				.eq("organizationId", args.membership.organizationId)
				.eq("workspaceId", args.membership.workspaceId),
		)
		.first();
	if (!membership || membership.pendingOrganizationRemoval) {
		return false;
	}
	const authorized = await access_control_db_authorize_membership(ctx, {
		userAuth: { id: membership.userId },
		membership,
		fileNode: args.node ?? undefined,
		permission: "content.write",
	});
	return !authorized._nay;
}

// Copy only the ordinary folder path for this temporary timing test. Keep the old door unchanged.
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

		const authorized =
			args.parentId === files_ROOT_ID
				? await access_control_db_authorize_membership(ctx, { userAuth, membership, permission: "content.write" })
				: await access_control_db_authorize_node(ctx, {
						userAuth,
						membership,
						nodeId: args.parentId,
						permission: "content.write",
					});
		if (authorized._nay) return authorized;

		let parentNode = args.parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", args.parentId);
		if (
			args.parentId !== files_ROOT_ID &&
			(!parentNode ||
				parentNode.organizationId !== membership.organizationId ||
				parentNode.workspaceId !== membership.workspaceId ||
				parentNode.kind !== "folder" ||
				parentNode.archiveOperationId !== null)
		) {
			return Result({ _nay: { message: "Not found" } });
		}

		const segments = path_extract_segments_from(args.path);
		let parentPath = parentNode?.path ?? "/";
		let firstMissing = 0;
		// Resolve the full existing prefix before writing any folder.
		for (const [index, name] of segments.entries()) {
			const existing = await ctx.db
				.query("files_nodes")
				.withIndex("by_organization_workspace_parent_name_archiveOperation", (q) =>
					q
						.eq("organizationId", membership.organizationId)
						.eq("workspaceId", membership.workspaceId)
						.eq("parentId", parentNode?._id ?? files_ROOT_ID)
						.eq("name", name)
						.eq("archiveOperationId", null),
				)
				.first();
			firstMissing = index;
			if (!existing) break;
			if (
				!(await access_control_db_can_act_on_file_node(ctx, {
					organizationId: membership.organizationId,
					workspaceId: membership.workspaceId,
					userId: userAuth.id,
					fileNode: existing,
					permission: "content.write",
				}))
			) {
				return Result({ _nay: { message: "Permission denied" } });
			}
			if (existing.kind !== "folder" || index === segments.length - 1) {
				if (!(await db_has_folder_write_permission(ctx, { membership, node: existing }))) {
					return Result({ _nay: { message: "Permission denied" } });
				}
				return Result({ _nay: { message: "This folder already exists." } });
			}
			parentNode = existing;
			parentPath = existing.path;
		}

		if (!(await db_has_folder_write_permission(ctx, { membership, node: parentNode }))) {
			return Result({ _nay: { message: "Permission denied" } });
		}
		const policy = parentNode?.writePolicy ?? null;
		if (
			policy !== null &&
			(policy.mode === "read_only" ||
				!policy.writers.some((writer) => writer.kind === "user" && writer.userId === userAuth.id))
		) {
			return Result({ _nay: { name: "read_only", message: "This item is read-only." } });
		}

		const missingNames = segments.slice(firstMissing);
		let parentId: Id<"files_nodes"> | "root" = parentNode?._id ?? files_ROOT_ID;
		let path = parentPath;
		const now = Date.now();
		for (const [index, name] of missingNames.entries()) {
			path = path_join(path, name);
			const parent = parentId === files_ROOT_ID ? null : await ctx.db.get("files_nodes", parentId);
			const parentDefault = parent?.newChildWritePolicy ?? null;
			const nodeId = await ctx.db.insert("files_nodes", {
				organizationId: membership.organizationId,
				workspaceId: membership.workspaceId,
				parentId,
				kind: "folder",
				name,
				sortName: files_sort_text_key(name),
				path,
				treePath: path === "/" ? path : `${path}/`,
				pathDepth: path === "/" ? 0 : path_extract_segments_from(path).length,
				lowercaseExtension: null,
				contentType: null,
				assetId: null,
				contentByteSize: null,
				textKind: null,
				collaborationEnabled: null,
				yjsSnapshotId: null,
				yjsLastSequenceId: null,
				statsId: null,
				contentTooLargeByteSize: null,
				contentShapeMismatchAt: null,
				contentYjsStateTooLargeByteSize: null,
				contentFrontmatterTooLargeFieldCount: null,
				contentFrontmatterTooLargeIndexDocumentCount: null,
				restrictedScopeNodeId: parent?.restrictedScopeNodeId ?? null,
				isRestrictedScopeRoot: false,
				writePolicy: parentDefault,
				newChildWritePolicy: parentDefault,
				archiveOperationId: null,
				createdBy: userAuth.id,
				updatedBy: userAuth.id,
				updatedAt: now,
			});
			await files_media_validation_db_advance_version(ctx, membership);
			if (index === missingNames.length - 1) {
				return Result({ _yay: { nodeId } });
			}
			parentId = nodeId;
		}

		const errorMessage = "nodeId not resolved after node path creation";
		const errorData = {};
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	},
});
