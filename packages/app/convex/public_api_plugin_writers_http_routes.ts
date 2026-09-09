// Keep public writer routes small; load Files code only when a request arrives.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type {
	public_api_plugin_files_http_inspect_writer_Body,
	public_api_plugin_files_http_advance_writer_Body,
	public_api_plugin_files_http_undo_access_Body,
} from "./public_api_plugin_files.ts";

export function public_api_plugin_writers_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/v1/files/plugin-writers/inspect" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = public_api_plugin_files_http_inspect_writer_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_plugin_files_http_inspect_writer } = await import("./public_api_plugin_files.ts");
								const result = await public_api_plugin_files_http_inspect_writer(ctx, request);
								return Response.json(result.body, { ...result, headers: { "Cache-Control": "no-store" } });
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_plugin_files.ts").public_api_plugin_files_http_inspect_writer
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/plugin-writers/advance" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = public_api_plugin_files_http_advance_writer_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_plugin_files_http_advance_writer } = await import("./public_api_plugin_files.ts");
								const result = await public_api_plugin_files_http_advance_writer(ctx, request);
								return Response.json(result.body, { ...result, headers: { "Cache-Control": "no-store" } });
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_plugin_files.ts").public_api_plugin_files_http_advance_writer
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/plugin-access/undo" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = public_api_plugin_files_http_undo_access_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_plugin_files_http_undo_access } = await import("./public_api_plugin_files.ts");
								const result = await public_api_plugin_files_http_undo_access(ctx, request);
								return Response.json(result.body, { ...result, headers: { "Cache-Control": "no-store" } });
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_plugin_files.ts").public_api_plugin_files_http_undo_access
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
