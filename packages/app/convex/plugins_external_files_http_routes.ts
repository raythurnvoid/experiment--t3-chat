// Keep registration light; file staging loads only when a route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";

export function plugins_external_files_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/internal/plugins/files/ensure" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = import("./plugins_external_files.ts").plugins_external_files_http_ensure_Body;
						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_external_files_http_ensure } = await import("./plugins_external_files.ts");
								const result = await plugins_external_files_http_ensure(ctx, request);
								return Response.json(result.body, result);
							}),
						});
						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_external_files.ts").plugins_external_files_http_ensure
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/internal/plugins/files/prepare" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = import("./plugins_external_files.ts").plugins_external_files_http_prepare_Body;
						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_external_files_http_prepare } = await import("./plugins_external_files.ts");
								const result = await plugins_external_files_http_prepare(ctx, request);
								return Response.json(result.body, result);
							}),
						});
						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_external_files.ts").plugins_external_files_http_prepare
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/internal/plugins/files/write" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = import("./plugins_external_files.ts").plugins_external_files_http_write_Body;
						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_external_files_http_write } = await import("./plugins_external_files.ts");
								const result = await plugins_external_files_http_write(ctx, request);
								return Response.json(result.body, result);
							}),
						});
						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_external_files.ts").plugins_external_files_http_write
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/internal/plugins/files/readers" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = import("./plugins_external_files.ts").plugins_external_files_http_readers_Body;
						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_external_files_http_readers } = await import("./plugins_external_files.ts");
								const result = await plugins_external_files_http_readers(ctx, request);
								return Response.json(result.body, result);
							}),
						});
						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_external_files.ts").plugins_external_files_http_readers
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((
			/* iife */ path = "/api/internal/plugins/files/rollback-readers" as const satisfies api_schemas_Main_Path,
		) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = import("./plugins_external_file_readers.ts").plugins_external_file_readers_http_rollback_Body;
						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_external_file_readers_http_rollback } = await import(
									"./plugins_external_file_readers.ts"
								);
								const result = await plugins_external_file_readers_http_rollback(ctx, request);
								return Response.json(result.body, result);
							}),
						});
						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_external_file_readers.ts").plugins_external_file_readers_http_rollback
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/internal/plugins/files/archive" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = import("./plugins_external_files.ts").plugins_external_files_http_archive_Body;
						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_external_files_http_archive } = await import("./plugins_external_files.ts");
								const result = await plugins_external_files_http_archive(ctx, request);
								return Response.json(result.body, result);
							}),
						});
						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_external_files.ts").plugins_external_files_http_archive
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/internal/plugins/files/fence" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = import("./plugins_external_files.ts").plugins_external_files_http_fence_Body;
						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_external_files_http_fence } = await import("./plugins_external_files.ts");
								const result = await plugins_external_files_http_fence(ctx, request);
								return Response.json(result.body, result);
							}),
						});
						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_external_files.ts").plugins_external_files_http_fence
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
