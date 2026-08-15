// Keep route registration static. Load the heavy implementation only when its route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type {
	public_api_service_uploads_http_archive_destination_Body,
	public_api_service_uploads_http_create_target_Body,
	public_api_service_uploads_http_delete_Body,
	public_api_service_uploads_http_finalize_Body,
	public_api_service_uploads_http_release_Body,
	public_api_service_uploads_http_remint_Body,
	public_api_service_uploads_http_reserve_Body,
} from "./public_api_service_uploads_http.ts";

export function public_api_service_uploads_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/v1/files/service-uploads/reserve" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string };
						type Body = public_api_service_uploads_http_reserve_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_service_uploads_http_reserve } = await import("./public_api_service_uploads_http.ts");
								const result = await public_api_service_uploads_http_reserve(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_service_uploads_http.ts").public_api_service_uploads_http_reserve
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/service-uploads/create-target" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string };
						type Body = public_api_service_uploads_http_create_target_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_service_uploads_http_create_target } = await import(
									"./public_api_service_uploads_http.ts"
								);
								const result = await public_api_service_uploads_http_create_target(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_service_uploads_http.ts").public_api_service_uploads_http_create_target
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/service-uploads/remint" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string };
						type Body = public_api_service_uploads_http_remint_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_service_uploads_http_remint } = await import("./public_api_service_uploads_http.ts");
								const result = await public_api_service_uploads_http_remint(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_service_uploads_http.ts").public_api_service_uploads_http_remint
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/service-uploads/finalize" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string };
						type Body = public_api_service_uploads_http_finalize_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_service_uploads_http_finalize } = await import(
									"./public_api_service_uploads_http.ts"
								);
								const result = await public_api_service_uploads_http_finalize(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_service_uploads_http.ts").public_api_service_uploads_http_finalize
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/service-uploads/release" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string };
						type Body = public_api_service_uploads_http_release_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_service_uploads_http_release } = await import("./public_api_service_uploads_http.ts");
								const result = await public_api_service_uploads_http_release(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_service_uploads_http.ts").public_api_service_uploads_http_release
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/files/service-uploads/delete" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string };
						type Body = public_api_service_uploads_http_delete_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_service_uploads_http_delete } = await import("./public_api_service_uploads_http.ts");
								const result = await public_api_service_uploads_http_delete(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_service_uploads_http.ts").public_api_service_uploads_http_delete
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((
			/* iife */ path = "/api/v1/files/service-uploads/archive-destination" as const satisfies api_schemas_Main_Path,
		) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string };
						type Body = public_api_service_uploads_http_archive_destination_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_service_uploads_http_archive_destination } = await import(
									"./public_api_service_uploads_http.ts"
								);
								const result = await public_api_service_uploads_http_archive_destination(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_service_uploads_http.ts").public_api_service_uploads_http_archive_destination
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
