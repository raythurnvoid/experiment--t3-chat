// Keep route registration static. Load the heavy implementation only when its route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type {
	public_api_files_organize_http_delete_Body,
	public_api_files_organize_http_jobs_get_Body,
	public_api_files_organize_http_mkdir_Body,
	public_api_files_organize_http_stat_Body,
} from "./public_api_files_organize.ts";

export function public_api_files_organize_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/v1/files/stat" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_files_organize_http_stat_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_files_organize_http_stat } = await import("./public_api_files_organize.ts");
								const result = await public_api_files_organize_http_stat({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_files_organize.ts").public_api_files_organize_http_stat
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/mkdir" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_files_organize_http_mkdir_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_files_organize_http_mkdir } = await import("./public_api_files_organize.ts");
								const result = await public_api_files_organize_http_mkdir({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_files_organize.ts").public_api_files_organize_http_mkdir
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/delete" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_files_organize_http_delete_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_files_organize_http_delete } = await import("./public_api_files_organize.ts");
								const result = await public_api_files_organize_http_delete({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_files_organize.ts").public_api_files_organize_http_delete
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/jobs/get" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_files_organize_http_jobs_get_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_files_organize_http_jobs_get } = await import("./public_api_files_organize.ts");
								const result = await public_api_files_organize_http_jobs_get({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_files_organize.ts").public_api_files_organize_http_jobs_get
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
