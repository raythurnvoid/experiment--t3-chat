import { R2 } from "@convex-dev/r2";
import { doc } from "convex-helpers/validators";
import { type RegisteredAction, type RegisteredMutation, type RouteSpec } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import { components, internal } from "./_generated/api.js";
import { action, httpAction, internalAction, internalMutation, query, type ActionCtx } from "./_generated/server.js";
import { files_ROOT_ID } from "../server/files.ts";
import {
	json_parse_and_validate,
	server_convex_get_user_fallback_to_anonymous,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { workspaces_db_get_membership } from "./workspaces.ts";
import app_convex_schema from "./schema.ts";
import { rate_limiter_limit_by_key } from "./rate_limiter.ts";
import { files_nodes_db_create_node_recursively_at_path } from "./files_nodes.ts";
import type {
	r2_prepare_upload_for_finalization_Result,
	r2_prepare_upload_for_r2_event_finalization_Result,
} from "./r2.ts";
import type { RouterForConvexModules } from "./http.ts";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";

/** 15 minutes */
const signed_url_expires_seconds = 15 * 60;
/** 50 MB */
const max_source_bytes = 50 * 1024 * 1024;
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

if (!process.env.CLOUDFLARE_EVENTS_SECRET) {
	throw convex_error({ message: "CLOUDFLARE_EVENTS_SECRET is not set in Convex env" });
}

const CLOUDFLARE_EVENTS_SECRET = process.env.CLOUDFLARE_EVENTS_SECRET;

const create_source_and_shadow_files_result_validator = v_result({
	_yay: v.object({
		assetId: v.id("files_r2_assets"),
		sourceNodeId: v.id("files_nodes"),
		shadowNodeId: v.id("files_nodes"),
	}),
});

const r2_event_finalization_result_validator = v_result({
	_yay: v.union(
		v.object({
			type: v.literal("ignored"),
			reason: v.string(),
		}),
		v.object({
			type: v.literal("in_progress"),
			retryAfterMs: v.number(),
		}),
		v.object({
			type: v.literal("finalized"),
			assetId: v.id("files_r2_assets"),
			sourceNodeId: v.id("files_nodes"),
			shadowNodeId: v.id("files_nodes"),
		}),
	),
	_nay: {
		data: v.object({
			retryable: v.boolean(),
		}),
	},
});

const r2_files = new R2(components.r2, {
	bucket: process.env.R2_BUCKET_FILES ?? process.env.R2_BUCKET!,
	endpoint: process.env.R2_ENDPOINT!,
	accessKeyId: process.env.R2_ACCESS_KEY_ID!,
	secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
});

function yaml_string(value: string) {
	return JSON.stringify(value);
}

function shadow_markdown(args: {
	filename: string;
	contentType?: string;
	size?: number;
	r2Bucket: string;
	r2Key: string;
	converter: string;
	markdown: string;
}) {
	const generatedAt = new Date().toISOString();

	return [
		"---",
		"shadow:",
		"  source:",
		"    kind: r2",
		`    bucket: ${yaml_string(args.r2Bucket)}`,
		`    key: ${yaml_string(args.r2Key)}`,
		`    filename: ${yaml_string(args.filename)}`,
		...(args.contentType ? [`    contentType: ${yaml_string(args.contentType)}`] : []),
		...(args.size === undefined ? [] : [`    size: ${args.size}`]),
		"  generated:",
		`    converter: ${yaml_string(args.converter)}`,
		`    at: ${yaml_string(generatedAt)}`,
		"---",
		"",
		args.markdown,
	].join("\n");
}

async function convert_object_to_markdown(args: { key: string; filename: string; contentType?: string }) {
	const sourceUrl = await r2_files.getUrl(args.key, {
		expiresIn: signed_url_expires_seconds,
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
				maxBytes: max_source_bytes,
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

export const get_asset_by_source_node = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
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

		const asset = await ctx.db
			.query("files_r2_assets")
			.withIndex("by_workspace_project_sourceNode", (q) =>
				q
					.eq("workspaceId", membership.workspaceId)
					.eq("projectId", membership.projectId)
					.eq("sourceNodeId", args.nodeId),
			)
			.first();

		return asset ?? null;
	},
});

export const create_source_and_shadow_files = internalMutation({
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
			return Result({ _nay: { message: "Not found" } });
		}
		// Keep queue-driven finalization idempotent because R2 events are delivered at least once.
		if (upload.assetId && upload.sourceNodeId && upload.shadowNodeId) {
			return Result({
				_yay: {
					assetId: upload.assetId,
					sourceNodeId: upload.sourceNodeId,
					shadowNodeId: upload.shadowNodeId,
				},
			});
		}
		if (upload.parentId === undefined) {
			return Result({ _nay: { message: "Upload parent not set" } });
		}

		const rateLimit = await rate_limiter_limit_by_key(ctx, { name: "files_tree_write", key: upload.createdBy });
		if (rateLimit) {
			return Result({ _nay: { message: rateLimit.message } });
		}

		if (upload.parentId !== files_ROOT_ID) {
			const parent = await ctx.db.get(upload.parentId);
			if (
				!parent ||
				parent.workspaceId !== upload.workspaceId ||
				parent.projectId !== upload.projectId ||
				parent.kind !== "folder" ||
				parent.archiveOperationId !== undefined
			) {
				return Result({ _nay: { message: "Parent file not found" } });
			}
		}
		const shadowFileName = `${upload.filename}.shadow.md`;
		const shadowMarkdown = shadow_markdown({
			filename: upload.filename,
			contentType: upload.contentType,
			size: upload.size,
			r2Bucket: upload.r2Bucket,
			r2Key: upload.r2Key,
			converter: args.converter,
			markdown: args.markdown,
		});

		const sourceFile = await files_nodes_db_create_node_recursively_at_path(ctx, {
			workspaceId: upload.workspaceId,
			projectId: upload.projectId,
			userId: upload.createdBy,
			parentId: upload.parentId,
			path: upload.filename,
			kind: "file",
			fileStorageKind: "r2",
		});
		if (sourceFile._nay) {
			return Result({ _nay: sourceFile._nay });
		}

		const shadowFile = await files_nodes_db_create_node_recursively_at_path(ctx, {
			workspaceId: upload.workspaceId,
			projectId: upload.projectId,
			userId: upload.createdBy,
			parentId: upload.parentId,
			path: shadowFileName,
			kind: "file",
			fileStorageKind: "markdown",
			markdownContent: shadowMarkdown,
		});
		if (shadowFile._nay) {
			return Result({ _nay: shadowFile._nay });
		}

		const now = Date.now();

		const assetId = await ctx.db.insert("files_r2_assets", {
			workspaceId: upload.workspaceId,
			projectId: upload.projectId,
			r2Bucket: upload.r2Bucket,
			r2Key: upload.r2Key,
			filename: upload.filename,
			...(upload.contentType ? { contentType: upload.contentType } : {}),
			...(upload.size === undefined ? {} : { size: upload.size }),
			sourceNodeId: sourceFile._yay,
			shadowNodeId: shadowFile._yay,
			conversionStatus: "converted",
			createdBy: upload.createdBy,
			createdAt: now,
			updatedAt: now,
		});

		await ctx.db.patch("files_uploads", upload._id, {
			assetId,
			sourceNodeId: sourceFile._yay,
			shadowNodeId: shadowFile._yay,
			finalizedAt: now,
			status: "finalized",
			failedAt: undefined,
			failureMessage: undefined,
		});

		return Result({
			_yay: {
				assetId,
				sourceNodeId: sourceFile._yay,
				shadowNodeId: shadowFile._yay,
			},
		});
	},
});

