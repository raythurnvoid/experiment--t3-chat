// Keep route registration static. Load the heavy implementation only when its route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type { users_http_create_anonymous_Body, users_http_resolve_user_Body } from "./users.ts";

export function users_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/.well-known/jwks.json" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "GET" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = never;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { users_http_get_jwks } = await import("./users.ts");
								const result = await users_http_get_jwks(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof import("./users.ts").users_http_get_jwks>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/auth/anonymous" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = users_http_create_anonymous_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { users_http_create_anonymous } = await import("./users.ts");
								const result = await users_http_create_anonymous(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./users.ts").users_http_create_anonymous
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/auth/resolve-user" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = users_http_resolve_user_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { users_http_resolve_user } = await import("./users.ts");
								const result = await users_http_resolve_user(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof import("./users.ts").users_http_resolve_user>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
