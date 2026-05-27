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
	files_nodes_db_finalize_markdown_node_creation,
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

function shadow_file_node_name(filename: string) {
	return `${filename}.shadow.md`;
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

/**
 * Finish an upload conversion after the converted R2 objects are written.
 *
 * Create the shadow Markdown node, mark its R2 assets available, link it to the
 * uploaded node, and clear the conversion job in one mutation.
 */
export const finalize_upload_conversion_to_markdown = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		userId: v.id("users"),
		fileNodeId: v.id("files_nodes"),
		uploadAssetId: v.id("files_r2_assets"),
		name: v.string(),
		markdownContent: v.string(),
		markdownAssetId: v.id("files_r2_assets"),
		markdownSize: v.number(),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		yjsSnapshotSize: v.number(),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		versionSnapshotSize: v.number(),
	},
	returns: v_result({ _yay: v.object({ fileNodeId: v.id("files_nodes") }) }),
	handler: async (ctx, args) => {
		// Load the uploaded file node that owns this conversion.
		const fileNode = (await ctx.db.get("files_nodes", args.fileNodeId))!;

		// Archive an active shadow-path occupant before creating the conversion result.
		if (fileNode.archiveOperationId === undefined) {
			const shadowFileNode = await ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_path_archiveOperation", (q) =>
					q
						.eq("workspaceId", fileNode.workspaceId)
						.eq("projectId", fileNode.projectId)
						.eq("path", `${fileNode.path}.shadow.md`)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (shadowFileNode) {
				// Supported user flows do not create shadow files; archive the unexpected occupant so conversion owns the shadow path.
				await ctx.db.patch("files_nodes", shadowFileNode._id, {
					archiveOperationId: crypto.randomUUID(),
					updatedBy: fileNode.createdBy,
					updatedAt: Date.now(),
				});
			}
		}

		// Create the shadow Markdown node from the converted content.
		const created = await files_nodes_db_create_node_recursively_at_path(ctx, {
			userId: args.userId,
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			parentId: fileNode.parentId,
			path: args.name,
			kind: "file",
			contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			assetId: args.markdownAssetId,
			yjsSnapshotAssetId: args.yjsSnapshotAssetId,
			archiveOperationId: fileNode.archiveOperationId,
			shadowSourceFileNodeId: fileNode._id,
			markdownContent: args.markdownContent,
			now: Date.now(),
		});
		if (created._nay) {
			return created;
		}

		// Mark the converted R2 objects as available and create the content snapshot row.
		await files_nodes_db_finalize_markdown_node_creation(ctx, {
			workspaceId: args.workspaceId,
			projectId: args.projectId,
			nodeId: created._yay,
			userId: args.userId,
			markdownAssetId: args.markdownAssetId,
			markdownSize: args.markdownSize,
			yjsSnapshotAssetId: args.yjsSnapshotAssetId,
			yjsSnapshotSize: args.yjsSnapshotSize,
			versionSnapshotAssetId: args.versionSnapshotAssetId,
			versionSnapshotSize: args.versionSnapshotSize,
		});

		// Link the shadow node back to the upload and clear the conversion job.
		await Promise.all([
			ctx.db.patch("files_nodes", fileNode._id, {
				shadowFileNodeIds: fileNode.shadowFileNodeIds.includes(created._yay)
					? fileNode.shadowFileNodeIds
					: [...fileNode.shadowFileNodeIds, created._yay],
			}),
			ctx.db.patch("files_r2_assets", args.uploadAssetId, {
				conversionWorkId: null,
				updatedAt: Date.now(),
			}),
		]);

		return Result({ _yay: { fileNodeId: created._yay } });
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
		if (sourceFileNode.shadowFileNodeIds.length > 0) {
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
				// Modal reached a deterministic no-Markdown outcome; leave the upload as a stored file.
				await ctx.runMutation(internal.r2.patch_asset, {
					assetId: sourceAsset._id,
					conversionWorkId: null,
				});
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

		const markdownContent = conversionPayload._yay.markdown;
		const snapshotUpdate = files_nodes_create_yjs_snapshot_update_from_markdown(markdownContent);
		if (snapshotUpdate._nay) {
			throw convex_error({
				message: "Failed to create uploaded file conversion snapshot",
				cause: snapshotUpdate._nay,
			});
		}

		const [markdownAssetId, yjsSnapshotAssetId, versionSnapshotAssetId] = await Promise.all([
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

		await Promise.all([
			r2_put_object(ctx, {
				key: markdownR2Key,
				body: markdownContent,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: yjsSnapshotR2Key,
				body: snapshotUpdate._yay,
				contentType: "application/octet-stream" satisfies files_ContentType,
			}),
			r2_put_object(ctx, {
				key: versionSnapshotR2Key,
				body: markdownContent,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
			}),
		]);

		const shadowFileName = shadow_file_node_name(sourceFileNode.name);
		const finalizedConversion = (await ctx.runMutation(internal.r2.finalize_upload_conversion_to_markdown, {
			workspaceId: sourceFileNode.workspaceId,
			projectId: sourceFileNode.projectId,
			userId: sourceFileNode.createdBy,
			fileNodeId: sourceFileNode._id,
			uploadAssetId: sourceAsset._id,
			name: shadowFileName,
			markdownContent,
			markdownAssetId,
			markdownSize: files_get_utf8_byte_size(markdownContent),
			yjsSnapshotAssetId,
			yjsSnapshotSize: snapshotUpdate._yay.byteLength,
			versionSnapshotAssetId,
			versionSnapshotSize: files_get_utf8_byte_size(markdownContent),
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

export const finalize_uploaded_markdown_files = internalMutation({
	args: {
		workspaceId: v.string(),
		projectId: v.string(),
		fileNodeId: v.id("files_nodes"),
		userId: v.id("users"),
		sourceAssetId: v.id("files_r2_assets"),
		markdownAssetId: v.id("files_r2_assets"),
		markdownSize: v.number(),
		yjsSnapshotAssetId: v.id("files_r2_assets"),
		yjsSnapshotSize: v.number(),
		versionSnapshotAssetId: v.id("files_r2_assets"),
		versionSnapshotSize: v.number(),
		markdownContent: v.string(),
	},
	returns: v_result({ _yay: v.null() }),
	handler: async (ctx, args) => {
		const now = Date.now();
		const [yjsSnapshotId, yjsLastSequenceId] = await Promise.all([
			ctx.db.insert("files_yjs_snapshots", {
				workspaceId: args.workspaceId,
				projectId: args.projectId,
				nodeId: args.fileNodeId,
				sequence: 0,
				assetId: args.yjsSnapshotAssetId,
				createdBy: args.userId,
				updatedBy: args.userId,
				updatedAt: now,
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
						message: "Failed to chunk uploaded Markdown file",
						cause: chunks._nay,
					});
				}
				return chunks;
			}),
		] as const).catch((error) => {
			const errorMessage = "Failed to finalize uploaded Markdown file";
			console.error(errorMessage, {
				error,
				fileNodeId: args.fileNodeId,
				sourceAssetId: args.sourceAssetId,
			});
			throw convex_error({
				message: errorMessage,
				cause: error,
			});
		});

		await Promise.all([
			ctx.db.patch("files_nodes", args.fileNodeId, {
				assetId: args.markdownAssetId,
				contentType: "text/markdown;charset=utf-8" satisfies files_ContentType,
				yjsSnapshotId,
				yjsLastSequenceId,
				updatedAt: now,
			}),
			ctx.db.patch("files_r2_assets", args.sourceAssetId, {
				conversionWorkId: null,
				updatedAt: now,
			}),
			ctx.db.patch("files_r2_assets", args.markdownAssetId, {
				r2Key: r2_create_asset_key({
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					assetId: args.markdownAssetId,
				}),
				size: args.markdownSize,
				updatedAt: now,
			}),
			ctx.db.patch("files_r2_assets", args.yjsSnapshotAssetId, {
				r2Key: r2_create_asset_key({
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					assetId: args.yjsSnapshotAssetId,
				}),
				size: args.yjsSnapshotSize,
				updatedAt: now,
			}),
			ctx.db.patch("files_r2_assets", args.versionSnapshotAssetId, {
				r2Key: r2_create_asset_key({
					workspaceId: args.workspaceId,
					projectId: args.projectId,
					assetId: args.versionSnapshotAssetId,
				}),
				size: args.versionSnapshotSize,
				updatedAt: now,
			}),
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
	},
});

type finalize_uploaded_markdown_files_Result =
	typeof finalize_uploaded_markdown_files extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

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

		const finalized = (await ctx.runMutation(internal.r2.finalize_uploaded_markdown_files, {
			workspaceId: sourceFileNode.workspaceId,
			projectId: sourceFileNode.projectId,
			fileNodeId: sourceFileNode._id,
			userId: sourceFileNode.createdBy,
			sourceAssetId: sourceAsset._id,
			markdownAssetId,
			markdownSize: files_get_utf8_byte_size(markdownContent),
			yjsSnapshotAssetId,
			yjsSnapshotSize: snapshotUpdate._yay.byteLength,
			versionSnapshotAssetId,
			versionSnapshotSize: files_get_utf8_byte_size(markdownContent),
			markdownContent,
		})) as finalize_uploaded_markdown_files_Result;
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
			sourceFileNode.shadowFileNodeIds.length > 0 ||
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
		try {
			const workId = sourceFileNodeIsMarkdown
				? await upload_conversion_workpool.enqueueAction(ctx, internal.r2.finalize_uploaded_markdown_file, {
						workspaceId: asset.workspaceId,
						projectId: asset.projectId,
						sourceAssetId: asset._id,
					})
				: await upload_conversion_workpool.enqueueAction(ctx, internal.r2.convert_upload_to_markdown, {
						workspaceId: asset.workspaceId,
						projectId: asset.projectId,
						sourceAssetId: asset._id,
					});

			await ctx.db.patch("files_r2_assets", asset._id, {
				conversionWorkId: workId,
				updatedAt: now,
			});
			return Result({ _yay: null });
		} catch (error) {
			console.error("Failed to enqueue R2 upload processing", {
				error,
				assetId: asset._id,
			});
			return Result({ _nay: { name: "nay", message: "Failed to enqueue upload processing" } });
		}
	},
});

type process_uploaded_asset_event_Result =
	typeof process_uploaded_asset_event extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

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

								const uploadProcessing = (await ctx.runMutation(internal.r2.process_uploaded_asset_event, {
									assetId: asset._yay._id,
									r2Key: body._yay.event.object.key,
									size: body._yay.event.object.size,
									etag: body._yay.event.object.eTag,
								})) as process_uploaded_asset_event_Result;
								if (uploadProcessing._nay) {
									console.error("Failed to process uploaded asset event", {
										assetId: asset._yay._id,
										result: uploadProcessing,
									});
									return {
										status: 503,
										body: {
											message: uploadProcessing._nay.message,
										},
									} as const;
								}

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
