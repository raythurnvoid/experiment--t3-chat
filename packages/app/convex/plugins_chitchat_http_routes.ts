// Keep routing static; load JWT and membership code only for these requests.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type {
	plugins_chitchat_http_lease_Body,
	plugins_chitchat_http_snapshot_Body,
	plugins_chitchat_http_events_Body,
} from "./plugins_chitchat_http.ts";

export function plugins_chitchat_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((/* iife */ path = "/api/internal/plugins/chitchat/lease" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const) => ({
					[method]: ((/* iife */) => {
						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_chitchat_http_lease } = await import("./plugins_chitchat_http.ts");
								const result = await plugins_chitchat_http_lease(ctx, request);
								return Response.json(result.body, result);
							}),
						});
						return {} as {
							pathParams: never;
							searchParams: never;
							headers: { Authorization: string; "X-Bonobo-Service-Authorization": string };
							body: plugins_chitchat_http_lease_Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_chitchat_http.ts").plugins_chitchat_http_lease
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/internal/plugins/chitchat/snapshot" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const) => ({
					[method]: ((/* iife */) => {
						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_chitchat_http_snapshot } = await import("./plugins_chitchat_http.ts");
								const result = await plugins_chitchat_http_snapshot(ctx, request);
								return Response.json(result.body, result);
							}),
						});
						return {} as {
							pathParams: never;
							searchParams: never;
							headers: { "X-Bonobo-Service-Authorization": string };
							body: plugins_chitchat_http_snapshot_Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_chitchat_http.ts").plugins_chitchat_http_snapshot
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/internal/plugins/chitchat/events" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const) => ({
					[method]: ((/* iife */) => {
						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_chitchat_http_events } = await import("./plugins_chitchat_http.ts");
								const result = await plugins_chitchat_http_events(ctx, request);
								return Response.json(result.body, result);
							}),
						});
						return {} as {
							pathParams: never;
							searchParams: never;
							headers: { "X-Bonobo-Service-Authorization": string };
							body: plugins_chitchat_http_events_Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_chitchat_http.ts").plugins_chitchat_http_events
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
