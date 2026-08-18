import { Workpool, vWorkId } from "@convex-dev/workpool";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import { v } from "convex/values";
import { doc } from "convex-helpers/validators";
import { z } from "zod";
import { components, internal } from "./_generated/api.js";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	query,
	type ActionCtx,
	type MutationCtx,
} from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
	server_convex_get_user_fallback_to_anonymous,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import {
	r2_create_asset_key,
	r2_copy_object_to_immutable_key,
	r2_delete_object,
	r2_enqueue_object_deletion_job,
	r2_fetch_object_from_bucket,
	r2_get_bucket,
	r2_get_download_url,
	r2_put_object,
	r2_PUT_MAY_ARRIVE_MARGIN_MS,
	r2_UNFINALIZED_ASSET_TTL_MS,
} from "./r2_client.ts";
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
	organizations_is_reserved_workspace_id,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { ai_chat_GENERATED_IMAGE_FORMAT } from "../shared/ai-chat.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import {
	access_control_db_authorize_membership,
	access_control_db_filter_readable_file_nodes,
} from "./access_control.ts";
import { plugins_runtime_db_enqueue_upload_completed_runs } from "./plugins_runtime.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_editable_text_content_type,
	files_get_editable_text_yjs_root_kind,
	files_get_signed_download_serving,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
	files_normalize_text_document_input,
	type files_ContentType,
	type files_YjsRootKind,
} from "../server/files.ts";
import {
	files_metadata_MAX_FRONTMATTER_FIELDS,
	files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS,
	files_metadata_preflight_frontmatter,
} from "../shared/files-metadata.ts";
import app_convex_schema from "./schema.ts";
import {
	db_get_file_content_materialization_db_state,
	files_node_require_writable,
	files_nodes_db_hard_delete_node,
} from "./files_nodes.ts";
import {
	db_insert_file_text_content,
	files_nodes_create_yjs_snapshot_update_from_text,
} from "./files_nodes_content.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). Do not keep request state in module-level values.
export const experimental_reuseContext = true;

if (!process.env.CLOUDFLARE_EVENTS_SECRET) {
	throw convex_error({ message: "CLOUDFLARE_EVENTS_SECRET is not set in Convex env" });
}

const CLOUDFLARE_EVENTS_SECRET = process.env.CLOUDFLARE_EVENTS_SECRET;

/**
 * Narrow file content-storage scope to a real organization/workspace at a sink that cannot accept the
 * reserved external-mount scope. Upload/media processing only ever runs on real user files, so the
 * reserved literals are unreachable here.
 */
function r2_require_real_scope(
	organizationId: Id<"organizations"> | typeof organizations_GLOBAL_ORGANIZATION_ID,
	workspaceId:
		| Id<"organizations_workspaces">
		| typeof organizations_GLOBAL_GITHUB_WORKSPACE_ID
		| typeof organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
): { organizationId: Id<"organizations">; workspaceId: Id<"organizations_workspaces"> } {
	if (organizationId === organizations_GLOBAL_ORGANIZATION_ID || organizations_is_reserved_workspace_id(workspaceId)) {
		const errorMessage = "Reserved external-mount scope reached a sink that requires a real organization/workspace id";
		const errorData = { organizationId, workspaceId };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	return { organizationId, workspaceId };
}

/**
 * Narrow a file author to a real user id at a sink that cannot accept the reserved SYSTEM author.
 */
function r2_require_real_author(createdBy: Id<"users"> | typeof users_SYSTEM_AUTHOR): Id<"users"> {
	if (createdBy === users_SYSTEM_AUTHOR) {
		const errorMessage = "Reserved SYSTEM author reached a sink that requires a real user id";
		const errorData = { createdBy };
		console.error(errorMessage, errorData);
		throw should_never_happen(errorMessage, errorData);
	}
	return createdBy;
}

function extract_asset_id_from_r2_key(key: string) {
	const assetId = key.split("/").at(-1);

	return assetId || null;
}

export const insert_asset = internalMutation({
	args: {
		organizationId: doc(app_convex_schema, "files_r2_assets").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_r2_assets").fields.workspaceId,
		kind: doc(app_convex_schema, "files_r2_assets").fields.kind,
		size: doc(app_convex_schema, "files_r2_assets").fields.size,
		createdBy: doc(app_convex_schema, "files_r2_assets").fields.createdBy,
	},
	returns: v.id("files_r2_assets"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("files_r2_assets", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			kind: args.kind,
			r2Bucket: r2_get_bucket(),
			size: args.size,
			createdBy: args.createdBy,
			unfinalizedExpiresAt: now + r2_UNFINALIZED_ASSET_TTL_MS,
			updatedAt: now,
		});
	},
});

export const patch_asset = internalMutation({
	args: {
		assetId: v.id("files_r2_assets"),
		r2Key: doc(app_convex_schema, "files_r2_assets").fields.r2Key,
		size: v.optional(doc(app_convex_schema, "files_r2_assets").fields.size),
		etag: doc(app_convex_schema, "files_r2_assets").fields.etag,
		processingWorkId: v.optional(v.union(vWorkId, v.null())),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch("files_r2_assets", args.assetId, {
			// This helper receives `r2Key` only for an external mount whose node already uses this
			// asset. The asset is now published, so clear its cleanup deadline too.
			...(args.r2Key === undefined ? {} : { r2Key: args.r2Key, unfinalizedExpiresAt: undefined }),
			...(args.size === undefined ? {} : { size: args.size }),
			...(args.etag === undefined ? {} : { etag: args.etag }),
			...(args.processingWorkId === undefined ? {} : { processingWorkId: args.processingWorkId }),
			updatedAt: Date.now(),
		});

		return null;
	},
});

export const get_asset_by_r2_event_key = internalQuery({
	args: {
		bucket: v.string(),
		key: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			asset: doc(app_convex_schema, "files_r2_assets"),
			keyKind: v.union(v.literal("upload_staging"), v.literal("legacy_upload"), v.literal("live")),
		}),
	}),
	handler: async (ctx, args) => {
		const parsedAssetId = extract_asset_id_from_r2_key(args.key);
		const assetId = parsedAssetId ? ctx.db.normalizeId("files_r2_assets", parsedAssetId) : null;
		const asset = assetId ? await ctx.db.get("files_r2_assets", assetId) : null;

		if (!asset || asset.r2Bucket !== args.bucket) {
			return Result({
				_nay: {
					message: "Not found",
				},
			});
		}

		if (asset.uploadStagingR2Key !== undefined) {
			if (args.key === asset.uploadStagingR2Key) {
				return Result({ _yay: { asset, keyKind: "upload_staging" as const } });
			}
			if (
				args.key ===
				r2_create_asset_key({
					organizationId: asset.organizationId,
					workspaceId: asset.workspaceId,
					assetId: asset._id,
				})
			) {
				return Result({ _yay: { asset, keyKind: "live" as const } });
			}
			return Result({ _nay: { message: "Not found" } });
		}

		// Old upload URLs wrote directly to the final key because they had no temporary key.
		return Result({ _yay: { asset, keyKind: "legacy_upload" as const } });
	},
});

type get_asset_by_r2_event_key_Result =
	typeof get_asset_by_r2_event_key extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Upload readiness and size for a page of assets, keyed by asset id. Kept separate from the
 * node-listing query on purpose: finalization patches assets on every upload, and folding this
 * into the listing would invalidate its cache entry each time.
 *
 * Pass only asset ids that already went through tenancy and visibility filtering; this query
 * does not re-check them.
 */
