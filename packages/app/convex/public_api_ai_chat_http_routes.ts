import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type {
	public_api_ai_chat_http_transcript_Body,
	public_api_ai_chat_http_read_output_Body,
} from "./public_api_ai_chat.ts";

export function public_api_ai_chat_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/v1/ai-chat/threads/transcript" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_ai_chat_http_transcript_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_ai_chat_http_transcript } = await import("./public_api_ai_chat.ts");
								const result = await public_api_ai_chat_http_transcript({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_ai_chat.ts").public_api_ai_chat_http_transcript
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/v1/ai-chat/threads/tool-output/read" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = Record<string, string>;
						type Body = public_api_ai_chat_http_read_output_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { public_api_ai_chat_http_read_output } = await import("./public_api_ai_chat.ts");
								const result = await public_api_ai_chat_http_read_output({ ctx, request, path });
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./public_api_ai_chat.ts").public_api_ai_chat_http_read_output
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
