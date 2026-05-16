import { Workpool } from "@convex-dev/workpool";
import type { RegisteredMutation, RegisteredQuery, RouteSpec } from "convex/server";
import { v } from "convex/values";
import { R2 } from "@convex-dev/r2";
import { doc } from "convex-helpers/validators";
import { z } from "zod";
import { components, internal } from "./_generated/api.js";
import {
	httpAction,
	internalMutation,
	internalQuery,
	query,
	type ActionCtx,
} from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";
import {
	server_convex_get_user_fallback_to_anonymous,
	server_request_json_parse_and_validate,
} from "../server/server-utils.ts";
import { convex_error, v_result } from "../server/convex-utils.ts";
import { Result } from "../shared/errors-as-values-utils.ts";
import { workspaces_db_get_membership } from "./workspaces.ts";
import app_convex_schema from "./schema.ts";
import type { RouterForConvexModules } from "./http.ts";
import { type api_schemas_BuildResponseSpecFromHandler, type api_schemas_Main_Path } from "../shared/api-schemas.ts";

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

const r2 = new R2(components.r2, {
	bucket: R2_BUCKET_FILES,
	endpoint: R2_ENDPOINT,
	accessKeyId: R2_ACCESS_KEY_ID,
	secretAccessKey: R2_SECRET_ACCESS_KEY,
});

const r2_upload_conversion_workpool = new Workpool(components.files_upload_conversion_workpool, {
	maxParallelism: 1,
	retryActionsByDefault: true,
	defaultRetryBehavior: {
		initialBackoffMs: 60 * 1000,
		base: 1.2,
		maxAttempts: Number.POSITIVE_INFINITY,
	} as const,
});

export async function r2_get_download_url(args: {
	key: Parameters<typeof r2.getUrl>[0];
	options?: Parameters<typeof r2.getUrl>[1];
}) {
	return await r2.getUrl(args.key, {
		...args.options,
	});
}

export function r2_create_upload_key(args: { workspaceId: string; projectId: string; nodeId: Id<"files_nodes"> }) {
	return `workspaces/${args.workspaceId}/projects/${args.projectId}/nodes/${args.nodeId}/source`;
}

export function r2_get_bucket() {
	return r2.config.bucket;
}

export async function r2_generate_upload_url(key: Parameters<typeof r2.generateUploadUrl>[0]) {
	return await r2.generateUploadUrl(key);
}

export const get_upload_by_bucket_and_key = internalQuery({
	args: {
		bucket: v.string(),
		key: v.string(),
	},
	returns: v_result({
		_yay: doc(app_convex_schema, "files_uploads"),
	}),
	handler: async (ctx, args) => {
		const upload = await ctx.db
			.query("files_uploads")
			.withIndex("by_r2Bucket_r2Key", (q) => q.eq("r2Bucket", args.bucket).eq("r2Key", args.key))
			.unique();

		if (!upload) {
			return Result({
				_nay: {
					message: "Upload doc not found",
				},
			});
		}

		return Result({ _yay: upload });
	},
});

export type r2_get_upload_by_bucket_and_key_Result =
	typeof get_upload_by_bucket_and_key extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_asset = query({
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

		const sourceNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!sourceNode ||
			sourceNode.workspaceId !== membership.workspaceId ||
			sourceNode.projectId !== membership.projectId ||
			!sourceNode.assetId
		) {
			return null;
		}

		const asset = await ctx.db.get("files_r2_assets", sourceNode.assetId);
		if (!asset || asset.sourceNodeId !== sourceNode._id) {
			return null;
		}

		return asset;
	},
});

