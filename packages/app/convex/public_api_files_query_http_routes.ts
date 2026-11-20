// Keep route registration static. Load the heavy implementation only when its route runs.
import { public_api_http_action, type public_api_http_action_ResponseSpec } from "./public_api_http_action.ts";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { public_api_files_query_http_Body } from "./public_api_files_query.ts";

export function public_api_files_query_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/v1/files/query" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_files_query_http_Body;

						router.route({
							path,
							method,
							handler: public_api_http_action(async (ctx, request) => {
								const { public_api_files_query_http } = await import("./public_api_files_query.ts");
								const result = await public_api_files_query_http({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: public_api_http_action_ResponseSpec<
								typeof import("./public_api_files_query.ts").public_api_files_query_http
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