export const get_assets_ready_states = internalQuery({
	args: {
		assetIds: v.array(v.id("files_r2_assets")),
	},
	returns: v.record(v.id("files_r2_assets"), v.object({ ready: v.boolean(), size: v.number() })),
	handler: async (ctx, args) => {
		const assets = await Promise.all(args.assetIds.map((assetId) => ctx.db.get("files_r2_assets", assetId)));

		const states: Record<Id<"files_r2_assets">, { ready: boolean; size: number }> = {};
		for (const asset of assets) {
			if (!asset) {
				continue;
			}
			// "Ready" means the R2 object is confirmed at its key. Never derive this from the
			// processing state: a skipProcessing asset is settled from birth, before its object exists.
			states[asset._id] = { ready: asset.r2Key !== undefined, size: asset.size };
		}

		return states;
	},
});

export type r2_get_assets_ready_states_Result =
	typeof get_assets_ready_states extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Read one asset of a workspace the caller has already authorized.
 *
 * It checks no permission: the caller passes the organization and workspace it already proved the
 * user may read. Do not call it from a path that starts at a user request. `get_asset` below is the
 * one that asks the permission question.
 */
export const get_asset_by_id = internalQuery({
	args: {
		organizationId: v.string(),
		workspaceId: v.string(),
		assetId: v.id("files_r2_assets"),
	},
	returns: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
	handler: async (ctx, args) => {
		const asset = await ctx.db.get("files_r2_assets", args.assetId);
		if (!asset || asset.organizationId !== args.organizationId || asset.workspaceId !== args.workspaceId) {
			return null;
		}

		return asset;
	},
});

export type get_asset_by_id_Result =
	typeof get_asset_by_id extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_data_for_create_signed_download_url = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.object({
			fileNode: doc(app_convex_schema, "files_nodes"),
			asset: doc(app_convex_schema, "files_r2_assets"),
			materializationState: v.union(
				v.object({
					fileNode: doc(app_convex_schema, "files_nodes"),
					yjsSnapshotDoc: doc(app_convex_schema, "files_yjs_snapshots"),
					yjsLastSequenceDoc: doc(app_convex_schema, "files_yjs_docs_last_sequences"),
					yjsUpdatesDocs: v.array(doc(app_convex_schema, "files_yjs_updates")),
					asset: doc(app_convex_schema, "files_r2_assets"),
					yjsSnapshotAsset: doc(app_convex_schema, "files_r2_assets"),
				}),
				v.null(),
			),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			fileNode.archiveOperationId !== undefined ||
			!fileNode.assetId ||
			!fileNode.contentType
		) {
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.userId },
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		const assetId = fileNode.assetId;
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset || asset.organizationId !== fileNode.organizationId || asset.workspaceId !== fileNode.workspaceId) {
			const errorMessage = "fileNode.assetId points to a missing or mismatched files_r2_assets doc";
			const errorData = {
				fileNodeId: fileNode._id,
				assetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		return {
			fileNode,
			asset,
			materializationState: files_node_has_editable_yjs_state(fileNode)
				? await db_get_file_content_materialization_db_state(ctx, {
						organizationId: membership.organizationId,
						workspaceId: membership.workspaceId,
						nodeId: fileNode._id,
					})
				: null,
		};
	},
});

type get_data_for_create_signed_download_url_Result =
	typeof get_data_for_create_signed_download_url extends RegisteredQuery<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

/**
 * Machine-API variant of get_data_for_create_signed_download_url: the caller (public_api.ts) has
 * already authorized the principal against the tenant, so this resolves by explicit scope instead
 * of a membership. fileNodeId arrives from the wire, so a malformed or cross-tenant id is a plain
 * null (the route answers 404).
 */
export const get_data_for_public_download_url = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		fileNodeId: v.string(),
		/**
		 * Who is asking. Required, not optional, so a new caller cannot forget it and hand out a signed
		 * URL for a restricted file. The tenant check below is not enough on its own: a node id from
		 * before the file was restricted still names a node in the right workspace.
		 */
		visibilityUserId: v.id("users"),
	},
	returns: v.union(
		v.object({
			fileNode: doc(app_convex_schema, "files_nodes"),
			asset: doc(app_convex_schema, "files_r2_assets"),
			materializationState: v.union(
				v.object({
					fileNode: doc(app_convex_schema, "files_nodes"),
					yjsSnapshotDoc: doc(app_convex_schema, "files_yjs_snapshots"),
					yjsLastSequenceDoc: doc(app_convex_schema, "files_yjs_docs_last_sequences"),
					yjsUpdatesDocs: v.array(doc(app_convex_schema, "files_yjs_updates")),
					asset: doc(app_convex_schema, "files_r2_assets"),
					yjsSnapshotAsset: doc(app_convex_schema, "files_r2_assets"),
				}),
				v.null(),
			),
		}),
		v.null(),
	),
	handler: async (ctx, args) => {
		const fileNodeId = ctx.db.normalizeId("files_nodes", args.fileNodeId);
		if (!fileNodeId) {
			return null;
		}

		const fileNode = await ctx.db.get("files_nodes", fileNodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== args.organizationId ||
			fileNode.workspaceId !== args.workspaceId ||
			fileNode.archiveOperationId !== undefined ||
			fileNode.kind !== "file" ||
			!fileNode.assetId ||
			!fileNode.contentType
		) {
			return null;
		}

		const [readableNode] = await access_control_db_filter_readable_file_nodes(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			userId: args.visibilityUserId,
			nodes: [fileNode],
		});
		if (!readableNode) {
			return null;
		}

		const assetId = fileNode.assetId;
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset || asset.organizationId !== fileNode.organizationId || asset.workspaceId !== fileNode.workspaceId) {
			const errorMessage = "fileNode.assetId points to a missing or mismatched files_r2_assets doc";
			const errorData = {
				fileNodeId: fileNode._id,
				assetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		if (!files_node_has_editable_yjs_state(fileNode)) {
			return { fileNode, asset, materializationState: null };
		}

		const materializeScope = r2_require_real_scope(fileNode.organizationId, fileNode.workspaceId);
		return {
			fileNode,
			asset,
			materializationState: await db_get_file_content_materialization_db_state(ctx, {
				organizationId: materializeScope.organizationId,
				workspaceId: materializeScope.workspaceId,
				nodeId: fileNode._id,
			}),
		};
	},
});

export type r2_get_data_for_public_download_url_Result =
	typeof get_data_for_public_download_url extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Return a signed R2 URL for download.
 *
 * For Markdown files, ensure the R2 snapshot is up to date before returning the URL.
 */