export const get_finalized_asset_by_source_node = internalQuery({
	args: {
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(doc(app_convex_schema, "files_r2_assets"), v.null()),
	handler: async (ctx, args) => {
		const sourceNode = await ctx.db.get("files_nodes", args.nodeId);
		if (!sourceNode?.assetId) {
			return null;
		}

		const asset = await ctx.db.get("files_r2_assets", sourceNode.assetId);
		if (!asset || asset.sourceNodeId !== sourceNode._id) {
			return null;
		}

		return asset;
	},
});

type r2_get_finalized_asset_by_source_node_Result =
	typeof get_finalized_asset_by_source_node extends RegisteredQuery<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export const get_upload_by_source_node = query({
	args: {
		membershipId: v.id("workspaces_projects_users"),
		nodeId: v.id("files_nodes"),
	},
	returns: v.union(
		v.object({
			uploadId: v.id("files_uploads"),
			filename: v.string(),
			contentType: v.optional(v.string()),
			size: v.optional(v.number()),
			status: v.union(v.literal("pending"), v.literal("uploaded"), v.literal("converting"), v.literal("finalized")),
			failureMessage: v.optional(v.string()),
		}),
		v.null(),
	),
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

		const sourceNode = await ctx.db.get("files_nodes", args.nodeId);
		if (
			!sourceNode ||
			sourceNode.workspaceId !== membership.workspaceId ||
			sourceNode.projectId !== membership.projectId ||
			!sourceNode.uploadId
		) {
			return null;
		}

		const upload = await ctx.db.get("files_uploads", sourceNode.uploadId);
		if (!upload || upload.sourceNodeId !== sourceNode._id) {
			return null;
		}

		return {
			uploadId: upload._id,
			filename: upload.filename,
			contentType: upload.contentType,
			size: upload.size,
			status: upload.status,
			failureMessage: upload.failureMessage,
		};
	},
});

export const set_upload_status = internalMutation({
	args: {
		uploadId: v.id("files_uploads"),
		status: v.union(v.literal("pending"), v.literal("uploaded"), v.literal("converting"), v.literal("finalized")),
		conversionWorkId: v.optional(v.union(v.string(), v.null())),
		failureMessage: v.optional(v.union(v.string(), v.null())),
	},
	returns: v.union(doc(app_convex_schema, "files_uploads"), v.null()),
	handler: async (ctx, args) => {
		await ctx.db.patch("files_uploads", args.uploadId, {
			status: args.status,
			...(args.conversionWorkId === undefined ? {} : { conversionWorkId: args.conversionWorkId ?? undefined }),
			...(args.failureMessage === undefined ? {} : { failureMessage: args.failureMessage ?? undefined }),
		});

		return await ctx.db.get("files_uploads", args.uploadId);
	},
});

export type r2_set_upload_status_Result =
	typeof set_upload_status extends RegisteredMutation<infer _Visibility, infer _Args, infer ReturnValue>
		? Awaited<ReturnValue>
		: never;

export function r2_http_routes(router: RouterForConvexModules) {
	return {
		...((/* iife */ path = "/api/r2/event" as const satisfies api_schemas_Main_Path) => ({
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

								const upload = (await ctx.runQuery(internal.r2.get_upload_by_bucket_and_key, {
									bucket: body._yay.event.bucket,
									key: body._yay.event.object.key,
								})) as r2_get_upload_by_bucket_and_key_Result;
								if (upload._nay) {
									return {
										status: upload._nay.message === "Upload doc not found" ? 404 : 503,
										body: {
											message: upload._nay.message,
										},
									} as const;
								}

								if (upload._yay.status === "finalized") {
									const asset = (await ctx.runQuery(internal.r2.get_finalized_asset_by_source_node, {
										nodeId: upload._yay.sourceNodeId,
									})) as r2_get_finalized_asset_by_source_node_Result;
									if (!asset) {
										return {
											status: 503,
											body: {
												message: "Finalized upload asset not found",
											},
										} as const;
									}

									// Duplicate R2 events after conversion should report the completed asset, not enqueue new work.
									return {
										status: 200,
										body: {
											type: "finalized",
											assetId: asset._id,
											sourceNodeId: asset.sourceNodeId,
											shadowNodeId: asset.shadowNodeId,
										},
									} as const;
								}

								if (upload._yay.conversionWorkId) {
									// A Workpool id is the durable signal that conversion was already accepted.
									return {
										status: 202,
										body: {
											type: "in_progress",
											retryAfterMs: 30_000,
										},
									} as const;
								}

								try {
									const workId = await r2_upload_conversion_workpool.enqueueAction(
										ctx,
										internal.files_content.convert_upload_to_markdown,
										{
											uploadId: upload._yay._id,
										},
									);
									await ctx.runMutation(internal.r2.set_upload_status, {
										uploadId: upload._yay._id,
										status: "converting",
										conversionWorkId: String(workId),
										failureMessage: null,
									});
								} catch (error) {
									console.error("Failed to enqueue R2 upload conversion", {
										error,
										uploadId: upload._yay._id,
									});
									return {
										status: 503,
										body: {
											message: "Failed to enqueue upload conversion",
										},
									} as const;
								}

								return {
									status: 200,
									body: {
										type: "queued",
										uploadId: upload._yay._id,
										sourceNodeId: upload._yay.sourceNodeId,
									},
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
