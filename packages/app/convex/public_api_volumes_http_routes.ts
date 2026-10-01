// Keep route registration static. Load the heavy implementation only when its route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type {
	public_api_volumes_http_list_Body,
	public_api_volumes_http_stage_Body,
	public_api_volumes_http_write_many_Body,
	public_api_volumes_http_publish_Body,
	public_api_volumes_http_delete_Body,
} from "./public_api_volumes.ts";

export function public_api_volumes_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/v1/volumes/list" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_volumes_http_list_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_volumes_http_list } = await import("./public_api_volumes.ts");
								const result = await public_api_volumes_http_list({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_volumes.ts").public_api_volumes_http_list
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/volumes/stage" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_volumes_http_stage_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_volumes_http_stage } = await import("./public_api_volumes.ts");
								const result = await public_api_volumes_http_stage({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_volumes.ts").public_api_volumes_http_stage
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/volumes/write-many" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_volumes_http_write_many_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_volumes_http_write_many } = await import("./public_api_volumes.ts");
								const result = await public_api_volumes_http_write_many({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_volumes.ts").public_api_volumes_http_write_many
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/volumes/publish" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_volumes_http_publish_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_volumes_http_publish } = await import("./public_api_volumes.ts");
								const result = await public_api_volumes_http_publish({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_volumes.ts").public_api_volumes_http_publish
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/volumes/delete" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_volumes_http_delete_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_volumes_http_delete } = await import("./public_api_volumes.ts");
								const result = await public_api_volumes_http_delete({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_volumes.ts").public_api_volumes_http_delete
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
