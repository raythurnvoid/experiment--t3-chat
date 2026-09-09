// Keep routing static; load JWT and membership code only for these requests.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type {
	plugins_service_access_http_lease_Body,
	plugins_service_access_http_snapshot_Body,
	plugins_service_access_http_events_Body,
} from "./plugins_service_access_http.ts";

export function plugins_service_access_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/v1/plugins/identity/exchange" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Service-Authorization": string };
						type Body = plugins_service_access_http_lease_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_service_access_http_lease } = await import("./plugins_service_access_http.ts");
								const result = await plugins_service_access_http_lease(ctx, request);
								return Response.json(result.body, { ...result, headers: { "Cache-Control": "no-store" } });
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_service_access_http.ts").plugins_service_access_http_lease
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/plugins/members/list" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { "X-Bonobo-Service-Authorization": string };
						type Body = plugins_service_access_http_snapshot_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_service_access_http_snapshot } = await import("./plugins_service_access_http.ts");
								const result = await plugins_service_access_http_snapshot(ctx, request);
								return Response.json(result.body, { ...result, headers: { "Cache-Control": "no-store" } });
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_service_access_http.ts").plugins_service_access_http_snapshot
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/plugins/access/changes" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { "X-Bonobo-Service-Authorization": string };
						type Body = plugins_service_access_http_events_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_service_access_http_events } = await import("./plugins_service_access_http.ts");
								const result = await plugins_service_access_http_events(ctx, request);
								return Response.json(result.body, { ...result, headers: { "Cache-Control": "no-store" } });
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_service_access_http.ts").plugins_service_access_http_events
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
