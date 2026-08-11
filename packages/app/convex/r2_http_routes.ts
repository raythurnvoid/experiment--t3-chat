// Keep route registration static. Load the heavy implementation only when its route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type { r2_http_event_Body } from "./r2.ts";

export function r2_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/r2/event" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = r2_http_event_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { r2_http_event } = await import("./r2.ts");
								const result = await r2_http_event(ctx, request);

								if (result.status === 204) {
									return new Response(null, { status: result.status });
								}

								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof import("./r2.ts").r2_http_event>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