export const create_signed_download_url = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v_result({
		_yay: v.object({
			url: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const data = (await ctx.runQuery(internal.r2.get_data_for_create_signed_download_url, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			fileNodeId: args.fileNodeId,
		})) as get_data_for_create_signed_download_url_Result;
		if (!data) {
			return Result({ _nay: { message: "Not found" } });
		}

		const { fileNode, materializationState } = data;
		let asset = data.asset;
		if (!fileNode.contentType) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Editable files: node.assetId points at the newest version snapshot. Materialize first
		// when the Yjs log is newer than the snapshot, or when the asset has no r2Key (old data).
		// Each materialization stores a fresh snapshot and points the node at it.
		if (files_node_has_editable_yjs_state(fileNode)) {
			if (!materializationState) {
				console.warn("Markdown file materialization state is missing", {
					materializationState,
					fileNodeId: fileNode._id,
					yjsSnapshotId: fileNode.yjsSnapshotId,
					yjsLastSequenceId: fileNode.yjsLastSequenceId,
				});
			} else if (
				materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence ||
				!asset.r2Key
			) {
				const downloadScope = r2_require_real_scope(fileNode.organizationId, fileNode.workspaceId);
				// Try to store a fresh version snapshot, but still allow downloading the older one if this fails.
				const materialized = await ctx.runAction(internal.files_nodes_content.materialize_file_content, {
					organizationId: downloadScope.organizationId,
					workspaceId: downloadScope.workspaceId,
					nodeId: fileNode._id,
					userId: userAuth.id,
					targetSequence: materializationState.yjsLastSequenceDoc.lastSequence,
				});
				if (materialized._nay) {
					console.warn("Failed to materialize Markdown before download", {
						fileNodeId: fileNode._id,
						nay: materialized._nay,
					});
				}
				const refreshed = (await ctx.runQuery(internal.r2.get_data_for_create_signed_download_url, {
					userId: userAuth.id,
					membershipId: args.membershipId,
					fileNodeId: args.fileNodeId,
				})) as get_data_for_create_signed_download_url_Result;
				// A null re-read means the caller lost access to the file: refuse instead of
				// signing a URL for the stale asset.
				if (!refreshed) {
					return Result({ _nay: { message: "Not found" } });
				}
				asset = refreshed.asset;
			}
		}

		if (!asset.r2Key) {
			return Result({ _nay: { message: "Not found" } });
		}

		// Stored object types are client input at upload time, and a presigned R2 GET carries no
		// nosniff/CSP — the pinned type plus the disposition is the whole defense. Both come from
		// the node NAME: only the literal media map serves inline (the app's <img>/<video> sources
		// go through here), everything else downloads as an attachment.
		const serving = files_get_signed_download_serving(fileNode.name);
		const url = await r2_get_download_url({
			key: asset.r2Key,
			options: {
				// 15 minutes.
				expiresIn: 15 * 60,
				responseContentType: serving.responseContentType,
				responseContentDisposition: serving.responseContentDisposition,
			},
		});

		return Result({ _yay: { url } });
	},
});

export const get_asset_by_file_node_id = query({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const membership = await organizations_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (
			!fileNode ||
			fileNode.organizationId !== membership.organizationId ||
			fileNode.workspaceId !== membership.workspaceId ||
			fileNode.archiveOperationId !== undefined ||
			!fileNode.assetId
		) {
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth,
			membership,
			permission: "content.read",
			fileNode,
		});
		if (authorized._nay) {
			return null;
		}

		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		if (!asset || asset.organizationId !== fileNode.organizationId || asset.workspaceId !== fileNode.workspaceId) {
			return null;
		}

		return asset;
	},
});

/**
 * Read the asset of a picture the chat agent drew. It answers null for an asset of any other kind.
 *
 * A generated picture has no file node, so this cannot go through the download path above. Workspace
 * `content.read` is the whole check, the same one `ai_chat.thread_messages_list` makes: a member who
 * can read the thread list can already read every thread in the workspace, so scoping the picture to
 * one thread would refuse what the surrounding surface allows.
 *
 * The `generated_image` check is what keeps that safe. A file asset must never be signed here: a
 * file download also puts its node through the per-node visibility filter, and this path has no node
 * to filter, so it would hand out files the member is not allowed to open.
 *
 * `assetId` arrives inside a chat message that the client writes, so it is a plain string here and a
 * value that is not an id answers null.
 */
export const get_asset = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("organizations_workspaces_users"),
		assetId: v.string(),
	},
	returns: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
	handler: async (ctx, args) => {
		const membership = await organizations_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const authorized = await access_control_db_authorize_membership(ctx, {
			userAuth: { id: args.userId },
			membership,
			permission: "content.read",
		});
		if (authorized._nay) {
			return null;
		}

		const assetId = ctx.db.normalizeId("files_r2_assets", args.assetId);
		if (!assetId) {
			return null;
		}

		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (
			!asset ||
			asset.kind !== "generated_image" ||
			asset.organizationId !== membership.organizationId ||
			asset.workspaceId !== membership.workspaceId
		) {
			return null;
		}

		return asset;
	},
});

type get_asset_Result =
	typeof get_asset extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Return a signed R2 URL for a picture the chat agent drew.
 */
export const create_signed_chat_image_url = action({
	args: {
		membershipId: v.id("organizations_workspaces_users"),
		assetId: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			url: v.string(),
		}),
	}),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return Result({ _nay: { message: "Unauthenticated" } });
		}

		const asset = (await ctx.runQuery(internal.r2.get_asset, {
			userId: userAuth.id,
			membershipId: args.membershipId,
			assetId: args.assetId,
		})) as get_asset_Result;
		if (!asset) {
			return Result({ _nay: { message: "Not found" } });
		}

		// The chat route writes the picture to this deterministic key while it streams, and only
		// storing the message that shows it sets `r2Key`. Both are the same key, so the picture can
		// already be shown while the message is still being written.
		const r2Key =
			asset.r2Key ??
			r2_create_asset_key({
				organizationId: asset.organizationId,
				workspaceId: asset.workspaceId,
				assetId: asset._id,
			});

		// Pin the served type and the disposition for the same reason a file download does: a
		// presigned R2 GET carries no nosniff and no CSP. The name is ours, because the chat route is
		// the only writer of this asset kind and it always asks OpenAI for the same format.
		const serving = files_get_signed_download_serving(`generated-image-${asset._id}.${ai_chat_GENERATED_IMAGE_FORMAT}`);
		const url = await r2_get_download_url({
			key: r2Key,
			options: {
				// 15 minutes.
				expiresIn: 15 * 60,
				responseContentType: serving.responseContentType,
				responseContentDisposition: serving.responseContentDisposition,
			},
		});

		return Result({ _yay: { url } });
	},
});

export const get_file_node_by_asset_id = internalQuery({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		assetId: v.id("files_r2_assets"),
	},
	returns: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_asset", (q) =>
				q.eq("organizationId", args.organizationId).eq("workspaceId", args.workspaceId).eq("assetId", args.assetId),
			)
			.first();
	},
});

type get_file_node_by_asset_id_Result =
	typeof get_file_node_by_asset_id extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

