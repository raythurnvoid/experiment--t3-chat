import { Workpool, vWorkId } from "@convex-dev/workpool";
import type { RegisteredMutation, RegisteredQuery, RouteSpec } from "convex/server";
import { v } from "convex/values";
import { R2 } from "@convex-dev/r2";
import { doc } from "convex-helpers/validators";
import { z } from "zod";
import { components, internal } from "./_generated/api.js";
import {
	action,
	httpAction,
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
import { Result } from "common/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import {
	organizations_GLOBAL_ORGANIZATION_ID,
	organizations_GLOBAL_GITHUB_WORKSPACE_ID,
	organizations_GLOBAL_PLUGINS_WORKSPACE_ID,
	organizations_is_reserved_workspace_id,
} from "../shared/organizations.ts";
import { users_SYSTEM_AUTHOR } from "../shared/users.ts";
import { organizations_db_get_membership } from "./organizations.ts";
import { plugins_runtime_db_enqueue_upload_completed_runs } from "./plugins_runtime.ts";
import {
	files_MAX_TEXT_CONTENT_BYTES,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
	type files_ContentType,
} from "../server/files.ts";
import app_convex_schema from "./schema.ts";
import type { RouterForConvexModules } from "./http.ts";
import { type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import { type api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import {
	db_insert_file_text_content,
	db_get_file_content_materialization_db_state,
	files_nodes_create_yjs_snapshot_update_from_markdown,
} from "./files_nodes.ts";

// Make Convex reuse the loaded module between calls, so warm calls skip the module load cost.
// Does NOT work for http actions (see http.ts). No mutable module-level state allowed here.
export const experimental_reuseContext = true;

if (!process.env.R2_BUCKET_FILES) {
	throw convex_error({ message: "R2_BUCKET_FILES is not set in Convex env" });
}

const R2_BUCKET_FILES = process.env.R2_BUCKET_FILES;

if (!process.env.R2_ENDPOINT) {
	throw convex_error({ message: "R2_ENDPOINT is not set in Convex env" });
}

const R2_ENDPOINT = process.env.R2_ENDPOINT;

if (!process.env.R2_ACCESS_KEY_ID) {
	throw convex_error({ message: "R2_ACCESS_KEY_ID is not set in Convex env" });
}

const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;

if (!process.env.R2_SECRET_ACCESS_KEY) {
	throw convex_error({ message: "R2_SECRET_ACCESS_KEY is not set in Convex env" });
}

const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;

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

const r2 = new R2(components.r2, {
	bucket: R2_BUCKET_FILES,
	endpoint: R2_ENDPOINT,
	accessKeyId: R2_ACCESS_KEY_ID,
	secretAccessKey: R2_SECRET_ACCESS_KEY,
});

export async function r2_get_download_url(args: {
	key: Parameters<typeof r2.getUrl>[0];
	options?: Parameters<typeof r2.getUrl>[1];
}) {
	return await r2.getUrl(args.key, {
		...args.options,
	});
}

export function r2_get_bucket() {
	return r2.config.bucket;
}

export async function r2_generate_upload_url(key: Parameters<typeof r2.generateUploadUrl>[0]) {
	return await r2.generateUploadUrl(key);
}

export function r2_create_asset_key(args: {
	organizationId: string;
	workspaceId: string;
	assetId: Id<"files_r2_assets">;
}) {
	return `organizations/${args.organizationId}/workspaces/${args.workspaceId}/assets/${args.assetId}`;
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
			...(args.r2Key === undefined ? {} : { r2Key: args.r2Key }),
			...(args.size === undefined ? {} : { size: args.size }),
			...(args.etag === undefined ? {} : { etag: args.etag }),
			...(args.processingWorkId === undefined ? {} : { processingWorkId: args.processingWorkId }),
			updatedAt: Date.now(),
		});

		return null;
	},
});

export async function r2_put_object(
	ctx: ActionCtx,
	args: {
		key: string;
		body: BodyInit;
		contentType?: string;
	},
) {
	// Use signed PUT instead of r2.store() so deterministic content keys remain idempotent across Workpool retries.
	const upload = await r2_generate_upload_url(args.key);
	const response = await fetch(upload.url, {
		method: "PUT",
		headers: args.contentType ? { "Content-Type": args.contentType } : undefined,
		body: args.body,
	});
	if (!response.ok) {
		throw convex_error({
			message: "Failed to write R2 object",
			cause: {
				status: response.status,
				key: args.key,
			},
		});
	}

	await r2.syncMetadata(ctx, args.key);
}

export async function r2_fetch_object_from_bucket(args: { key: string }) {
	const url = await r2_get_download_url({
		key: args.key,
		options: {
			expiresIn: 60,
		},
	});
	const response = await fetch(url);
	if (!response.ok) {
		throw convex_error({
			message: "Failed to read R2 object",
			cause: {
				status: response.status,
				key: args.key,
			},
		});
	}

	return response;
}

