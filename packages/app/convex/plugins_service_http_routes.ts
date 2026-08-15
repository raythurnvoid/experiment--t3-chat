// Keep route registration static. Load the heavy implementation only when its route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type {
	plugins_service_http_exchange_Body,
	plugins_service_http_renew_Body,
	plugins_service_http_seal_processing_Body,
	plugins_service_http_verify_live_Body,
} from "./plugins_service.ts";

export function plugins_service_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((
			/* iife */ path = "/api/internal/plugins/service-grants/exchange" as const satisfies api_schemas_Main_Path,
		) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = plugins_service_http_exchange_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_service_http_exchange } = await import("./plugins_service.ts");
								const result = await plugins_service_http_exchange(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_service.ts").plugins_service_http_exchange
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/internal/plugins/service-grants/renew" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = plugins_service_http_renew_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_service_http_renew } = await import("./plugins_service.ts");
								const result = await plugins_service_http_renew(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_service.ts").plugins_service_http_renew
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((
			/* iife */ path = "/api/internal/plugins/service-grants/seal-processing" as const satisfies api_schemas_Main_Path,
		) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = plugins_service_http_seal_processing_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_service_http_seal_processing } = await import("./plugins_service.ts");
								const result = await plugins_service_http_seal_processing(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_service.ts").plugins_service_http_seal_processing
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((
			/* iife */ path = "/api/internal/plugins/service-grants/verify-live" as const satisfies api_schemas_Main_Path,
		) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = plugins_service_http_verify_live_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_service_http_verify_live } = await import("./plugins_service.ts");
								const result = await plugins_service_http_verify_live(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_service.ts").plugins_service_http_verify_live
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