async function db_finalize_editable_text_file_node_from_r2_assets(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		fileNodeId: Id<"files_nodes">;
		path: Doc<"files_nodes">["path"];
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		userId: Id<"users">;
		/**
		 * The shape of the Yjs document this node gets. Written as `files_nodes.yjsRootKind` in
		 * the same publish patch as the other Yjs pointers.
		 */
		rootKind: files_YjsRootKind;
		/**
		 * The media type the node stores from now on. The caller derives it from the node NAME
		 * with the classifier, never from the client-declared upload type.
		 */
		contentType: string;
		yjsSnapshotAssetId: Id<"files_r2_assets">;
		yjsSnapshotSize: number;
		versionSnapshotAssetId: Id<"files_r2_assets">;
		versionSnapshotSize: number;
		text: string;
		/**
		 * Assets that share this conversion job and should become terminal
		 * when the file is published.
		 */
		processingWorkAssetIds: Array<Id<"files_r2_assets">>;
		now: number;
	},
) {
	// Mirror the materializer's frontmatter preflight (`finalize_file_yjs_repair` uses the same
	// escape). An uploaded `.md` can carry over-cap frontmatter while the markdown itself is
	// valid, so it must still convert. Letting the metadata insert helper's over-cap backstop
	// throw here would wedge the infinite-retry conversion workpool instead: every retry
	// re-uploads both R2 objects and inserts two more unfinalized asset docs, and the upload
	// never publishes. Commit the chunks without the metadata index, set the marker pair in the
	// same publish patch, and publish normally; the user's next fitting edit clears the pair
	// through normal materialization.
	const frontmatter = args.rootKind === "rich_text" ? files_metadata_preflight_frontmatter(args.text) : null;
	// An uploaded `.md` can carry frontmatter this parser cannot read. Publish it anyway with no
	// frontmatter index, the same escape the over-cap case takes. The markers stay clear, because
	// they mean over-cap and this file has no counts to show.
	if (frontmatter?._nay) {
		console.warn("Publishing upload without frontmatter metadata: the frontmatter could not be parsed", {
			fileNodeId: args.fileNodeId,
			error: frontmatter._nay,
		});
	}

	// Keep the counts only while they are over the caps, so the marker pair below reads them
	// straight from here and a fitting upload cannot leave a stale count behind.
	const frontmatterOverCapCounts =
		frontmatter?._yay != null &&
		(frontmatter._yay.fieldCount > files_metadata_MAX_FRONTMATTER_FIELDS ||
			frontmatter._yay.indexDocumentCount > files_metadata_MAX_FRONTMATTER_INDEX_DOCUMENTS)
			? frontmatter._yay
			: null;

	// There is nothing to index when the frontmatter is over the caps or could not be read.
	const skipFrontmatterIndex = frontmatterOverCapCounts !== null || frontmatter?._nay != null;

	// Create editable Yjs metadata for an existing node whose R2 objects were
	// already written by the caller.
	const [yjsSnapshotId, yjsLastSequenceId] = await Promise.all([
		ctx.db.insert("files_yjs_snapshots", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.fileNodeId,
			sequence: 0,
			assetId: args.yjsSnapshotAssetId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: args.now,
		}),
		ctx.db.insert("files_yjs_docs_last_sequences", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.fileNodeId,
			lastSequence: 0,
			unmaterializedUpdateCount: 0,
			unmaterializedUpdateBytes: 0,
			lineageGeneration: 0,
		}),
		db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.fileNodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId,
			yjsSequence: 0,
			rootKind: args.rootKind,
			textContent: args.text,
			skipFrontmatterIndex,
		}).then((chunks) => {
			if (chunks._nay) {
				throw convex_error({
					message: "Failed to chunk file content",
					cause: chunks._nay,
				});
			}
			return chunks;
		}),
	] as const).catch((error) => {
		const errorMessage = "Failed to finalize editable text file node";
		console.error(errorMessage, {
			error,
			fileNodeId: args.fileNodeId,
		});
		throw convex_error({
			message: errorMessage,
			cause: error,
		});
	});

	// Publish the editable file state and clear every asset that represented
	// this Workpool job. The node then points at the version snapshot instead of the upload
	// asset: the newest snapshot holds an editable file's current bytes.
	await Promise.all([
		ctx.db.patch("files_nodes", args.fileNodeId, {
			assetId: args.versionSnapshotAssetId,
			contentType: args.contentType,
			yjsSnapshotId,
			yjsLastSequenceId,
			// Record the shape beside the other Yjs pointers, in the same publish patch, so the
			// node and its document can never be born disagreeing.
			yjsRootKind: args.rootKind,
			// A node born with over-cap frontmatter carries the marker pair from its first
			// publish, exactly like a materialization settle would set it.
			...(frontmatterOverCapCounts !== null
				? {
						contentFrontmatterTooLargeFieldCount: frontmatterOverCapCounts.fieldCount,
						contentFrontmatterTooLargeIndexDocumentCount: frontmatterOverCapCounts.indexDocumentCount,
					}
				: {}),
			updatedBy: args.userId,
			updatedAt: args.now,
		}),
		ctx.db.patch("files_r2_assets", args.yjsSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.yjsSnapshotAssetId,
			}),
			size: args.yjsSnapshotSize,
			unfinalizedExpiresAt: undefined,
			updatedAt: args.now,
		}),
		ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.versionSnapshotAssetId,
			}),
			size: args.versionSnapshotSize,
			unfinalizedExpiresAt: undefined,
			updatedAt: args.now,
		}),
		...args.processingWorkAssetIds.map((assetId) =>
			ctx.db.patch("files_r2_assets", assetId, {
				processingWorkId: null,
				updatedAt: args.now,
			}),
		),
		ctx.db.insert("files_snapshots", {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			fileNodeId: args.fileNodeId,
			assetId: args.versionSnapshotAssetId,
			createdBy: args.userId,
			archivedAt: -1,
		}),
	]);

	return Result({ _yay: null });
}

// The registered name keeps its historical `markdown` spelling on purpose (renaming a registered
// function changes its generated reference; §14 records the decision). It finalizes every
// editable text class since the upload conversion generalized.
export const finalize_text_file_node_from_r2_assets = internalMutation({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		fileNodeId: v.id("files_nodes"),
		path: doc(app_convex_schema, "files_nodes").fields.path,
		archiveOperationId: doc(app_convex_schema, "files_nodes").fields.archiveOperationId,
		userId: v.id("users"),
		rootKind: v.union(v.literal("rich_text"), v.literal("plain_text")),
		contentType: v.string(),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		yjsSnapshotSize: v.number(),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		versionSnapshotSize: v.number(),
		text: v.string(),
		processingWorkAssetIds: v.array(v.id("files_r2_assets")),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const now = Date.now();
		const finalizeScope = r2_require_real_scope(args.organizationId, args.workspaceId);

		// Creating the node and upload URL accepted this upload. Finish it even if the node becomes
		// read-only while conversion runs.
		await db_finalize_editable_text_file_node_from_r2_assets(ctx, {
			...args,
			organizationId: finalizeScope.organizationId,
			workspaceId: finalizeScope.workspaceId,
			now,
		});
		return null;
	},
});

export async function get_billed_user_for_media_processing(ctx: ActionCtx, fileNode: Doc<"files_nodes">) {
	const scope = r2_require_real_scope(fileNode.organizationId, fileNode.workspaceId);
	const creditCheck = await ctx.runQuery(internal.billing.check_credits, {
		userId: r2_require_real_author(fileNode.createdBy),
		organizationId: scope.organizationId,
		minimumRequiredCents: 1,
	});
	if (!creditCheck.hasCredits || !creditCheck.billedUser) {
		return null;
	}

	return creditCheck.billedUser;
}

/**
 * Settle an upload conversion that fell back to the stored blob. Clears the processing marker
 * and dispatches the plugin upload event: a stored blob is exactly the state that dispatches
 * when no conversion applies, and the conversion action runs after
 * `process_uploaded_asset_event` already returned, so its exits cannot reach that mutation's
 * dispatch and have to dispatch here themselves.
 */
export const settle_upload_conversion_fallback = internalMutation({
	args: {
		assetId: v.id("files_r2_assets"),
		eventId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const asset = await ctx.db.get("files_r2_assets", args.assetId);
		if (!asset) {
			return null;
		}

		const fileNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_asset", (q) =>
				q.eq("organizationId", asset.organizationId).eq("workspaceId", asset.workspaceId).eq("assetId", asset._id),
			)
			.first();
		const now = Date.now();
		await ctx.db.patch("files_r2_assets", asset._id, {
			processingWorkId: null,
			updatedAt: now,
		});
		// Do not start plugins when the node is missing, archived, or already editable. This matches
		// the checks for a new upload.
		if (!fileNode || fileNode.archiveOperationId !== undefined || files_node_has_editable_yjs_state(fileNode)) {
			return null;
		}

		await plugins_runtime_db_enqueue_upload_completed_runs(ctx, {
			asset,
			fileNode,
			eventId: args.eventId,
		});
		return null;
	},
});