/**
 * Fetch a bounded byte range of an R2 object via an HTTP Range request (R2 honors it and
 * returns 206 Partial Content). Lets callers read a window of a large object instead of the
 * whole thing. `start`/`endInclusive` are 0-based byte offsets; the response may be shorter
 * than requested at end-of-object.
 */
export async function r2_fetch_object_range_from_bucket(args: { key: string; start: number; endInclusive: number }) {
	const url = await r2_get_download_url({
		key: args.key,
		options: {
			expiresIn: 60,
		},
	});
	const response = await fetch(url, {
		headers: { Range: `bytes=${args.start}-${args.endInclusive}` },
	});
	// 206 = partial content (range honored); 200 = full object (range ignored by store) — both usable.
	if (!response.ok && response.status !== 206) {
		throw convex_error({
			message: "Failed to read R2 object range",
			cause: {
				status: response.status,
				key: args.key,
				range: `bytes=${args.start}-${args.endInclusive}`,
			},
		});
	}

	return response;
}

export async function r2_delete_object(ctx: MutationCtx, key: string) {
	await r2.deleteObject(ctx, key);
}

export const get_asset_by_r2_event_key = internalQuery({
	args: {
		bucket: v.string(),
		key: v.string(),
	},
	returns: v_result({
		_yay: doc(app_convex_schema, "files_r2_assets"),
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

		return Result({ _yay: asset });
	},
});

type get_asset_by_r2_event_key_Result =
	typeof get_asset_by_r2_event_key extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

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
			!fileNode.assetId ||
			!fileNode.contentType
		) {
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
				const materialized = await ctx.runAction(internal.files_nodes.materialize_file_content, {
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
				if (refreshed) {
					asset = refreshed.asset;
				}
			}
		}

		if (!asset.r2Key) {
			return Result({ _nay: { message: "Not found" } });
		}

		const url = await r2_get_download_url({
			key: asset.r2Key,
			options: {
				// 15 minutes.
				expiresIn: 15 * 60,
			},
		});

		return Result({ _yay: { url } });
	},
});

export const get_asset = query({
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
			!fileNode.assetId
		) {
			return null;
		}

		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		if (!asset || asset.organizationId !== fileNode.organizationId || asset.workspaceId !== fileNode.workspaceId) {
			return null;
		}

		return asset;
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

async function db_finalize_markdown_file_node_from_r2_assets(
	ctx: MutationCtx,
	args: {
		organizationId: Id<"organizations">;
		workspaceId: Id<"organizations_workspaces">;
		fileNodeId: Id<"files_nodes">;
		path: Doc<"files_nodes">["path"];
		archiveOperationId?: Doc<"files_nodes">["archiveOperationId"];
		userId: Id<"users">;
		yjsSnapshotAssetId: Id<"files_r2_assets">;
		yjsSnapshotSize: number;
		versionSnapshotAssetId: Id<"files_r2_assets">;
		versionSnapshotSize: number;
		markdownContent: string;
		/**
		 * Assets that share this conversion job and should become terminal
		 * when the file is published.
		 */
		processingWorkAssetIds: Array<Id<"files_r2_assets">>;
		now: number;
	},
) {
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
		}),
		db_insert_file_text_content(ctx, {
			organizationId: args.organizationId,
			workspaceId: args.workspaceId,
			nodeId: args.fileNodeId,
			path: args.path,
			archiveOperationId: args.archiveOperationId,
			yjsSequence: 0,
			contentType: "text/markdown;charset=utf-8",
			textContent: args.markdownContent,
		}).then((chunks) => {
			if (chunks._nay) {
				throw convex_error({
					message: "Failed to chunk Markdown file",
					cause: chunks._nay,
				});
			}
			return chunks;
		}),
	] as const).catch((error) => {
		const errorMessage = "Failed to finalize Markdown file node";
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
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			yjsSnapshotId,
			yjsLastSequenceId,
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
			updatedAt: args.now,
		}),
		ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				organizationId: args.organizationId,
				workspaceId: args.workspaceId,
				assetId: args.versionSnapshotAssetId,
			}),
			size: args.versionSnapshotSize,
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

export const finalize_markdown_file_node_from_r2_assets = internalMutation({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		fileNodeId: v.id("files_nodes"),
		path: doc(app_convex_schema, "files_nodes").fields.path,
		archiveOperationId: doc(app_convex_schema, "files_nodes").fields.archiveOperationId,
		userId: v.id("users"),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		yjsSnapshotSize: v.number(),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		versionSnapshotSize: v.number(),
		markdownContent: v.string(),
		processingWorkAssetIds: v.array(v.id("files_r2_assets")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const now = Date.now();
		const finalizeScope = r2_require_real_scope(args.organizationId, args.workspaceId);
		return await db_finalize_markdown_file_node_from_r2_assets(ctx, {
			...args,
			organizationId: finalizeScope.organizationId,
			workspaceId: finalizeScope.workspaceId,
			now,
		});
	},
});

