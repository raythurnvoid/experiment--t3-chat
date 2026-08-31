// Keep route registration static. Load the heavy implementation only when its route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type {
	public_api_plugin_files_http_archive_Body,
	public_api_plugin_files_http_ensure_folder_Body,
	public_api_plugin_files_http_set_access_Body,
} from "./public_api_plugin_files.ts";

export function public_api_plugin_files_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/v1/files/plugin-folders/ensure" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_plugin_files_http_ensure_folder_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_plugin_files_http_ensure_folder } = await import("./public_api_plugin_files.ts");
								const result = await public_api_plugin_files_http_ensure_folder(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_plugin_files.ts").public_api_plugin_files_http_ensure_folder
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/plugin-archive" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_plugin_files_http_archive_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_plugin_files_http_archive } = await import("./public_api_plugin_files.ts");
								const result = await public_api_plugin_files_http_archive(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_plugin_files.ts").public_api_plugin_files_http_archive
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/plugin-access/set" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_plugin_files_http_set_access_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_plugin_files_http_set_access } = await import("./public_api_plugin_files.ts");
								const result = await public_api_plugin_files_http_set_access(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_plugin_files.ts").public_api_plugin_files_http_set_access
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