type create_source_and_shadow_files_Result =
	typeof create_source_and_shadow_files extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const finalize_upload = action({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		parentId: v.union(v.id("files_nodes"), v.literal(files_ROOT_ID)),
		uploadId: v.id("files_uploads"),
	},
	returns: create_source_and_shadow_files_result_validator,
	handler: async (ctx, args) => {
		const upload = (await ctx.runMutation(internal.r2.prepare_upload_for_finalization, {
			membershipId: args.membershipId,
			parentId: args.parentId,
			uploadId: args.uploadId,
		})) as r2_prepare_upload_for_finalization_Result;
		if (upload._nay) {
			return Result({ _nay: upload._nay });
		}
		if (upload._yay.assetId && upload._yay.sourceNodeId && upload._yay.shadowNodeId) {
			return Result({
				_yay: {
					assetId: upload._yay.assetId,
					sourceNodeId: upload._yay.sourceNodeId,
					shadowNodeId: upload._yay.shadowNodeId,
				},
			});
		}

		const conversion = await convert_object_to_markdown({
			key: upload._yay.r2Key,
			filename: upload._yay.filename,
			contentType: upload._yay.contentType,
		});
		if (conversion._nay) {
			return Result({ _nay: conversion._nay });
		}

		const created = (await ctx.runMutation(internal.files_content.create_source_and_shadow_files, {
			uploadId: args.uploadId,
			markdown: conversion._yay.markdown,
			converter: conversion._yay.converter,
		})) as create_source_and_shadow_files_Result;
		if (created._nay) {
			return Result({ _nay: created._nay });
		}

		return Result({ _yay: created._yay });
	},
});

