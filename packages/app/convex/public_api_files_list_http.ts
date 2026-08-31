import { httpAction, type ActionCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import { z } from "zod";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type { public_api_Scope } from "../shared/public-api.ts";
import {
	public_api_authorize_request,
	public_api_is_path_inside_prefix,
	public_api_visibility_user_id,
} from "./public_api_http_auth.ts";
import { server_path_normalize, server_request_json_parse_and_validate } from "../server/server-utils.ts";
import type { r2_get_assets_ready_states_Result } from "./r2.ts";

const FILES_LIST_MAX_ITEMS = 100;
// Public clients may scan more source docs than AI tools. The internal query still owns the hard cap.
const FILES_LIST_DEFAULT_SCAN_LIMIT = 10_000;

function normalize_extension(extension: string | undefined) {
	const normalized = extension?.trim().replace(/^\./u, "").toLowerCase();
	return normalized ? normalized : undefined;
}

export function public_api_files_list_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/v1/files/list" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						const bodyValidator = z.object({
							path: z.string().optional(),
							cursor: z.string().nullable().optional(),
							limit: z.number().int().min(1).optional(),
							scanLimit: z.number().int().min(1).optional(),
							recursive: z.boolean().optional(),
							kind: z.enum(["file", "folder"]).optional(),
							extension: z.string().optional(),
							contentTypePrefixes: z.array(z.string().min(1)).min(1).max(8).optional(),
						});

						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = z.infer<typeof bodyValidator>;

						const handler = async (ctx: ActionCtx, request: Request) => {
							const auth = await public_api_authorize_request(ctx, request, {
								requiredScope: "files:list" satisfies public_api_Scope,
								allowedKinds: ["user_api_key", "public_api_grant", "plugin_ui", "plugin_run"],
								route: path,
							});
							if (auth._nay) {
								return auth._nay;
							}
							const principal = auth._yay.principal;

							const body = await server_request_json_parse_and_validate(request, bodyValidator);
							if (body._nay) {
								return { status: 400, body: { message: body._nay.message } } as const;
							}

							const requestedPath = server_path_normalize(body._yay.path ?? "/");
							if (!public_api_is_path_inside_prefix(requestedPath, principal.pathPrefix)) {
								return { status: 403, body: { message: "Permission denied" } } as const;
							}

							const lowercaseExtension = normalize_extension(body._yay.extension);
							const numItems = Math.min(body._yay.limit ?? FILES_LIST_MAX_ITEMS, FILES_LIST_MAX_ITEMS);
							const result = await ctx.runQuery(internal.files_nodes.list_subtree, {
								organizationId: principal.organizationId,
								workspaceId: principal.workspaceId,
								visibilityUserId: public_api_visibility_user_id(principal),
								folderPath: requestedPath,
								numItems,
								cursor: body._yay.cursor ?? null,
								kind: body._yay.kind,
								lowercaseExtension,
								contentTypePrefixes: body._yay.contentTypePrefixes,
								minDepth: 1,
								maxDepth: body._yay.recursive ? undefined : 1,
								maximumRowsRead: body._yay.scanLimit ?? FILES_LIST_DEFAULT_SCAN_LIMIT,
							});

							// Keep readiness separate so finalization patches do not invalidate the node-list cache entry.
							const pageAssetIds = result.page.flatMap((item) =>
								item.kind === "file" && item.assetId ? [item.assetId] : [],
							);
							const assetStates: r2_get_assets_ready_states_Result =
								pageAssetIds.length > 0
									? await ctx.runQuery(internal.r2.get_assets_ready_states, { assetIds: pageAssetIds })
									: {};

							console.info("Public API files listed", {
								principalKind: principal.kind,
								principalKey: principal.principalKey,
								count: result.page.length,
								isDone: result.isDone,
							});

							return {
								status: 200,
								body: {
									items: result.page.map((item) => {
										const assetState = item.assetId ? assetStates[item.assetId] : undefined;
										return {
											path: item.path,
											name: item.name,
											kind: item.kind,
											nodeId: item._id,
											contentType: item.contentType ?? null,
											updatedAt: item.updatedAt,
											// A file stays pending until its R2 object is confirmed. Files without an
											// asset doc have nothing pending, so they are ready.
											status:
												item.kind === "file"
													? assetState && !assetState.ready
														? ("pending" as const)
														: ("ready" as const)
													: null,
											size: assetState ? assetState.size : null,
										};
									}),
									cursor: result.continueCursor,
									isDone: result.isDone,
								},
								headers: { "Cache-Control": "no-store" },
							} as const;
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
