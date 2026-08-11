// Keep route registration static. Load the heavy implementation only when its route runs.
import { httpAction } from "./_generated/server.js";
import type { HttpRouter, RouteSpec } from "convex/server";
import type { api_schemas_Main_Path } from "../shared/api-schemas.ts";
import type { api_schemas_BuildResponseSpecFromHandler } from "common/api-schemas.ts";
import type {
	plugins_runtime_http_claim_runner_call_Body,
	plugins_runtime_http_finish_runner_call_Body,
	plugins_runtime_http_get_secret_Body,
} from "./plugins_runtime.ts";

export function plugins_runtime_http_routes(router: { route: HttpRouter["route"] }) {
	return {
		...((
			/* iife */ path = "/api/internal/plugins/host/claim-runner-call" as const satisfies api_schemas_Main_Path,
		) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Runner-Authorization": string };
						type Body = plugins_runtime_http_claim_runner_call_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_runtime_http_claim_runner_call } = await import("./plugins_runtime.ts");
								const result = await plugins_runtime_http_claim_runner_call(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_runtime.ts").plugins_runtime_http_claim_runner_call
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((
			/* iife */ path = "/api/internal/plugins/host/finish-runner-call" as const satisfies api_schemas_Main_Path,
		) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Runner-Authorization": string };
						type Body = plugins_runtime_http_finish_runner_call_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_runtime_http_finish_runner_call } = await import("./plugins_runtime.ts");
								const result = await plugins_runtime_http_finish_runner_call(ctx, request);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_runtime.ts").plugins_runtime_http_finish_runner_call
							>;
						};
					})(),
				}))(),
			},
		}))(),
		...((/* iife */ path = "/api/internal/plugins/host/secret-get" as const satisfies api_schemas_Main_Path) => ({
			[path]: {
				...((/* iife */ method = "POST" as const satisfies RouteSpec["method"]) => ({
					[method]: ((/* iife */) => {
						type SearchParams = never;
						type PathParams = never;
						type Headers = { Authorization: string; "X-Bonobo-Runner-Authorization": string };
						type Body = plugins_runtime_http_get_secret_Body;

						router.route({
							path,
							method,
							handler: httpAction(async (ctx, request) => {
								const { plugins_runtime_http_get_secret } = await import("./plugins_runtime.ts");
								const result = await plugins_runtime_http_get_secret(ctx, request, path);
								return Response.json(result.body, result);
							}),
						});

						return {} as {
							pathParams: PathParams;
							searchParams: SearchParams;
							headers: Headers;
							body: Body;
							response: api_schemas_BuildResponseSpecFromHandler<
								typeof import("./plugins_runtime.ts").plugins_runtime_http_get_secret
							>;
						};
					})(),
				}))(),
			},
		}))(),
	};
}