// The registered name keeps its historical `markdown` spelling on purpose (§14): since the
// upload conversion generalized, it converts every editable text upload — `.md` to a rich text
// document, the plain-text allow-list to `Y.Text` documents.
export const finalize_uploaded_text_file = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		assetId: v.id("files_r2_assets"),
		eventId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const [asset, fileNode] = (await Promise.all([
			ctx.runQuery(internal.r2.get_asset_by_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.assetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.assetId,
			}),
		])) as [get_asset_by_id_Result, get_file_node_by_asset_id_Result];
		if (!asset) {
			return null;
		}

		// No node references this upload, so there is nothing to convert and no node to
		// dispatch a plugin event for.
		if (!fileNode) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: asset._id,
				processingWorkId: null,
			});
			return null;
		}

		// Classify from the node NAME, like the enqueue gate. A rename between enqueue and this
		// run can make the name unrecognized; the node then stays a stored blob, which must
		// dispatch the plugin event like any other stored upload.
		const rootKind = files_get_editable_text_yjs_root_kind(fileNode.name);
		const classifierContentType = files_get_editable_text_content_type(fileNode.name);
		if (rootKind === null || classifierContentType === null) {
			await ctx.runMutation(internal.r2.settle_upload_conversion_fallback, {
				assetId: asset._id,
				eventId: args.eventId,
			});
			return null;
		}

		// A re-upload onto an already editable file keeps the editable document as-is. The node is
		// not a stored blob, so this exit keeps today's dispatch suppression.
		if (files_node_has_editable_yjs_state(fileNode)) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: asset._id,
				processingWorkId: null,
			});
			return null;
		}
		if (!asset.r2Key) {
			const errorMessage = "asset.r2Key is not set";
			const errorData = {
				assetId: asset._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		// Over-cap uploads stay stored files without downloading them; retrying cannot make
		// the content smaller, so settle immediately.
		if (asset.size !== undefined && asset.size > files_MAX_TEXT_CONTENT_BYTES) {
			await ctx.runMutation(internal.r2.settle_upload_conversion_fallback, {
				assetId: asset._id,
				eventId: args.eventId,
			});
			return null;
		}

		const response = await r2_fetch_object_from_bucket({ key: asset.r2Key });
		const rawBytes = await response.arrayBuffer();

		// Decode fatally: `response.text()` would turn invalid UTF-8 into U+FFFD silently and
		// store corrupted text as an editable document. Invalid bytes, and NUL bytes (valid UTF-8
		// but a UTF-16/binary tell), are content-deterministic failures — retrying cannot change
		// the bytes, so the upload stays a stored blob.
		let decodedText: string;
		try {
			decodedText = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
		} catch {
			await ctx.runMutation(internal.r2.settle_upload_conversion_fallback, {
				assetId: asset._id,
				eventId: args.eventId,
			});
			return null;
		}
		if (decodedText.includes("\u0000")) {
			await ctx.runMutation(internal.r2.settle_upload_conversion_fallback, {
				assetId: asset._id,
				eventId: args.eventId,
			});
			return null;
		}

		// At this producer boundary, drop a leading BOM and store LF before
		// the byte count and before both consumers below (the snapshot builder and the chunker),
		// so the document, the R2 snapshot, the chunks and the stored size all see one string.
		const text = files_normalize_text_document_input(decodedText);
		// Use the same deterministic fallback as the pre-download check when decoded text is over-cap.
		if (files_get_utf8_byte_size(text) > files_MAX_TEXT_CONTENT_BYTES) {
			await ctx.runMutation(internal.r2.settle_upload_conversion_fallback, {
				assetId: asset._id,
				eventId: args.eventId,
			});
			return null;
		}

		const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_text({
			text,
			rootKind,
		});
		// A refused document build is content-deterministic too: the same text refuses on
		// every retry, so the upload stays a stored blob.
		if (snapshotUpdate._nay) {
			console.error("Upload conversion could not build a document from the decoded text", {
				assetId: asset._id,
				nay: snapshotUpdate._nay,
			});
			await ctx.runMutation(internal.r2.settle_upload_conversion_fallback, {
				assetId: asset._id,
				eventId: args.eventId,
			});
			return null;
		}

		// Turn editable text uploads into editable files, so later reads treat them the same as
		// app-created files. Only the Yjs snapshot and the first version snapshot are created.
		// The node points at the version snapshot; the original upload asset stays unchanged as
		// the upload record.
		const [yjsSnapshotAssetId, versionSnapshotAssetId] = (await Promise.all([
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: fileNode.organizationId,
				workspaceId: fileNode.workspaceId,
				kind: "yjs_snapshot",
				size: snapshotUpdate._yay.byteLength,
				createdBy: fileNode.createdBy,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				organizationId: fileNode.organizationId,
				workspaceId: fileNode.workspaceId,
				kind: "content_snapshot",
				size: files_get_utf8_byte_size(text),
				createdBy: fileNode.createdBy,
			}),
		])) as [Id<"files_r2_assets">, Id<"files_r2_assets">];

		const yjsSnapshotR2Key = r2_create_asset_key({
			organizationId: fileNode.organizationId,
			workspaceId: fileNode.workspaceId,
			assetId: yjsSnapshotAssetId,
		});
		const versionSnapshotR2Key = r2_create_asset_key({
			organizationId: fileNode.organizationId,
			workspaceId: fileNode.workspaceId,
			assetId: versionSnapshotAssetId,
		});

		await Promise.all([
			r2_put_object(ctx, {
				key: yjsSnapshotR2Key,
				body: snapshotUpdate._yay,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: text,
				// The classifier over the node NAME, never `fileNode.contentType`: the stored type
				// is client input at upload time, and the snapshot signer serves whatever type
				// this object carries.
				contentType: classifierContentType,
			}),
		]);

		await ctx.runMutation(internal.r2.finalize_text_file_node_from_r2_assets, {
			organizationId: fileNode.organizationId,
			workspaceId: fileNode.workspaceId,
			fileNodeId: fileNode._id,
			path: fileNode.path,
			archiveOperationId: fileNode.archiveOperationId,
			userId: r2_require_real_author(fileNode.createdBy),
			rootKind,
			contentType: classifierContentType,
			yjsSnapshotAssetId,
			yjsSnapshotSize: snapshotUpdate._yay.byteLength,
			versionSnapshotAssetId,
			versionSnapshotSize: files_get_utf8_byte_size(text),
			text,
			processingWorkAssetIds: [asset._id],
		});

		return null;
	},
});

