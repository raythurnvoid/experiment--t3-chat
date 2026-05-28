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
import type { Id } from "./_generated/dataModel.js";
import {
	json_parse_and_validate,
	server_convex_get_user_fallback_to_anonymous,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { workspaces_db_get_membership } from "./workspaces.ts";
import {
	files_MAX_MARKDOWN_CHARACTERS,
	files_MAX_UPLOADS_BYTES,
	files_ROOT_ID,
	files_get_utf8_byte_size,
	files_node_has_editable_yjs_state,
	type files_ContentType,
} from "../server/files.ts";
import app_convex_schema from "./schema.ts";
import type { RouterForConvexModules } from "./http.ts";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";
import {
	db_insert_file_chunks,
	db_get_file_content_materialization_db_state,
	files_nodes_create_yjs_snapshot_update_from_markdown,
	files_nodes_db_create_node_recursively_at_path,
} from "./files_nodes.ts";

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

if (!process.env.MODAL_FILE_CONVERTER_URL) {
	throw convex_error({ message: "MODAL_FILE_CONVERTER_URL is not set in Convex env" });
}

const MODAL_FILE_CONVERTER_URL = process.env.MODAL_FILE_CONVERTER_URL;

if (!process.env.MODAL_TOKEN) {
	throw convex_error({ message: "MODAL_TOKEN is not set in Convex env" });
}

const MODAL_TOKEN = process.env.MODAL_TOKEN;

function generated_markdown_file_node_name(filename: string) {
	return `${filename}.md`;
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

export function r2_create_asset_key(args: { workspaceId: string; projectId: string; assetId: Id<"files_r2_assets"> }) {
	return `workspaces/${args.workspaceId}/projects/${args.projectId}/assets/${args.assetId}`;
}

function extract_asset_id_from_r2_key(key: string) {
	const assetId = key.split("/").at(-1);

	return assetId || null;
}

export const insert_asset = internalMutation({
	args: {
		workspaceId: doc(app_convex_schema, "files_r2_assets").fields.workspaceId,
		projectId: doc(app_convex_schema, "files_r2_assets").fields.projectId,
		kind: doc(app_convex_schema, "files_r2_assets").fields.kind,
		size: doc(app_convex_schema, "files_r2_assets").fields.size,
		createdBy: doc(app_convex_schema, "files_r2_assets").fields.createdBy,
	},
	returns: v.id("files_r2_assets"),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await ctx.db.insert("files_r2_assets", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
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
		size: doc(app_convex_schema, "files_r2_assets").fields.size,
		etag: doc(app_convex_schema, "files_r2_assets").fields.etag,
		conversionWorkId: v.optional(v.union(vWorkId, v.null())),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch("files_r2_assets", args.assetId, {
			...(args.r2Key === undefined ? {} : { r2Key: args.r2Key }),
			...(args.size === undefined ? {} : { size: args.size }),
			...(args.etag === undefined ? {} : { etag: args.etag }),
			...(args.conversionWorkId === undefined ? {} : { conversionWorkId: args.conversionWorkId }),
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
		workspaceId: v.string(),
		projectId: v.string(),
		assetId: v.id("files_r2_assets"),
	},
	returns: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
	handler: async (ctx, args) => {
		const asset = await ctx.db.get("files_r2_assets", args.assetId);
		if (!asset || asset.workspaceId !== args.workspaceId || asset.projectId !== args.projectId) {
			return null;
		}

		return asset;
	},
});

type get_asset_by_id_Result =
	typeof get_asset_by_id extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_data_for_create_signed_download_url = internalQuery({
	args: {
		userId: v.id("users"),
		membershipId: v.id("workspaces_projects_users"),
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
		const membership = await workspaces_db_get_membership(ctx, {
			userId: args.userId,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (
			!fileNode ||
			fileNode.workspaceId !== membership.workspaceId ||
			fileNode.projectId !== membership.projectId ||
			!fileNode.assetId ||
			!fileNode.contentType
		) {
			return null;
		}

		const assetId = fileNode.assetId;
		const asset = await ctx.db.get("files_r2_assets", assetId);
		if (!asset || asset.workspaceId !== fileNode.workspaceId || asset.projectId !== fileNode.projectId) {
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
						workspaceId: fileNode.workspaceId,
						projectId: fileNode.projectId,
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
 * Return a signed R2 URL for download.
 *
 * For Markdown files, ensure the R2 snapshot is up to date before returning the URL.
 */
export const create_signed_download_url = action({
	args: {
		membershipId: v.id("workspaces_projects_users"),
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

		const { fileNode, asset, materializationState } = data;
		if (!fileNode.contentType) {
			return Result({ _nay: { message: "Not found" } });
		}

		if (files_node_has_editable_yjs_state(fileNode)) {
			if (!fileNode.yjsSnapshotId || !fileNode.yjsLastSequenceId) {
				console.warn("Markdown file is missing Yjs pointers", {
					fileNodeId: fileNode._id,
					yjsSnapshotId: fileNode.yjsSnapshotId,
					yjsLastSequenceId: fileNode.yjsLastSequenceId,
				});
			} else if (!materializationState) {
				console.warn("Markdown file materialization state is missing", {
					fileNodeId: fileNode._id,
					yjsSnapshotId: fileNode.yjsSnapshotId,
					yjsLastSequenceId: fileNode.yjsLastSequenceId,
				});
			} else if (materializationState.yjsLastSequenceDoc.lastSequence > materializationState.yjsSnapshotDoc.sequence) {
				// Try to update the committed Markdown asset, but still allow downloading the current R2 asset if this fails.
				const materialized = await ctx.runAction(internal.files_nodes.materialize_file_content, {
					workspaceId: fileNode.workspaceId,
					projectId: fileNode.projectId,
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
		membershipId: v.id("workspaces_projects_users"),
		fileNodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
	handler: async (ctx, args) => {
		const userAuth = await server_convex_get_user_fallback_to_anonymous(ctx);
		if (!userAuth) {
			return null;
		}

		const membership = await workspaces_db_get_membership(ctx, {
			userId: userAuth.id,
			membershipId: args.membershipId,
		});
		if (!membership) {
			return null;
		}

		const fileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (
			!fileNode ||
			fileNode.workspaceId !== membership.workspaceId ||
			fileNode.projectId !== membership.projectId ||
			!fileNode.assetId
		) {
			return null;
		}

		const asset = await ctx.db.get("files_r2_assets", fileNode.assetId);
		if (!asset || asset.workspaceId !== fileNode.workspaceId || asset.projectId !== fileNode.projectId) {
			return null;
		}

		return asset;
	},
});

export const get_file_node_by_asset_id = internalQuery({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		assetId: v.id("files_r2_assets"),
	},
	returns: v.union(doc(app_convex_schema, "files_nodes"), v.null()),
	handler: async (ctx, args) => {
		return await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_asset", (q) =>
				q.eq("workspaceId", args.workspaceId).eq("projectId", args.projectId).eq("assetId", args.assetId),
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
		workspaceId: string;
		projectId: string;
		fileNodeId: Id<"files_nodes">;
		userId: Id<"users">;
		markdownAssetId: Id<"files_r2_assets">;
		markdownSize: number;
		yjsSnapshotAssetId: Id<"files_r2_assets">;
		yjsSnapshotSize: number;
		versionSnapshotAssetId: Id<"files_r2_assets">;
		versionSnapshotSize: number;
		markdownContent: string;
		/**
		 * Assets that share this conversion job and should become terminal
		 * when the file is published.
		 */
		conversionWorkAssetIds: Array<Id<"files_r2_assets">>;
		now: number;
	},
) {
	// Create editable Yjs metadata for an existing node whose R2 objects were
	// already written by the caller.
	const [yjsSnapshotId, yjsLastSequenceId] = await Promise.all([
		ctx.db.insert("files_yjs_snapshots", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.fileNodeId,
			sequence: 0,
			assetId: args.yjsSnapshotAssetId,
			createdBy: args.userId,
			updatedBy: args.userId,
			updatedAt: args.now,
		}),
		ctx.db.insert("files_yjs_docs_last_sequences", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.fileNodeId,
			lastSequence: 0,
		}),
		db_insert_file_chunks(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.fileNodeId,
			yjsSequence: 0,
			markdownContent: args.markdownContent,
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
	// this Workpool job.
	await Promise.all([
		ctx.db.patch("files_nodes", args.fileNodeId, {
			assetId: args.markdownAssetId,
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			yjsSnapshotId,
			yjsLastSequenceId,
			updatedBy: args.userId,
			updatedAt: args.now,
		}),
		ctx.db.patch("files_r2_assets", args.markdownAssetId, {
			r2Key: r2_create_asset_key({
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				assetId: args.markdownAssetId,
			}),
			size: args.markdownSize,
			...(args.conversionWorkAssetIds.includes(args.markdownAssetId) ? { conversionWorkId: null } : {}),
			updatedAt: args.now,
		}),
		ctx.db.patch("files_r2_assets", args.yjsSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				assetId: args.yjsSnapshotAssetId,
			}),
			size: args.yjsSnapshotSize,
			updatedAt: args.now,
		}),
		ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
			r2Key: r2_create_asset_key({
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				assetId: args.versionSnapshotAssetId,
			}),
			size: args.versionSnapshotSize,
			updatedAt: args.now,
		}),
		...args.conversionWorkAssetIds
			.filter((assetId) => assetId !== args.markdownAssetId)
			.map((assetId) =>
				ctx.db.patch("files_r2_assets", assetId, {
					conversionWorkId: null,
					updatedAt: args.now,
				}),
			),
		ctx.db.insert("files_snapshots", {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: args.fileNodeId,
			assetId: args.versionSnapshotAssetId,
			createdBy: args.userId,
			archivedAt: -1,
		}),
	]);

	return Result({ _yay: null });
}

/**
 * Finish an upload conversion after the converted R2 objects are written.
 *
 * Patch the pre-created generated Markdown node into an editable file and clear
 * the conversion job in one mutation.
 */
export const finalize_upload_conversion_to_markdown = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		/** The original uploaded file node, such as the source PDF being converted. */
		fileNodeId: v.id("files_nodes"),
		uploadAssetId: v.id("files_r2_assets"),
		output: v.object({
			/** The generated Markdown file node that becomes the editable conversion output. */
			fileNodeId: v.id("files_nodes"),
			markdownContent: v.string(),
			markdownAssetId: v.id("files_r2_assets"),
			markdownSize: v.number(),
			yjsSnapshotAssetId: v.id("files_r2_assets"),
			yjsSnapshotSize: v.number(),
			versionSnapshotAssetId: v.id("files_r2_assets"),
			versionSnapshotSize: v.number(),
		}),
	},
	returns: v_result({
		_yay: v.object({
			fileNodeId: v.id("files_nodes"),
		}),
	}),
	handler: async (ctx, args) => {
		const now = Date.now();
		const sourceFileNode = await ctx.db.get("files_nodes", args.fileNodeId);
		if (
			!sourceFileNode ||
			sourceFileNode.workspaceId !== args.workspaceId ||
			sourceFileNode.projectId !== args.projectId
		) {
			return Result({ _nay: { name: "nay", message: "Not found" } });
		}

		const output = args.output;
		const outputFileNode = await ctx.db.get("files_nodes", output.fileNodeId);
		if (
			!outputFileNode ||
			outputFileNode.workspaceId !== args.workspaceId ||
			outputFileNode.projectId !== args.projectId ||
			outputFileNode.kind !== "file" ||
			outputFileNode.assetId !== output.markdownAssetId
		) {
			return Result({ _nay: { name: "nay", message: "Not found" } });
		}

		const finalized = await db_finalize_markdown_file_node_from_r2_assets(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			fileNodeId: output.fileNodeId,
			userId: args.userId,
			markdownAssetId: output.markdownAssetId,
			markdownSize: output.markdownSize,
			yjsSnapshotAssetId: output.yjsSnapshotAssetId,
			yjsSnapshotSize: output.yjsSnapshotSize,
			versionSnapshotAssetId: output.versionSnapshotAssetId,
			versionSnapshotSize: output.versionSnapshotSize,
			markdownContent: output.markdownContent,
			conversionWorkAssetIds: [args.uploadAssetId, output.markdownAssetId],
			now,
		});
		if (finalized._nay) {
			return finalized;
		}

		return Result({ _yay: { fileNodeId: output.fileNodeId } });
	},
});

type finalize_upload_conversion_to_markdown_Result =
	typeof finalize_upload_conversion_to_markdown extends RegisteredMutation<
		infer _Visibility,
		infer _Args,
		infer ReturnValue
	>
		? Awaited<ReturnValue>
		: never;

export const convert_upload_to_markdown = internalAction({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		sourceAssetId: v.id("files_r2_assets"),
		/**
		 * Pre-created generated Markdown asset; resolve the node by asset so
		 * moves/renames do not break finalization.
		 */
		outputAssetId: v.id("files_r2_assets"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const [sourceAsset, sourceFileNode, convertedOutputFileNode] = (await Promise.all([
			ctx.runQuery(internal.r2.get_asset_by_id, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				assetId: args.sourceAssetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				assetId: args.sourceAssetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				assetId: args.outputAssetId,
			}),
		])) as [get_asset_by_id_Result, get_file_node_by_asset_id_Result, get_file_node_by_asset_id_Result];
		if (!sourceAsset) {
			return null;
		}
		if (!sourceFileNode) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}
		if (files_node_has_editable_yjs_state(sourceFileNode)) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}
		if (!convertedOutputFileNode || convertedOutputFileNode.kind !== "file") {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}

		// Give Modal a signed read URL so conversion does not proxy file bytes through Convex.
		// Trust the R2 event finalizer: it patches r2Key before enqueueing conversion work.
		const sourceR2Key = sourceAsset.r2Key!;
		const sourceUrl = await r2_get_download_url({
			key: sourceR2Key,
			options: {
				// Keep the signed URL short-lived; the Workpool job uses it immediately.
				expiresIn: 15 * 60,
			},
		});

		// Ask the converter for Markdown while passing the same limits enforced by the app.
		let conversionResponse: Response;
		try {
			conversionResponse = await fetch(MODAL_FILE_CONVERTER_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${MODAL_TOKEN}`,
				},
				body: JSON.stringify({
					sourceUrl,
					filename: sourceFileNode.name,
					contentType: sourceFileNode.contentType,
					maxBytes: files_MAX_UPLOADS_BYTES,
					maxMarkdownCharacters: files_MAX_MARKDOWN_CHARACTERS,
				}),
			});
		} catch (error) {
			console.error("Failed to call Modal file converter", { error, key: sourceR2Key });
			throw convex_error({
				message: "Failed to convert uploaded file",
				cause: {
					message: "Failed to call Modal file converter",
				},
			});
		}

		const conversionResponseBody = await conversionResponse.text();
		if (!conversionResponse.ok) {
			if (conversionResponse.status === 413 || conversionResponse.status === 422) {
				// Modal reached a deterministic no-Markdown outcome; leave generated placeholders terminal.
				await Promise.all([
					ctx.runMutation(internal.r2.patch_asset, {
						assetId: sourceAsset._id,
						conversionWorkId: null,
					}),
					ctx.runMutation(internal.r2.patch_asset, {
						assetId: args.outputAssetId,
						conversionWorkId: null,
					}),
				]);
				return null;
			}

			console.error("Modal file converter returned an error", {
				status: conversionResponse.status,
				body: conversionResponseBody.slice(0, 1_000),
				key: sourceR2Key,
			});
			throw convex_error({
				message: "Failed to convert uploaded file",
				cause: {
					message: "Modal file converter failed",
					status: conversionResponse.status,
				},
			});
		}

		// Validate the external payload before using it to create app-owned file data.
		const conversionPayload = json_parse_and_validate(
			conversionResponseBody,
			z.object({
				markdown: z.string(),
				converter: z.string(),
			}),
		);
		if (conversionPayload._nay) {
			console.error("Modal file converter returned an invalid payload", {
				error: conversionPayload._nay,
				key: sourceR2Key,
			});
			throw convex_error({
				message: "Failed to convert uploaded file",
				cause: conversionPayload._nay,
			});
		}

		// Keep converted Markdown within the same product limit as first-party Markdown content.
		if (conversionPayload._yay.markdown.length > files_MAX_MARKDOWN_CHARACTERS) {
			throw convex_error({
				message: "Failed to convert uploaded file",
				cause: {
					message: "Converted markdown is too large",
				},
			});
		}

		// Build the editable Markdown state from Modal output, but do not publish
		// DB pointers until all R2 writes succeed.
		const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_markdown(conversionPayload._yay.markdown);
		if (snapshotUpdate._nay) {
			throw convex_error({
				message: "Failed to create uploaded file conversion snapshot",
				cause: snapshotUpdate._nay,
			});
		}

		const markdownSize = files_get_utf8_byte_size(conversionPayload._yay.markdown);
		const markdownAssetId = args.outputAssetId;
		const [yjsSnapshotAssetId, versionSnapshotAssetId] = await Promise.all([
			ctx.runMutation(internal.r2.insert_asset, {
				workspaceId: sourceFileNode.workspaceId,
				projectId: sourceFileNode.projectId,
				kind: "yjs_snapshot",
				size: snapshotUpdate._yay.byteLength,
				createdBy: sourceFileNode.createdBy,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				workspaceId: sourceFileNode.workspaceId,
				projectId: sourceFileNode.projectId,
				kind: "content_snapshot",
				size: markdownSize,
				createdBy: sourceFileNode.createdBy,
			}),
		]);

		const markdownR2Key = r2_create_asset_key({
			workspaceId: sourceFileNode.workspaceId,
			projectId: sourceFileNode.projectId,
			assetId: markdownAssetId,
		});
		const yjsSnapshotR2Key = r2_create_asset_key({
			workspaceId: sourceFileNode.workspaceId,
			projectId: sourceFileNode.projectId,
			assetId: yjsSnapshotAssetId,
		});
		const versionSnapshotR2Key = r2_create_asset_key({
			workspaceId: sourceFileNode.workspaceId,
			projectId: sourceFileNode.projectId,
			assetId: versionSnapshotAssetId,
		});

		// Write the R2 objects before the finalizing mutation publishes DB pointers to them.
		await Promise.all([
			r2_put_object(ctx, {
				key: markdownR2Key,
				body: conversionPayload._yay.markdown,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: yjsSnapshotR2Key,
				body: snapshotUpdate._yay,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: conversionPayload._yay.markdown,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);

		const finalizedConversion = (await ctx.runMutation(internal.r2.finalize_upload_conversion_to_markdown, {
			workspaceId: sourceFileNode.workspaceId,
			projectId: sourceFileNode.projectId,
			userId: sourceFileNode.createdBy,
			fileNodeId: sourceFileNode._id,
			uploadAssetId: sourceAsset._id,
			output: {
				fileNodeId: convertedOutputFileNode._id,
				markdownContent: conversionPayload._yay.markdown,
				markdownAssetId,
				markdownSize,
				yjsSnapshotAssetId,
				yjsSnapshotSize: snapshotUpdate._yay.byteLength,
				versionSnapshotAssetId,
				versionSnapshotSize: markdownSize,
			},
		})) as finalize_upload_conversion_to_markdown_Result;
		if (finalizedConversion._nay) {
			throw convex_error({
				message: "Failed to finalize uploaded file",
				cause: finalizedConversion._nay,
			});
		}

		return null;
	},
});

export const finalize_markdown_file_node_from_r2_assets = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		fileNodeId: v.id("files_nodes"),
		userId: v.id("users"),
		markdownAssetId: v.id("files_r2_assets"),
		markdownSize: v.number(),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		yjsSnapshotSize: v.number(),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		versionSnapshotSize: v.number(),
		markdownContent: v.string(),
		conversionWorkAssetIds: v.array(v.id("files_r2_assets")),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const now = Date.now();
		return await db_finalize_markdown_file_node_from_r2_assets(ctx, { ...args, now });
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

async function archive_active_node_and_descendants(
	ctx: MutationCtx,
	args: {
		node: {
			_id: Id<"files_nodes">;
			workspaceId: string;
			projectId: string;
			path: string;
		};
		updatedBy: Id<"users">;
		now: number;
	},
) {
	const archiveOperationId = crypto.randomUUID();
	const descendantsPathPrefix = `${args.node.path}/`;
	// Archive existing descendants with a range query so a generated output can
	// take over the active name atomically.
	const descendants = await ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_path_archiveOperation", (q) =>
			q
				.eq("workspaceId", args.node.workspaceId)
				.eq("projectId", args.node.projectId)
				.gte("path", descendantsPathPrefix)
				.lt("path", `${descendantsPathPrefix}\uffff`),
		)
		.collect();

	await Promise.all([
		ctx.db.patch("files_nodes", args.node._id, {
			archiveOperationId,
			updatedBy: args.updatedBy,
			updatedAt: args.now,
		}),
		...descendants
			.filter((descendant) => descendant.archiveOperationId === undefined)
			.map((descendant) =>
				ctx.db.patch("files_nodes", descendant._id, {
					archiveOperationId,
					updatedBy: args.updatedBy,
					updatedAt: args.now,
				}),
			),
	]);
}

async function create_generated_markdown_output_node(
	ctx: MutationCtx,
	args: {
		sourceFileNode: {
			workspaceId: string;
			projectId: string;
			parentId: Id<"files_nodes"> | typeof files_ROOT_ID;
			createdBy: Id<"users">;
		};
		name: string;
		now: number;
	},
) {
	// Expose the generated output as a normal file immediately; finalization
	// later fills in its R2 key and Yjs state.
	const activeNameConflict = await ctx.db
		.query("files_nodes")
		.withIndex("by_workspace_project_parent_name_archiveOperation", (q) =>
			q
				.eq("workspaceId", args.sourceFileNode.workspaceId)
				.eq("projectId", args.sourceFileNode.projectId)
				.eq("parentId", args.sourceFileNode.parentId)
				.eq("name", args.name)
				.eq("archiveOperationId", undefined),
		)
		.first();
	if (activeNameConflict) {
		await archive_active_node_and_descendants(ctx, {
			node: activeNameConflict,
			updatedBy: args.sourceFileNode.createdBy,
			now: args.now,
		});
	}

	const assetId = await ctx.db.insert("files_r2_assets", {
		workspaceId: args.sourceFileNode.workspaceId,
		projectId: args.sourceFileNode.projectId,
		kind: "content",
		r2Bucket: r2_get_bucket(),
		createdBy: args.sourceFileNode.createdBy,
		updatedAt: args.now,
	});

	const node = await files_nodes_db_create_node_recursively_at_path(ctx, {
		userId: args.sourceFileNode.createdBy,
		workspaceId: args.sourceFileNode.workspaceId,
		projectId: args.sourceFileNode.projectId,
		parentId: args.sourceFileNode.parentId,
		path: args.name,
		kind: "file",
		contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
		assetId,
		now: args.now,
	});
	if (node._nay) {
		return node;
	}

	return Result({ _yay: { nodeId: node._yay, assetId } });
}

export const finalize_uploaded_markdown_file = internalAction({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		sourceAssetId: v.id("files_r2_assets"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const [sourceAsset, sourceFileNode] = (await Promise.all([
			ctx.runQuery(internal.r2.get_asset_by_id, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				assetId: args.sourceAssetId,
			}),
			ctx.runQuery(internal.r2.get_file_node_by_asset_id, {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				assetId: args.sourceAssetId,
			}),
		])) as [get_asset_by_id_Result, get_file_node_by_asset_id_Result];
		if (!sourceAsset) {
			return null;
		}

		if (!sourceFileNode) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}
		if (!sourceFileNode.contentType?.startsWith("text/markdown" satisfies files_ContentType)) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}
		if (files_node_has_editable_yjs_state(sourceFileNode)) {
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
			});
			return null;
		}
		if (!sourceAsset.r2Key) {
			const errorMessage = "sourceAsset.r2Key is not set";
			const errorData = {
				sourceAssetId: sourceAsset._id,
			};
			console.error(errorMessage, errorData);
			throw should_never_happen(errorMessage, errorData);
		}

		const response = await r2_fetch_object_from_bucket({ key: sourceAsset.r2Key });
		const markdownContent = await response.text();
		if (markdownContent.length > files_MAX_MARKDOWN_CHARACTERS) {
			// Treat over-limit Markdown uploads as processed stored files; retrying cannot make the content smaller.
			await ctx.runMutation(internal.r2.patch_asset, {
				assetId: sourceAsset._id,
				conversionWorkId: null,
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

		// Promote Markdown uploads into normal Markdown-owned assets; downstream reads should not distinguish upload vs app-created files.
		const [markdownAssetId, yjsSnapshotAssetId, versionSnapshotAssetId] = (await Promise.all([
			ctx.runMutation(internal.r2.insert_asset, {
				workspaceId: sourceFileNode.workspaceId,
				projectId: sourceFileNode.projectId,
				kind: "content",
				size: files_get_utf8_byte_size(markdownContent),
				createdBy: sourceFileNode.createdBy,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				workspaceId: sourceFileNode.workspaceId,
				projectId: sourceFileNode.projectId,
				kind: "yjs_snapshot",
				size: snapshotUpdate._yay.byteLength,
				createdBy: sourceFileNode.createdBy,
			}),
			ctx.runMutation(internal.r2.insert_asset, {
				workspaceId: sourceFileNode.workspaceId,
				projectId: sourceFileNode.projectId,
				kind: "content_snapshot",
				size: files_get_utf8_byte_size(markdownContent),
				createdBy: sourceFileNode.createdBy,
			}),
		])) as [Id<"files_r2_assets">, Id<"files_r2_assets">, Id<"files_r2_assets">];

		const markdownR2Key = r2_create_asset_key({
			workspaceId: sourceFileNode.workspaceId,
			projectId: sourceFileNode.projectId,
			assetId: markdownAssetId,
		});
		const yjsSnapshotR2Key = r2_create_asset_key({
			workspaceId: sourceFileNode.workspaceId,
			projectId: sourceFileNode.projectId,
			assetId: yjsSnapshotAssetId,
		});
		const versionSnapshotR2Key = r2_create_asset_key({
			workspaceId: sourceFileNode.workspaceId,
			projectId: sourceFileNode.projectId,
			assetId: versionSnapshotAssetId,
		});

		await Promise.all([
			r2_put_object(ctx, {
				key: markdownR2Key,
				body: markdownContent,
				contentType: sourceFileNode.contentType,
			}),
			r2_put_object(ctx, {
				key: yjsSnapshotR2Key,
				body: snapshotUpdate._yay,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: markdownContent,
				contentType: sourceFileNode.contentType,
			}),
		]);

		const finalized = (await ctx.runMutation(internal.r2.finalize_markdown_file_node_from_r2_assets, {
			workspaceId: sourceFileNode.workspaceId,
			projectId: sourceFileNode.projectId,
			fileNodeId: sourceFileNode._id,
			userId: sourceFileNode.createdBy,
			markdownAssetId,
			markdownSize: files_get_utf8_byte_size(markdownContent),
			yjsSnapshotAssetId,
			yjsSnapshotSize: snapshotUpdate._yay.byteLength,
			versionSnapshotAssetId,
			versionSnapshotSize: files_get_utf8_byte_size(markdownContent),
			markdownContent,
			conversionWorkAssetIds: [sourceAsset._id],
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

		const sourceFileNode = await ctx.db
			.query("files_nodes")
			.withIndex("by_workspace_project_asset", (q) =>
				q.eq("workspaceId", asset.workspaceId).eq("projectId", asset.projectId).eq("assetId", asset._id),
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

		const shouldStartProcessing = asset.conversionWorkId === undefined;
		if (!shouldStartProcessing) {
			return Result({ _yay: null });
		}
		if (
			!sourceFileNode ||
			sourceFileNode.archiveOperationId !== undefined ||
			files_node_has_editable_yjs_state(sourceFileNode)
		) {
			await ctx.db.patch("files_r2_assets", asset._id, {
				conversionWorkId: null,
				updatedAt: now,
			});
			return Result({ _yay: null });
		}

		const sourceFileNodeIsMarkdown =
			sourceFileNode.contentType?.startsWith("text/markdown" satisfies files_ContentType) ?? false;
		const sourceFileNodeIsPdf = sourceFileNode.contentType?.startsWith("application/pdf") ?? false;
		if (!sourceFileNodeIsMarkdown && !sourceFileNodeIsPdf) {
			await ctx.db.patch("files_r2_assets", asset._id, {
				conversionWorkId: null,
				updatedAt: now,
			});
			return Result({ _yay: null });
		}

		try {
			if (sourceFileNodeIsMarkdown) {
				const workId = await upload_conversion_workpool.enqueueAction(
					ctx,
					internal.r2.finalize_uploaded_markdown_file,
					{
						workspaceId: asset.workspaceId,
						projectId: asset.projectId,
						sourceAssetId: asset._id,
					},
				);

				await ctx.db.patch("files_r2_assets", asset._id, {
					conversionWorkId: workId,
					updatedAt: now,
				});
				return Result({ _yay: null });
			}

			const convertedMarkdownOutput = await create_generated_markdown_output_node(ctx, {
				sourceFileNode,
				name: generated_markdown_file_node_name(sourceFileNode.name),
				now,
			});
			if (convertedMarkdownOutput._nay) {
				throw convex_error({
					message: "Failed to create generated Markdown output",
					cause: convertedMarkdownOutput._nay,
				});
			}

			// Mark both the source upload and generated placeholder with the same
			// job id so either screen can show processing.
			const workId = await upload_conversion_workpool.enqueueAction(ctx, internal.r2.convert_upload_to_markdown, {
				workspaceId: asset.workspaceId,
				projectId: asset.projectId,
				sourceAssetId: asset._id,
				outputAssetId: convertedMarkdownOutput._yay.assetId,
			});

			await Promise.all([
				ctx.db.patch("files_r2_assets", asset._id, {
					conversionWorkId: workId,
					updatedAt: now,
				}),
				ctx.db.patch("files_r2_assets", convertedMarkdownOutput._yay.assetId, {
					conversionWorkId: workId,
					updatedAt: now,
				}),
			]);
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

// Vitest sets NODE_ENV to "test"; Convex's bundler defines it as "production",
// so keep that check first to let esbuild erase `import.meta.vitest` before analysis.
if (process.env.NODE_ENV === "test" && import.meta.vitest) {
	const { describe, expect, test } = import.meta.vitest;

	describe("generated_markdown_file_node_name", () => {
		test("appends .md to the full source name without parsing extensions", () => {
			expect(generated_markdown_file_node_name("report.pdf")).toBe("report.pdf.md");
			expect(generated_markdown_file_node_name("report.final.v2.pdf")).toBe("report.final.v2.pdf.md");
			expect(generated_markdown_file_node_name("README")).toBe("README.md");
		});
	});
}
