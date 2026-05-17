import { type RegisteredMutation } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "./_generated/api.js";
import { internalAction, internalMutation } from "./_generated/server.js";
import { files_MAX_UPLOADS_BYTES } from "../server/files.ts";
import { json_parse_and_validate } from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { should_never_happen } from "../shared/shared-utils.ts";
import { files_nodes_db_create_node_recursively_at_path, type files_nodes_get_Result } from "./files_nodes.ts";
import { r2_get_download_url, type r2_update_upload_conversion_state_Result } from "./r2.ts";

/** 15 minutes */
const signed_url_expires_seconds = 15 * 60;
const max_markdown_characters = 900_000;
const converter_response_schema = z.object({
	markdown: z.string(),
	converter: z.string(),
});

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

async function convert_object_to_markdown(args: { key: string; filename: string; contentType?: string }) {
	const sourceUrl = await r2_get_download_url({
		key: args.key,
		options: {
			expiresIn: signed_url_expires_seconds,
		},
	});

	let response: Response;
	try {
		response = await fetch(MODAL_FILE_CONVERTER_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${MODAL_TOKEN}`,
			},
			body: JSON.stringify({
				sourceUrl,
				filename: args.filename,
				contentType: args.contentType,
				maxBytes: files_MAX_UPLOADS_BYTES,
				maxMarkdownCharacters: max_markdown_characters,
			}),
		});
	} catch (error) {
		console.error("Failed to call Modal file converter", { error, key: args.key });
		return Result({ _nay: { message: "Failed to call Modal file converter" } });
	}

	const responseBody = await response.text();
	if (!response.ok) {
		console.error("Modal file converter returned an error", {
			status: response.status,
			body: responseBody.slice(0, 1_000),
			key: args.key,
		});
		return Result({ _nay: { message: "Modal file converter failed" } });
	}

	const parsedPayload = json_parse_and_validate(responseBody, converter_response_schema);
	if (parsedPayload._nay) {
		console.error("Modal file converter returned an invalid payload", {
			error: parsedPayload._nay,
			key: args.key,
		});
		return Result({ _nay: { message: "Modal file converter returned an invalid payload" } });
	}
	if (parsedPayload._yay.markdown.length > max_markdown_characters) {
		return Result({ _nay: { message: "Converted markdown is too large" } });
	}

	return Result({
		_yay: {
			markdown: parsedPayload._yay.markdown,
			converter: parsedPayload._yay.converter,
		},
	});
}

export const finalize_upload_conversion_to_markdown = internalMutation({
	args: {
		uploadId: v.id("files_uploads"),
		markdown: v.string(),
		converter: v.string(),
	},
	returns: v_result({
		_yay: v.object({
			assetId: v.id("files_r2_assets"),
			sourceNodeId: v.id("files_nodes"),
			shadowNodeId: v.id("files_nodes"),
		}),
	}),
	handler: async (ctx, args) => {
		const upload = await ctx.db.get("files_uploads", args.uploadId);
		if (!upload) {
			throw should_never_happen("R2 upload doc not found during Markdown finalization", {
				uploadId: args.uploadId,
			});
		}

		const sourceFileNode = await ctx.db.get("files_nodes", upload.sourceNodeId);
		if (!sourceFileNode) {
			throw should_never_happen("R2 upload source file node not found during Markdown finalization", {
				uploadId: args.uploadId,
				sourceNodeId: upload.sourceNodeId,
			});
		}

		// Keep queue-driven finalization idempotent because R2 events are delivered at least once.
		const existingAsset = sourceFileNode.assetId ? await ctx.db.get("files_r2_assets", sourceFileNode.assetId) : null;
		const existingShadowFileNodeId = (
			await Promise.all(
				sourceFileNode.shadowFileNodeIds.map(async (shadowFileNodeId) => {
					const shadowFileNode = await ctx.db.get("files_nodes", shadowFileNodeId);
					if (
						!shadowFileNode ||
						shadowFileNode.workspaceId !== sourceFileNode.workspaceId ||
						shadowFileNode.projectId !== sourceFileNode.projectId ||
						shadowFileNode.shadowSourceFileNodeId !== sourceFileNode._id ||
						!shadowFileNode.markdownContentId
					) {
						return null;
					}

					return shadowFileNode._id;
				}),
			)
		).find((shadowFileNodeId) => shadowFileNodeId !== null);
		if (existingAsset && existingAsset.sourceNodeId === sourceFileNode._id && existingShadowFileNodeId) {
			return Result({
				_yay: {
					assetId: existingAsset._id,
					sourceNodeId: sourceFileNode._id,
					shadowNodeId: existingShadowFileNodeId,
				},
			});
		}

		const now = Date.now();

		const shadowFileNodeName = shadow_file_node_name(sourceFileNode.name);
		if (sourceFileNode.archiveOperationId === undefined) {
			const shadowFileNodePath = `${sourceFileNode.path}.shadow.md`;
			const existingShadowFileNode = await ctx.db
				.query("files_nodes")
				.withIndex("by_workspace_project_path_archiveOperation", (q) =>
					q
						.eq("workspaceId", upload.workspaceId)
						.eq("projectId", upload.projectId)
						.eq("path", shadowFileNodePath)
						.eq("archiveOperationId", undefined),
				)
				.first();
			if (existingShadowFileNode) {
				// Supported user flows do not create shadow files;
				// archive the unexpected occupant so this conversion owns its shadow file.
				await ctx.db.patch("files_nodes", existingShadowFileNode._id, {
					archiveOperationId: crypto.randomUUID(),
					updatedBy: upload.createdBy,
					updatedAt: now,
				});
			}
		}

		const shadowFileNode = await files_nodes_db_create_node_recursively_at_path(ctx, {
			workspaceId: upload.workspaceId,
			projectId: upload.projectId,
			userId: upload.createdBy,
			parentId: sourceFileNode.parentId,
			path: shadowFileNodeName,
			kind: "file",
			createMarkdownContent: true,
			archiveOperationId: sourceFileNode.archiveOperationId,
			shadowSourceFileNodeId: sourceFileNode._id,
			markdownContent: args.markdown,
			now,
		});
		if (shadowFileNode._nay) {
			return Result({ _nay: shadowFileNode._nay });
		}

		const assetId =
			existingAsset && existingAsset.sourceNodeId === sourceFileNode._id
				? existingAsset._id
				: await ctx.db.insert("files_r2_assets", {
						workspaceId: upload.workspaceId,
						projectId: upload.projectId,
						r2Bucket: upload.r2Bucket,
						r2Key: upload.r2Key,
						filename: upload.filename,
						...(upload.contentType ? { contentType: upload.contentType } : {}),
						...(upload.size === undefined ? {} : { size: upload.size }),
						sourceNodeId: sourceFileNode._id,
						createdBy: upload.createdBy,
						createdAt: now,
						updatedAt: now,
					});
		if (existingAsset && existingAsset.sourceNodeId === sourceFileNode._id) {
			await ctx.db.patch("files_r2_assets", existingAsset._id, {
				updatedAt: now,
			});
		}

		await Promise.all([
			ctx.db.patch("files_nodes", sourceFileNode._id, {
				assetId,
				shadowFileNodeIds: [...sourceFileNode.shadowFileNodeIds, shadowFileNode._yay],
			}),
			ctx.db.patch("files_uploads", upload._id, {
				conversionWorkId: undefined,
				failureMessage: undefined,
			}),
		]);

		return Result({
			_yay: {
				assetId,
				sourceNodeId: sourceFileNode._id,
				shadowNodeId: shadowFileNode._yay,
			},
		});
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
		uploadId: v.id("files_uploads"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const upload = (await ctx.runMutation(internal.r2.update_upload_conversion_state, {
			uploadId: args.uploadId,
			failureMessage: null,
		})) as r2_update_upload_conversion_state_Result;
		if (!upload) {
			return null;
		}

		const sourceFileNode = (await ctx.runQuery(internal.files_nodes.get, {
			nodeId: upload.sourceNodeId,
		})) as files_nodes_get_Result;
		if (!sourceFileNode) {
			return null;
		}

		const conversion = await convert_object_to_markdown({
			key: upload.r2Key,
			filename: sourceFileNode.name,
			contentType: upload.contentType,
		});
		if (conversion._nay) {
			await ctx.runMutation(internal.r2.update_upload_conversion_state, {
				uploadId: args.uploadId,
				failureMessage: conversion._nay.message,
			});
			throw convex_error({
				message: "Failed to convert uploaded file",
				cause: conversion._nay,
			});
		}

		const finalizationResult = (await ctx.runMutation(internal.files_content.finalize_upload_conversion_to_markdown, {
			uploadId: args.uploadId,
			markdown: conversion._yay.markdown,
			converter: conversion._yay.converter,
		})) as finalize_upload_conversion_to_markdown_Result;
		if (finalizationResult._nay) {
			await ctx.runMutation(internal.r2.update_upload_conversion_state, {
				uploadId: args.uploadId,
				failureMessage: finalizationResult._nay.message,
			});
			throw convex_error({
				message: "Failed to finalize uploaded file",
				cause: finalizationResult._nay,
			});
		}

		return null;
	},
});