const upload_conversion_workpool = new Workpool(components.files_upload_conversion_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

export const process_uploaded_asset_event = internalMutation({
	args: {
		assetId: v.id("files_r2_assets"),
		r2Key: v.string(),
		uploadStagingR2Key: v.optional(v.string()),
		size: v.number(),
		etag: v.optional(v.string()),
		eventId: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const asset = await ctx.db.get("files_r2_assets", args.assetId);
		if (!asset) {
			const errorMessage = "args.assetId points to a missing files_r2_assets doc";
			const errorData = {
				assetId: args.assetId,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const fileNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_organization_workspace_asset", (q) =>
				q.eq("organizationId", asset.organizationId).eq("workspaceId", asset.workspaceId).eq("assetId", asset._id),
			)
			.first();

		const now = Date.now();
		const putMayArriveUntil =
			(asset.uploadUrlExpiresAt ?? asset.unfinalizedExpiresAt ?? now) + r2_PUT_MAY_ARRIVE_MARGIN_MS;

		// The final object already exists. A later event can only describe the temporary object. Update
		// only its cleanup job.
		if (asset.kind === "upload" && asset.r2Key !== undefined && args.uploadStagingR2Key !== undefined) {
			const publishedScope = r2_require_real_scope(asset.organizationId, asset.workspaceId);
			await r2_enqueue_object_deletion_job(ctx, {
				organizationId: publishedScope.organizationId,
				workspaceId: publishedScope.workspaceId,
				r2Key: args.uploadStagingR2Key,
				reason: "upload_staging",
				putMayArriveUntil,
				r2EventId: args.eventId,
			});
			return Result({ _yay: null });
		}

		// Creating the node and URL accepted this upload. A later lock does not stop it from finishing.
		await ctx.db.patch("files_r2_assets", asset._id, {
			r2Key: args.r2Key,
			size: args.size,
			...(args.etag === undefined ? {} : { etag: args.etag }),
			// Clear the deadline only when a node still uses this object. If the node is gone, cleanup
			// must still remove the unused R2 object.
			...(fileNode ? { unfinalizedExpiresAt: undefined } : {}),
			updatedAt: now,
		});
		if (args.uploadStagingR2Key !== undefined) {
			const publishedScope = r2_require_real_scope(asset.organizationId, asset.workspaceId);
			await r2_enqueue_object_deletion_job(ctx, {
				organizationId: publishedScope.organizationId,
				workspaceId: publishedScope.workspaceId,
				r2Key: args.uploadStagingR2Key,
				reason: "upload_staging",
				putMayArriveUntil,
				r2EventId: args.eventId,
			});
		}

		if (asset.kind !== "upload") {
			return Result({ _yay: null });
		}

		const shouldStartProcessing = asset.processingWorkId === undefined;
		if (!shouldStartProcessing) {
			return Result({ _yay: null });
		}
		if (!fileNode || fileNode.archiveOperationId !== undefined || files_node_has_editable_yjs_state(fileNode)) {
			await ctx.db.patch("files_r2_assets", asset._id, {
				processingWorkId: null,
				updatedAt: now,
			});
			return Result({ _yay: null });
		}

		// Route by the classifier over the node NAME, never by the client-declared contentType:
		// `.md` converts to a rich text document, the plain-text allow-list converts to `Y.Text`
		// documents, everything else stays a stored blob.
		const fileNodeIsEditableText = files_get_editable_text_yjs_root_kind(fileNode.name) !== null;

		try {
			if (fileNodeIsEditableText) {
				const workId = await upload_conversion_workpool.enqueueAction(ctx, internal.r2.finalize_uploaded_text_file, {
					organizationId: asset.organizationId,
					workspaceId: asset.workspaceId,
					assetId: asset._id,
					eventId: args.eventId,
				});

				await ctx.db.patch("files_r2_assets", asset._id, {
					processingWorkId: workId,
					updatedAt: now,
				});
				return Result({ _yay: null });
			}

			// No content conversion applies to this upload: its content is final as-is. Plugin runs
			// track their own progress on the run docs, never on the asset.
			await ctx.db.patch("files_r2_assets", asset._id, {
				processingWorkId: null,
				updatedAt: now,
			});
			await plugins_runtime_db_enqueue_upload_completed_runs(ctx, {
				// The local doc predates the r2Key/size patch above; hand the callee the patched shape.
				asset: { ...asset, r2Key: args.r2Key, size: args.size },
				fileNode,
				eventId: args.eventId,
			});
			return Result({ _yay: null });
		} catch (error) {
			console.error("Failed to enqueue R2 upload processing", {
				error,
				assetId: asset._id,
			});
			throw convex_error({
				message: "Failed to enqueue upload processing",
				cause: error,
			});
		}
	},
});

type process_uploaded_asset_event_Result =
	typeof process_uploaded_asset_event extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

/**
 * Finish an upload after a crash. The object may already be at the final key, or it may still be at
 * the temporary key. The hourly cleanup retries until the node uses the final object.
 */
export const recover_unfinalized_upload_publication = internalAction({
	args: {
		organizationId: v.id("organizations"),
		workspaceId: v.id("organizations_workspaces"),
		assetId: v.id("files_r2_assets"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const [asset, fileNode] = (await Promise.all([
			ctx.runQuery(internal.r2.get_asset_by_id, args),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, args),
		])) as [get_asset_by_id_Result, get_file_node_by_asset_id_Result];
		if (
			!asset ||
			!fileNode ||
			asset.kind !== "upload" ||
			asset.r2Key !== undefined ||
			asset.uploadStagingR2Key === undefined
		) {
			return null;
		}

		const liveR2Key = r2_create_asset_key({
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			assetId: args.assetId,
		});
		const copied = await r2_copy_object_to_immutable_key(ctx, {
			sourceKey: asset.uploadStagingR2Key,
			destinationKey: liveR2Key,
		});
		if (copied.outcome !== "ready") {
			return null;
		}

		(await ctx.runMutation(internal.r2.process_uploaded_asset_event, {
			assetId: asset._id,
			r2Key: liveR2Key,
			uploadStagingR2Key: asset.uploadStagingR2Key,
			size: copied.size,
			etag: copied.etag,
			eventId: `upload_recovery_${asset._id}`,
		})) as process_uploaded_asset_event_Result;
		return null;
	},
});

/**
 * A signed upload URL works for 15 minutes. Cleanup must wait until the URL expires.
 */
const UPLOAD_SIGNED_URL_TTL_MS = 15 * 60 * 1000;

/**
 * Handle an R2 event that arrives after its asset doc was deleted. Create a job to delete the R2
 * object that arrived late. Ignore keys from another app or bucket.
 */
export const record_untracked_asset_event = internalMutation({
	args: {
		bucket: v.string(),
		key: v.string(),
		eventId: v.string(),
	},
	returns: v.union(v.literal("recorded"), v.literal("ignored")),
	handler: async (ctx, args) => {
		if (args.bucket !== r2_get_bucket()) {
			return "ignored";
		}

		const match = /^organizations\/([^/]+)\/workspaces\/([^/]+)\/(assets|upload-staging)\/([^/]+)$/.exec(args.key);
		const [, organizationIdRaw, workspaceIdRaw, keyKind, assetIdRaw] = match ?? [];
		if (!organizationIdRaw || !workspaceIdRaw || !assetIdRaw) {
			return "ignored";
		}
		const organizationId = ctx.db.normalizeId("organizations", organizationIdRaw);
		const workspaceId = ctx.db.normalizeId("organizations_workspaces", workspaceIdRaw);
		const assetId = ctx.db.normalizeId("files_r2_assets", assetIdRaw);
		if (!organizationId || !workspaceId || !assetId) {
			return "ignored";
		}

		// Create a cleanup job only when the asset doc is gone.
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (asset) {
			return "ignored";
		}

		const now = Date.now();
		await r2_enqueue_object_deletion_job(ctx, {
			organizationId,
			workspaceId,
			r2Key: args.key,
			reason: "untracked_asset_event",
			// A signed URL can upload the temporary object again. Wait for the URL to expire. Users cannot
			// upload to the final key, so cleanup for that key does not wait.
			putMayArriveUntil:
				keyKind === "upload-staging" ? now + UPLOAD_SIGNED_URL_TTL_MS + r2_PUT_MAY_ARRIVE_MARGIN_MS : undefined,
			r2EventId: args.eventId,
		});
		return "recorded";
	},
});

type record_untracked_asset_event_Result =
	typeof record_untracked_asset_event extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

const UNFINALIZED_ASSET_CLEANUP_BATCH_SIZE = 50;

/** Wait seven days before checking an asset that is still used but missing its R2 object. */
const UNFINALIZED_ASSET_RECHECK_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Try to finish an incomplete upload again in one hour. */
const UNFINALIZED_UPLOAD_RECOVERY_RECHECK_DELAY_MS = 60 * 60 * 1000;

/**
 * Keep retrying an incomplete upload every hour for this long after the latest signed URL was
 * issued, then drop to the weekly recheck. The first deadline is already a day after the URL, so
 * this window has to be longer than that day or the hourly retry would never run even once.
 */
const UNFINALIZED_UPLOAD_RECOVERY_FAST_WINDOW_MS = 30 * 60 * 60 * 1000;

/** Stop automatic recovery eight days after the latest signed upload URL was issued. */
const UNFINALIZED_UPLOAD_RECOVERY_MAX_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Check unfinished assets after their deadline. Retry an upload when a node still uses the asset.
 * Keep any other asset used by a node or snapshot. Delete assets that nothing uses.
 */
export const cleanup_expired_unfinalized_assets = internalMutation({
	args: {
		_test_now: v.optional(v.number()),
		batchSize: v.optional(v.number()),
		_test_disableReschedule: v.optional(v.boolean()),
	},
	returns: v.object({
		deletedCount: v.number(),
		done: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const now = args._test_now ?? Date.now();
		const batchSize = Math.min(Math.max(args.batchSize ?? UNFINALIZED_ASSET_CLEANUP_BATCH_SIZE, 1), 100);
		// Read only positive deadlines. A missing deadline comes before every number. Without this
		// lower limit, finished assets could fill the page and hide unfinished assets.
		const expired = await ctx.db
			.query("files_r2_assets")
			.withIndex("by_unfinalizedExpiresAt", (q) => q.gt("unfinalizedExpiresAt", 0).lt("unfinalizedExpiresAt", now))
			.take(batchSize);

		let deletedCount = 0;
		for (const asset of expired) {
			const deterministicKey = r2_create_asset_key({
				organizationId: asset.organizationId,
				workspaceId: asset.workspaceId,
				assetId: asset._id,
			});
			const [referencingNode, referencingYjsSnapshot, referencingSnapshot] = await Promise.all([
				ctx.db
					.query("files_nodes")
					.withIndex("by_organization_workspace_asset", (q) =>
						q.eq("organizationId", asset.organizationId).eq("workspaceId", asset.workspaceId).eq("assetId", asset._id),
					)
					.first(),
				ctx.db
					.query("files_yjs_snapshots")
					.withIndex("by_asset", (q) => q.eq("assetId", asset._id))
					.first(),
				ctx.db
					.query("files_snapshots")
					.withIndex("by_asset", (q) => q.eq("assetId", asset._id))
					.first(),
			]);
			if (referencingNode || referencingYjsSnapshot || referencingSnapshot) {
				// Another doc uses this asset. If its R2 object exists, clear the old deadline. Never
				// delete an asset that is still used.
				if (asset.r2Key !== undefined) {
					await ctx.db.patch("files_r2_assets", asset._id, {
						unfinalizedExpiresAt: undefined,
						updatedAt: now,
					});
					continue;
				}

				if (referencingNode && asset.kind === "upload" && asset.uploadStagingR2Key !== undefined) {
					// Remint moves uploadUrlExpiresAt, so both retry windows start from the latest URL,
					// not from the asset's first creation.
					const recoveryStartedAt =
						asset.uploadUrlExpiresAt === undefined
							? asset._creationTime
							: asset.uploadUrlExpiresAt - UPLOAD_SIGNED_URL_TTL_MS;
					const recoveryScope = r2_require_real_scope(asset.organizationId, asset.workspaceId);
					if (now - recoveryStartedAt >= UNFINALIZED_UPLOAD_RECOVERY_MAX_WINDOW_MS) {
						// Keep a failed upload placeholder while the user has locked it. Recheck after the
						// lock may have changed instead of bypassing the file's current read-only state.
						if (files_node_require_writable(referencingNode)._nay) {
							await ctx.db.patch("files_r2_assets", asset._id, {
								unfinalizedExpiresAt: now + UNFINALIZED_ASSET_RECHECK_DELAY_MS,
								updatedAt: now,
							});
							continue;
						}
						const liveR2Key = r2_create_asset_key({
							organizationId: asset.organizationId,
							workspaceId: asset.workspaceId,
							assetId: asset._id,
						});
						await r2_enqueue_object_deletion_job(ctx, {
							organizationId: recoveryScope.organizationId,
							workspaceId: recoveryScope.workspaceId,
							r2Key: liveR2Key,
							reason: "untracked_asset_event",
						});
						await r2_enqueue_object_deletion_job(ctx, {
							organizationId: recoveryScope.organizationId,
							workspaceId: recoveryScope.workspaceId,
							r2Key: asset.uploadStagingR2Key,
							reason: "upload_staging",
							putMayArriveUntil:
								(asset.uploadUrlExpiresAt ?? recoveryStartedAt + UPLOAD_SIGNED_URL_TTL_MS) +
								r2_PUT_MAY_ARRIVE_MARGIN_MS,
						});
						await files_nodes_db_hard_delete_node(ctx, {
							organizationId: recoveryScope.organizationId,
							workspaceId: recoveryScope.workspaceId,
							nodeId: referencingNode._id,
						});
						// The hard-delete owns this file's asset. Keep this guard for a concurrent no-op.
						const assetAfter = await ctx.db.get("files_r2_assets", asset._id);
						if (assetAfter) {
							await ctx.db.delete("files_r2_assets", assetAfter._id);
						}
						deletedCount += 1;
						continue;
					}
					await ctx.scheduler.runAfter(0, internal.r2.recover_unfinalized_upload_publication, {
						organizationId: recoveryScope.organizationId,
						workspaceId: recoveryScope.workspaceId,
						assetId: asset._id,
					});
					// Slow old retries down. The terminal window above later removes the placeholder and
					// hands both possible keys to the durable deletion ledger.
					const recoveryDelay =
						now - recoveryStartedAt < UNFINALIZED_UPLOAD_RECOVERY_FAST_WINDOW_MS
							? UNFINALIZED_UPLOAD_RECOVERY_RECHECK_DELAY_MS
							: UNFINALIZED_ASSET_RECHECK_DELAY_MS;
					await ctx.db.patch("files_r2_assets", asset._id, {
						unfinalizedExpiresAt: now + recoveryDelay,
						updatedAt: now,
					});
					continue;
				}

				console.warn("Expired unfinalized asset is still referenced, skipping delete", {
					assetId: asset._id,
					kind: asset.kind,
					organizationId: asset.organizationId,
					workspaceId: asset.workspaceId,
				});
				await ctx.db.patch("files_r2_assets", asset._id, {
					unfinalizedExpiresAt: now + UNFINALIZED_ASSET_RECHECK_DELAY_MS,
					updatedAt: now,
				});
				continue;
			}

			// Nothing uses this asset. Create deletion jobs before deleting its doc because its R2
			// objects may still exist. Reserved workspaces use the old delete helper because jobs need real
			// organization and workspace ids.
			if (
				asset.organizationId === organizations_GLOBAL_ORGANIZATION_ID ||
				organizations_is_reserved_workspace_id(asset.workspaceId)
			) {
				await r2_delete_object(ctx, asset.r2Key ?? deterministicKey);
				if (asset.uploadStagingR2Key !== undefined) {
					await r2_delete_object(ctx, asset.uploadStagingR2Key);
				}
			} else {
				const cleanupKeys = new Set<string>([
					asset.r2Key ?? deterministicKey,
					...(asset.uploadStagingR2Key === undefined ? [] : [asset.uploadStagingR2Key]),
				]);
				for (const cleanupKey of cleanupKeys) {
					await r2_enqueue_object_deletion_job(ctx, {
						organizationId: asset.organizationId,
						workspaceId: asset.workspaceId,
						r2Key: cleanupKey,
						// A late R2 event updates this same job after the asset doc is gone.
						reason: "untracked_asset_event",
						// Wait only when a signed URL can still upload to this key. The final key can finish
						// cleanup after its first confirmed delete.
						putMayArriveUntil:
							cleanupKey === asset.uploadStagingR2Key
								? (asset.uploadUrlExpiresAt ?? asset.unfinalizedExpiresAt ?? now) + r2_PUT_MAY_ARRIVE_MARGIN_MS
								: asset.kind === "upload" && asset.uploadStagingR2Key === undefined
									? (asset.uploadUrlExpiresAt ?? asset.unfinalizedExpiresAt ?? now) + r2_PUT_MAY_ARRIVE_MARGIN_MS
									: undefined,
					});
				}
			}
			await ctx.db.delete("files_r2_assets", asset._id);
			deletedCount += 1;
		}

		const done = expired.length < batchSize;
		if (!done && !args._test_disableReschedule) {
			await ctx.scheduler.runAfter(0, internal.r2.cleanup_expired_unfinalized_assets, {
				batchSize: args.batchSize,
				_test_now: args._test_now,
			});
		}

		return { deletedCount, done };
	},
});

/**
 * Cloudflare R2 event notification payload.
 *
 * @see https://developers.cloudflare.com/r2/buckets/event-notifications/#message-format
 */
const event_body_validator = z.object({
	cloudflareMessageId: z.string(),
	attempts: z.number(),
	event: z.discriminatedUnion("action", [
		z.object({
			account: z.string().optional(),
			action: z.literal("PutObject"),
			bucket: z.string(),
			object: z.object({
				key: z.string(),
				size: z.number(),
				eTag: z.string().optional(),
			}),
			eventTime: z.string(),
		}),
		z.object({
			account: z.string().optional(),
			action: z.literal("CopyObject"),
			bucket: z.string(),
			object: z.object({
				key: z.string(),
				size: z.number(),
				eTag: z.string().optional(),
			}),
			eventTime: z.string(),
		}),
		z.object({
			account: z.string().optional(),
			action: z.literal("CompleteMultipartUpload"),
			bucket: z.string(),
			object: z.object({
				key: z.string(),
				size: z.number(),
				eTag: z.string().optional(),
			}),
			eventTime: z.string(),
		}),
		z.object({
			account: z.string().optional(),
			action: z.literal("DeleteObject"),
			bucket: z.string(),
			object: z.object({
				key: z.string(),
				size: z.undefined().optional(),
				eTag: z.undefined().optional(),
			}),
			eventTime: z.string(),
		}),
		z.object({
			account: z.string().optional(),
			action: z.literal("LifecycleDeletion"),
			bucket: z.string(),
			object: z.object({
				key: z.string(),
				size: z.undefined().optional(),
				eTag: z.undefined().optional(),
			}),
			eventTime: z.string(),
		}),
	]),
});

export type r2_http_event_Body = z.infer<typeof event_body_validator>;

export async function r2_http_event(ctx: ActionCtx, request: Request) {
	try {
		// Accept only the trusted Cloudflare event forwarder for R2 notifications.
		if (request.headers.get("Authorization") !== `Bearer ${CLOUDFLARE_EVENTS_SECRET}`) {
			return {
				status: 401,
				body: {
					message: "Unauthenticated",
				},
			} as const;
		}

		const body = await server_request_json_parse_and_validate(request, event_body_validator);
		if (body._nay) {
			return {
				status: 400,
				body: body._nay,
			} as const;
		}

		if (body._yay.event.action === "DeleteObject" || body._yay.event.action === "LifecycleDeletion") {
			return {
				status: 204,
				body: {},
			} as const;
		}

		const asset = (await ctx.runQuery(internal.r2.get_asset_by_r2_event_key, {
			bucket: body._yay.event.bucket,
			key: body._yay.event.object.key,
		})) as get_asset_by_r2_event_key_Result;
		if (asset._nay) {
			// The asset doc is gone, but its R2 object arrived late. Create a job to delete it.
			if (asset._nay.message === "Not found") {
				const recorded = (await ctx.runMutation(internal.r2.record_untracked_asset_event, {
					bucket: body._yay.event.bucket,
					key: body._yay.event.object.key,
					eventId: body._yay.cloudflareMessageId,
				})) as record_untracked_asset_event_Result;
				if (recorded === "recorded") {
					return {
						status: 204,
						body: {},
					} as const;
				}
			}
			return {
				status: asset._nay.message === "Not found" ? 404 : 503,
				body: {
					message: asset._nay.message,
				},
			} as const;
		}

		if (asset._yay.asset.kind !== "upload" || asset._yay.keyKind === "live") {
			// Ignore generated objects and events for a final upload key. Start work only for a user's
			// temporary upload object.
			return {
				status: 204,
				body: {},
			} as const;
		}

		const liveR2Key =
			asset._yay.keyKind === "upload_staging"
				? r2_create_asset_key({
						organizationId: asset._yay.asset.organizationId,
						workspaceId: asset._yay.asset.workspaceId,
						assetId: asset._yay.asset._id,
					})
				: body._yay.event.object.key;
		let publicationMetadata = {
			size: body._yay.event.object.size,
			etag: body._yay.event.object.eTag,
		};
		if (asset._yay.keyKind === "upload_staging" && asset._yay.asset.r2Key === undefined) {
			const copied = await r2_copy_object_to_immutable_key(ctx, {
				sourceKey: body._yay.event.object.key,
				destinationKey: liveR2Key,
				expectedSource: {
					size: body._yay.event.object.size,
					etag: body._yay.event.object.eTag,
				},
			});
			// The temporary object may change before an old event arrives. Publish only if the event still
			// describes the current object. Log the drop: this branch acks the queue message, so a
			// wrong non-ready outcome here silently loses the upload until the recovery pass.
			if (copied.outcome !== "ready") {
				console.warn("R2 staged copy did not publish", {
					outcome: copied.outcome,
					key: body._yay.event.object.key,
					size: body._yay.event.object.size,
					eTagPresent: body._yay.event.object.eTag !== undefined,
				});
				return {
					status: 204,
					body: {},
				} as const;
			}
			publicationMetadata = {
				size: copied.size,
				etag: copied.etag,
			};
		}

		await ctx.runMutation(internal.r2.process_uploaded_asset_event, {
			assetId: asset._yay.asset._id,
			r2Key: liveR2Key,
			uploadStagingR2Key: asset._yay.keyKind === "upload_staging" ? body._yay.event.object.key : undefined,
			size: publicationMetadata.size,
			etag: publicationMetadata.etag,
			eventId: body._yay.cloudflareMessageId,
		});

		// The database update ignores duplicate events and starts any needed upload work.
		return {
			status: 204,
			body: {},
		} as const;
	} catch (error: unknown) {
		console.error("R2 event HTTP route failed", { error });
		return {
			status: 500,
			body: {
				message: "Internal server error",
			},
		} as const;
	}
}
