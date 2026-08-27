// Keep route registration static. Load the plugin asset implementation only when this route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type { plugins_ui_http_session_jwt_Body } from "./plugins_ui.ts";

export function plugins_ui_http_routes(router: { route: HttpRouter["route"] }) {
	const pathPrefix = "/plugins-ui/" as const;

	router.route({
		pathPrefix,
		method: "GET",
		handler: httpAction(async (ctx, request) => {
			const { plugins_ui_http_handle_request } = await import("./plugins_ui.ts");
			return await plugins_ui_http_handle_request(ctx, request, pathPrefix);
		}),
	});

	return {
		...((/* iife */ path = "/plugins-ui/session-jwt" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = plugins_ui_http_session_jwt_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_ui_http_session_jwt } = await import("./plugins_ui.ts");
								const result = await plugins_ui_http_session_jwt(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_ui.ts").plugins_ui_http_session_jwt
							>;
						};
					})(),
				}))(),
				...((/* iife */ method = "OPTIONS" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;

						router.route({
							path,
							method,
							handler: httpAction(async (_ctx, request) => {
								const { plugins_ui_http_session_jwt_preflight } = await import("./plugins_ui.ts");
								return plugins_ui_http_session_jwt_preflight(request);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: null;
							response: {
								204: { headers: Record<string, string>; body: null };
								404: { headers: Record<string, string>; body: null };
							};
						};
					})(),
				}))(),
			},
		}))(),
	};
}