type finalize_markdown_file_node_from_r2_assets_Result =
	typeof finalize_markdown_file_node_from_r2_assets extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

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

export const finalize_uploaded_markdown_file = internalAction({
	args: {
		organizationId: doc(app_convex_schema, "files_nodes").fields.organizationId,
		workspaceId: doc(app_convex_schema, "files_nodes").fields.workspaceId,
		assetId: v.id("files_r2_assets"),
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

		if (!fileNode) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: asset._id,
				processingWorkId: null,
			});
			return null;
		}
		if (!fileNode.contentType?.startsWith("text/markdown" satisfies files_ContentType)) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: asset._id,
				processingWorkId: null,
			});
			return null;
		}
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

		const response = await r2_fetch_object_from_bucket({ key: asset.r2Key });
		const markdownContent = await response.text();
		if (files_get_utf8_byte_size(markdownContent) > files_MAX_TEXT_CONTENT_BYTES) {
			// Treat over-limit Markdown uploads as processed stored files; retrying cannot make the content smaller.
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: asset._id,
				processingWorkId: null,
			});
			return null;
		}

		const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_markdown(markdownContent);
		if (snapshotUpdate._nay) {
			throw convex_error({
				message: "Failed to create uploaded Markdown snapshot",
				cause: snapshotUpdate._nay,
			});
		}

		// Turn Markdown uploads into editable files, so later reads treat them the same as
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
				size: files_get_utf8_byte_size(markdownContent),
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
				body: markdownContent,
				contentType: fileNode.contentType,
			}),
		]);

		const finalized = (await ctx.runMutation(internal.r2.finalize_markdown_file_node_from_r2_assets, {
			organizationId: fileNode.organizationId,
			workspaceId: fileNode.workspaceId,
			fileNodeId: fileNode._id,
			path: fileNode.path,
			archiveOperationId: fileNode.archiveOperationId,
			userId: r2_require_real_author(fileNode.createdBy),
			yjsSnapshotAssetId,
			yjsSnapshotSize: snapshotUpdate._yay.byteLength,
			versionSnapshotAssetId,
			versionSnapshotSize: files_get_utf8_byte_size(markdownContent),
			markdownContent,
			processingWorkAssetIds: [asset._id],
		})) as finalize_markdown_file_node_from_r2_assets_Result;
		if (finalized._nay) {
			throw convex_error({
				message: "Failed to finalize uploaded Markdown file",
				cause: finalized._nay,
			});
		}

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
		await ctx.db.patch("files_r2_assets", asset._id, {
			r2Key: args.r2Key,
			size: args.size,
			...(args.etag === undefined ? {} : { etag: args.etag }),
			updatedAt: now,
		});

		if (asset.kind !== "upload") {
			return Result({ _yay: null });
		}

		const shouldStartProcessing = asset.processingWorkId === undefined;
		if (!shouldStartProcessing) {
			return Result({ _yay: null });
		}
		if (
			!fileNode ||
			fileNode.archiveOperationId !== undefined ||
			files_node_has_editable_yjs_state(fileNode)
		) {
			await ctx.db.patch("files_r2_assets", asset._id, {
				processingWorkId: null,
				updatedAt: now,
			});
			return Result({ _yay: null });
		}

		const fileNodeIsMarkdown =
			fileNode.contentType?.startsWith("text/markdown" satisfies files_ContentType) ?? false;

		try {
			if (fileNodeIsMarkdown) {
				const workId = await upload_conversion_workpool.enqueueAction(
					ctx,
					internal.r2.finalize_uploaded_markdown_file,
					{
						organizationId: asset.organizationId,
						workspaceId: asset.workspaceId,
						assetId: asset._id,
					},
				);

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

export function r2_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path = "/api/r2/event" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						/**
						 * Cloudflare R2 event notification payload.
						 *
						 * @see https://developers.cloudflare.com/r2/buckets/event-notifications/#message-format
						 */
						const bodyValidator = z.object({
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

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
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

								const body = await server_request_json_parse_and_validate(request, bodyValidator);
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
									return {
										status: asset._nay.message === "Not found" ? 404 : 503,
										body: {
											message: asset._nay.message,
										},
									} as const;
								}

								if (asset._yay.kind !== "upload") {
									// The finalizer is upload-oriented. Generated objects are written by Convex actions.
									return {
										status: 204,
										body: {},
									} as const;
								}

								await ctx.runMutation(internal.r2.process_uploaded_asset_event, {
									assetId: asset._yay._id,
									r2Key: body._yay.event.object.key,
									size: body._yay.event.object.size,
									etag: body._yay.event.object.eTag,
									eventId: body._yay.cloudflareMessageId,
								});

								// The mutation owns idempotency and enqueues any needed upload work.
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
						};

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const result = await handler(ctx, request);

								if (result.status === 204) {
									return new Response(null, { status: result.status });
								}

								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof handler>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
