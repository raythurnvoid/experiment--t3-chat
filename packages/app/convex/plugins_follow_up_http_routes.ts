// Keep route registration static. Load runtime code only when this route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type { plugins_follow_up_http_Body } from "./plugins_follow_up_http.ts";

export function plugins_follow_up_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/v1/plugin-runs/follow-up" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = plugins_follow_up_http_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_follow_up_http } = await import("./plugins_follow_up_http.ts");
								const result = await plugins_follow_up_http(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});
						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_follow_up_http.ts").plugins_follow_up_http
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
