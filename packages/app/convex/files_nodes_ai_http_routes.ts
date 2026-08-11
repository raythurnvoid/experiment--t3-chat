// Keep route registration static. Load the heavy implementation only when its route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type { files_nodes_ai_http_contextual_prompt_Body } from "./files_nodes_ai.ts";

export function files_nodes_ai_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/files/contextual-prompt" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = files_nodes_ai_http_contextual_prompt_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { files_nodes_ai_http_contextual_prompt } = await import("./files_nodes_ai.ts");
								const result = await files_nodes_ai_http_contextual_prompt(ctx, request);

								if (result.status === 200 && "toUIMessageStreamResponse" in result.body) {
									return result.body.toUIMessageStreamResponse({
										onError: (error) => {
											console.error("AI generation error:", error);
											return error instanceof Error ? error.message : String(error);
										},
									});
								}

								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./files_nodes_ai.ts").files_nodes_ai_http_contextual_prompt
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
