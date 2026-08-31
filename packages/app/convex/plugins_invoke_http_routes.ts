// Keep route registration static. Load the heavy implementation only when its route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type { plugins_invoke_http_invoke_Body } from "./plugins_invoke.ts";

export function plugins_invoke_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/v1/plugin-backend/invoke" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = plugins_invoke_http_invoke_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_invoke_http_invoke } = await import("./plugins_invoke.ts");
								const result = await plugins_invoke_http_invoke(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_invoke.ts").plugins_invoke_http_invoke
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