export const finalize_upload_from_r2_event = internalAction({
	args: {
		cloudflareMessageId: v.string(),
		attempts: v.number(),
		event: v.object({
			account: v.optional(v.string()),
			action: v.string(),
			bucket: v.string(),
			object: v.object({
				key: v.string(),
				size: v.optional(v.number()),
				eTag: v.optional(v.string()),
			}),
			eventTime: v.string(),
		}),
	},
	returns: r2_event_finalization_result_validator,
	handler: async (ctx, args) => {
		const prepared = (await ctx.runMutation(internal.r2.prepare_upload_for_r2_event_finalization, {
			cloudflareMessageId: args.cloudflareMessageId,
			action: args.event.action,
			bucket: args.event.bucket,
			key: args.event.object.key,
			size: args.event.object.size,
			eTag: args.event.object.eTag,
			eventTime: args.event.eventTime,
		})) as r2_prepare_upload_for_r2_event_finalization_Result;
		if (prepared._nay) {
			return Result({
				_nay: {
					message: prepared._nay.message,
					data: {
						retryable: true,
					},
				},
			});
		}

		if (prepared._yay.type === "ignored") {
			return Result({ _yay: prepared._yay });
		}
		if (prepared._yay.type === "in_progress") {
			return Result({ _yay: prepared._yay });
		}
		if (prepared._yay.type === "already_finalized") {
			return Result({
				_yay: {
					type: "finalized",
					assetId: prepared._yay.assetId,
					sourceNodeId: prepared._yay.sourceNodeId,
					shadowNodeId: prepared._yay.shadowNodeId,
				},
			});
		}

		const upload = prepared._yay.upload;
		if (upload.parentId === undefined) {
			const message = "Legacy upload row has no parent; manual re-upload is required";
			await ctx.runMutation(internal.r2.mark_upload_finalization_failed, {
				uploadId: upload._id,
				message,
			});
			return Result({
				_nay: {
					message,
					data: {
						retryable: false,
					},
				},
			});
		}

		const conversion = await convert_object_to_markdown({
			key: upload.r2Key,
			filename: upload.filename,
			contentType: upload.contentType,
		});
		if (conversion._nay) {
			await ctx.runMutation(internal.r2.mark_upload_finalization_failed, {
				uploadId: upload._id,
				message: conversion._nay.message,
			});
			return Result({
				_nay: {
					message: conversion._nay.message,
					data: {
						retryable: true,
					},
				},
			});
		}

		const created = (await ctx.runMutation(internal.files_content.create_source_and_shadow_files, {
			uploadId: upload._id,
			markdown: conversion._yay.markdown,
			converter: conversion._yay.converter,
		})) as create_source_and_shadow_files_Result;
		if (created._nay) {
			await ctx.runMutation(internal.r2.mark_upload_finalization_failed, {
				uploadId: upload._id,
				message: created._nay.message,
			});
			return Result({
				_nay: {
					message: created._nay.message,
					data: {
						retryable: false,
					},
				},
			});
		}

		return Result({
			_yay: {
				type: "finalized",
				assetId: created._yay.assetId,
				sourceNodeId: created._yay.sourceNodeId,
				shadowNodeId: created._yay.shadowNodeId,
			},
		});
	},
});

type finalize_upload_from_r2_event_Result =
	typeof finalize_upload_from_r2_event extends RegisteredAction<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export function files_content_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path =
			"/api/files/uploads/finalize-from-r2-event" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						const bodyValidator = z.object({
							cloudflareMessageId: z.string(),
							attempts: z.number(),
							event: z.object({
								account: z.string().optional(),
								action: z.string(),
								bucket: z.string(),
								object: z.object({
									key: z.string(),
									size: z.number().optional(),
									eTag: z.string().optional(),
								}),
								eventTime: z.string(),
							}),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							try {
								// Reuse the app-level Cloudflare event secret for trusted event forwarders only.
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

								const result = (await ctx.runAction(
									internal.files_content.finalize_upload_from_r2_event,
									body._yay,
								)) as finalize_upload_from_r2_event_Result;
								if (result._nay) {
									return {
										status: result._nay.data?.retryable ? 503 : 422,
										body: {
											message: result._nay.message,
										},
									} as const;
								}

								if (result._yay.type === "in_progress") {
									return {
										status: 202,
										body: {
											type: result._yay.type,
											retryAfterMs: result._yay.retryAfterMs,
										},
									} as const;
								}

								return {
									status: 200,
									body: result._yay,
								} as const;
							} catch (error: unknown) {
								console.error("[files_content.finalize_upload_from_r2_event] HTTP route failed", { error });
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
