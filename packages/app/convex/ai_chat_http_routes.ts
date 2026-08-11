// Keep route registration static. Load the heavy implementation only when its route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type { ai_chat_http_chat_Body, ai_chat_http_run_stream_Body } from "./ai_chat.ts";

export function ai_chat_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/chat" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = ai_chat_http_chat_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { ai_chat_http_chat_response } = await import("./ai_chat.ts");
								return await ai_chat_http_chat_response(ctx, request);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof import("./ai_chat.ts").ai_chat_http_chat>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/runs/stream" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = ai_chat_http_run_stream_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { ai_chat_http_run_stream } = await import("./ai_chat.ts");
								const result = await ai_chat_http_run_stream(ctx, request);

								if (result.status === 200) {
									return new Response(result.body, { status: result.status });
								}

								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<typeof import("./ai_chat.ts").ai_chat_http_run_stream>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
